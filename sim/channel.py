#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sim/channel.py -- PSKT simulated physical channel (print + capture degradation).

WHAT THIS IS
------------
Input:  pristine page rasters as written by `pskit send` (clean RGB PNG, cream or
        white substrate, black/coloured glyph lattice, at a stated print dpi).
Output: what a real printer plus a real capture device hands back: same
        basenames, still PNG, plus a verbatim copy of `manifest.json`.

Whether the acceptance gates (G2 / G4 / G10) mean anything depends on this module,
so every stage below exists for a physical reason, not because it "looks noisy".
Each stage is independently switchable (--only / --off, or factors= in the API) so
a test can attribute a failure to one factor instead of to the whole channel.

PIPELINE (the order is the physical order)
------------------------------------------
  0  decompose      obs = sub*(1-a) + ink*a -> coverage field + ink directions
                    (the same model core/decode/ideal.js inverts)
  1  ink set        mono collapse, purge / inter-island colour bleed       [bleed]
  2  EW gain        sub-pixel shift of the ink boundary, in mm             [ew]
  3  substrate      paper tone drift + grain / PLA layer stripes + bed tex [substrate]
  4  printer MTF    Gaussian blur, sigma mm on the PRINT grid              [mtf]
  5  geometry       pose, scale, translation, corner crop, curl, desk      [geometry]
  6  capture blur   Gaussian blur, sigma mm on the CAPTURE grid            [mtf]
  7  motion blur    linear kernel, seeded angle                            [motion]
  8  illumination   EV, vignette, specular glare (clips), tone curve       [illumination]
  9  moire          log-space additive beating vs the sensor pitch         [moire]
 10  white balance  per-channel gains (2500K / 5000K / fluorescent)        [wb]
 11  sensor noise   shot (sqrt signal) + read floor, hot pixels            [noise]
 12  quantize -> JPEG in memory -> write PNG                               [jpeg]

JPEG INSIDE A PNG FILE -- READ THIS BEFORE "FIXING" IT
-----------------------------------------------------
Camera/scanner JPEG loss is applied with cv2.imencode('.jpg', q) + cv2.imdecode
**in memory**; the fixture written to disk is PNG. That is deliberate. The
zero-dependency Node reader (core/decode/png-read.js) only implements a PNG
decoder, so a JPEG fixture would simply be unreadable by the thing under test. The
JPEG *loss* is fully present in the pixels; only the container is PNG. Prove the
path ran from jpeg_quality in --report (and 8x8 DCT block edges in the pixels),
never from the file extension.

DETERMINISM
-----------
numpy.random.default_rng only -- never `random`, never time, never OS entropy.
Page i draws from SeedSequence([seed, i]), so a page's degradation depends on the
seed and on its OWN index, never on which other pages happen to be in the
directory. Same seed + same inputs + same preset => byte-identical files.

UNITS
-----
Every physically meaningful generator parameter is in **mm**, turned into pixels on
the grid of the stage that uses it: `--dpi` (print grid) for the printer-side
stages, the derived capture sampling (px per mm of the physical page) for the
camera-side ones. `--dpi` therefore does real physical work here: it says how many
device dots per inch the pristine page stands for, hence how wide a 0.06 mm laser
spot is in pixels.

For the record: the 8-bit raster is treated as *linear reflectance* (the render
contract states no gamma is applied), which is what makes the EV exposure, the
clipping highlights and the sqrt shot-noise model self-consistent. `tone_mix` then
maps that linear signal to display-referred code values, like a camera ISP does.

USAGE
-----
    python sim/channel.py --in out/myfile --out sim/run1 --seed 7 --preset scan300
    python sim/channel.py --in page-000.png --out sim/run2 --seed 7 \
                          --preset phone-hard --modifier dark --report

Exit 0 on success; non-zero with a message on stderr when the input holds no
images.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys

import cv2
import numpy as np

__all__ = [
    "FACTORS",
    "PRESETS",
    "PRESET_NAMES",
    "MODIFIERS",
    "NEUTRAL",
    "draw_params",
    "mask_factors",
    "process",
    "process_page_file",
    "rectify",
    "estimate_pitch_mm",
    "main",
]

MM_PER_IN = 25.4

# ===========================================================================
# factors and neutral values
# ===========================================================================

#: Every independently switchable stage. A test enables one at a time.
FACTORS = (
    "mtf", "ew", "substrate", "illumination", "wb", "geometry",
    "noise", "motion", "moire", "jpeg", "bleed",
)

#: Which drawn parameter belongs to which factor (for --only / --off masking).
FACTOR_OF = {
    "mtf_mm": "mtf", "defocus_mm": "mtf",
    "ew_mm": "ew",
    "paper_tone": "substrate", "paper_grain_amp": "substrate",
    "stripe_period_mm": "substrate", "stripe_amp": "substrate", "bed_texture_amp": "substrate",
    "exposure_ev": "illumination", "vignette": "illumination", "glare_amp": "illumination",
    "glare_angle_deg": "illumination", "glare_width_mm": "illumination",
    "glare_x": "illumination", "glare_y": "illumination", "tone_mix": "illumination",
    "auto_level": "illumination", "white_ref_scale": "illumination",
    "wb_source": "wb", "wb_gain": "wb",
    "rot_deg": "geometry", "yaw_deg": "geometry", "pitch_deg": "geometry",
    "fill": "geometry", "shift_x": "geometry", "shift_y": "geometry",
    "crop_frac": "geometry", "crop_dir": "geometry",
    "curl_deg": "geometry", "curl_axis": "geometry",
    "shot_sigma": "noise", "read_sigma": "noise", "hot_rate": "noise",
    "motion_px": "motion", "motion_angle_deg": "motion",
    "moire_amp": "moire", "moire_ratio": "moire", "moire_angle_deg": "moire", "moire_phase": "moire",
    "jpeg_q": "jpeg",
    "bleed_eps": "bleed", "mono": "bleed",
}

#: All-off. draw_params() starts here and lets the preset overwrite.
NEUTRAL: dict = {
    "mtf_mm": 0.0, "defocus_mm": 0.0, "ew_mm": 0.0,
    "paper_tone": (1.0, 1.0, 1.0), "paper_grain_amp": 0.0,
    "stripe_period_mm": 0.0, "stripe_amp": 0.0, "bed_texture_amp": 0.0,
    "exposure_ev": 0.0, "vignette": 0.0, "glare_amp": 0.0, "glare_angle_deg": 0.0,
    "glare_width_mm": 18.0, "glare_x": 0.5, "glare_y": 0.5, "tone_mix": 0.0,
    "auto_level": 0.0, "white_ref_scale": 1.0,

    "wb_source": "none", "wb_gain": (1.0, 1.0, 1.0),
    "rot_deg": 0.0, "yaw_deg": 0.0, "pitch_deg": 0.0, "fill": 1.0,
    "shift_x": 0.0, "shift_y": 0.0, "crop_frac": 0.0, "crop_dir": 0,
    "curl_deg": 0.0, "curl_axis": "y",
    "shot_sigma": 0.0, "read_sigma": 0.0, "hot_rate": 0.0,
    "motion_px": 0.0, "motion_angle_deg": 0.0,
    "moire_amp": 0.0, "moire_ratio": 2.0, "moire_angle_deg": 0.0, "moire_phase": 0.0,
    "jpeg_q": 0,           # 0 => no JPEG coding at all
    "bleed_eps": 0.0, "mono": False,
}


def _p(**kw):
    return kw


# ===========================================================================
# presets: per-page ranges + documented nominals
# ===========================================================================
#
# The numbers and why each range is what it are in sim/README.md.

PRESETS: dict = {
    # clean reference: proves the harness plumbing, not the physics
    "identity": _p(
        medium="none", frame="page", capture_dpi=None, desk=(0, 0, 0),
        ranges={}, nominal={},
        note="no-op pass-through: output pixels == input pixels",
    ),
    # flatbed / ADF document scanner at 300 dpi
    "scan300": _p(
        medium="paper", frame="scan", capture_dpi=300.0, desk=(9, 9, 11),
        ranges={
            "mtf_mm": (0.03, 0.09),           # laser: developed spot + fuser spread
            "defocus_mm": (0.0, 0.02),        # sheet a hair off the glass
            "ew_mm": (-0.05, 0.15),           # toner dot gain / ink bleed
            "paper_tone_drift": (0.0, 0.012),
            "paper_grain_amp": (0.0, 2.0),
            "exposure_ev": (-0.5, 0.5),
            "vignette": (0.02, 0.12),         # CIS bar falloff
            "glare_amp": (0.0, 0.08),         # paper sheen
            "tone_mix": (0.0, 0.25),          # document mode is near-linear
            "auto_level": (0.85, 1.0),        # a flatbed's AEC nails the paper white
            "white_ref_scale": (0.96, 1.02),
            "shot_sigma": (1.0, 2.5), "read_sigma": (1.0, 2.0),
            "rot_deg": (0.0, 1.5), "yaw_deg": (0.0, 0.8), "pitch_deg": (0.0, 0.8),
            "shift_x": (-0.01, 0.01), "shift_y": (-0.01, 0.01),
            "fill": (0.95, 1.0), "crop_frac": (0.0, 0.015),
            "jpeg_q": (82, 92),
            "bleed_p": (0.0, 0.10), "bleed": (0.0, 0.12),
            "wb_strength": (0.15, 0.45),
        },
        nominal={"mtf_mm": 0.06, "ew_mm": 0.03, "exposure_ev": 0.0, "jpeg_q": 88},
    ),
    # scanner at 600 dpi: where lattice-vs-sensor beating shows up
    "scan600": _p(
        medium="paper", frame="scan", capture_dpi=600.0, desk=(9, 9, 11),
        ranges={
            "mtf_mm": (0.03, 0.08), "defocus_mm": (0.0, 0.03),
            "ew_mm": (-0.05, 0.15),
            "paper_tone_drift": (0.0, 0.012), "paper_grain_amp": (0.0, 2.0),
            "exposure_ev": (-0.5, 0.5), "vignette": (0.02, 0.12),
            "glare_amp": (0.0, 0.08), "tone_mix": (0.0, 0.25),
            "auto_level": (0.85, 1.0), "white_ref_scale": (0.96, 1.02),
            "shot_sigma": (0.8, 2.2), "read_sigma": (0.8, 1.8),
            "rot_deg": (0.0, 1.2), "yaw_deg": (0.0, 0.6), "pitch_deg": (0.0, 0.6),
            "shift_x": (-0.01, 0.01), "shift_y": (-0.01, 0.01),
            "fill": (0.95, 1.0), "crop_frac": (0.0, 0.015),
            "moire_amp": (0.02, 0.10),        # the point of this preset
            "moire_ratio": (1.6, 2.5),        # sensor pitch / page lattice pitch
            "moire_angle_deg": (0.0, 90.0),
            "jpeg_q": (80, 92),
            "bleed_p": (0.0, 0.10), "bleed": (0.0, 0.12),
            "wb_strength": (0.15, 0.45),
        },
        nominal={"mtf_mm": 0.05, "ew_mm": 0.03, "moire_amp": 0.06, "moire_ratio": 2.0,
                 "jpeg_q": 86},
    ),
    # phone photo at ~40 cm, tolerable conditions
    "phone40": _p(
        medium="paper", frame=(1600, 1200), focal_ratio=0.80, desk=(58, 56, 52),
        ranges={
            "mtf_mm": (0.03, 0.08), "defocus_mm": (0.02, 0.18),
            "ew_mm": (-0.05, 0.15),
            "paper_tone_drift": (0.0, 0.02), "paper_grain_amp": (0.0, 2.5),
            "exposure_ev": (-1.5, 1.5), "vignette": (0.05, 0.25),
            "glare_amp": (0.0, 0.25), "tone_mix": (0.4, 1.0),
            "auto_level": (0.45, 0.90),       # phone AE exposes the whole scene
            "white_ref_scale": (0.90, 1.02),
            "shot_sigma": (2.0, 5.0), "read_sigma": (1.0, 3.0),
            "rot_deg": (0.0, 20.0), "yaw_deg": (0.0, 12.0), "pitch_deg": (0.0, 10.0),
            "shift_x": (-0.04, 0.04), "shift_y": (-0.04, 0.04),
            "fill": (0.72, 1.0), "crop_frac": (0.0, 0.03),
            "curl_deg": (0.0, 12.0),          # paper is never flat
            "motion_px": (0.0, 4.0), "jpeg_q": (60, 88),
            "bleed_p": (0.0, 0.15), "bleed": (0.0, 0.15),
            "wb_strength": (0.5, 1.0),
        },
        nominal={"mtf_mm": 0.05, "defocus_mm": 0.08, "rot_deg": 10.0, "fill": 0.9,
                 "jpeg_q": 78},
    ),
    # phone stress case (G4)
    "phone-hard": _p(
        medium="paper", frame=(1280, 960), focal_ratio=0.80, desk=(52, 50, 47),
        ranges={
            "mtf_mm": (0.03, 0.10), "defocus_mm": (0.10, 0.50),   # out of focus, on purpose
            "ew_mm": (-0.05, 0.15),
            "paper_tone_drift": (0.0, 0.025), "paper_grain_amp": (0.0, 3.0),
            "exposure_ev": (-1.5, 1.5), "vignette": (0.10, 0.35),
            "glare_amp": (0.0, 0.55), "tone_mix": (0.5, 1.0),
            # the AE is confused by the dark desk and the glare: it overdrives
            "auto_level": (0.25, 0.80), "white_ref_scale": (0.95, 1.12),
            "shot_sigma": (4.0, 9.0), "read_sigma": (2.0, 6.0),
            "hot_rate": (2e-6, 2e-5),         # salt-like hot pixels
            "rot_deg": (0.0, 35.0), "yaw_deg": (0.0, 25.0), "pitch_deg": (0.0, 20.0),
            "shift_x": (-0.06, 0.06), "shift_y": (-0.06, 0.06),
            "fill": (0.55, 0.95), "crop_frac": (0.0, 0.12),       # corner cut: see _place()
            "curl_deg": (0.0, 40.0),          # curled sheet: non-planar
            "motion_px": (3.0, 15.0), "jpeg_q": (45, 70),
            "bleed_p": (0.0, 0.20), "bleed": (0.0, 0.20),
            "wb_strength": (0.6, 1.2),
        },
        nominal={"mtf_mm": 0.06, "defocus_mm": 0.30, "rot_deg": 25.0, "motion_px": 9.0,
                 "jpeg_q": 55, "crop_frac": 0.08},
    ),
    # FDM plate, matte (textured PEI / glass) top skin
    "plate-matte": _p(
        medium="fdm", frame=(1600, 1200), focal_ratio=0.80, desk=(38, 38, 40),
        ranges={
            "mtf_mm": (0.15, 0.45),           # nozzle footprint + inter-line gaps
            "defocus_mm": (0.02, 0.20),
            "ew_mm": (0.0, 0.25),              # over-extrusion fattens; 0 = starved
            "stripe_period_mm": (0.20, 0.40),  # top-skin line pitch
            "stripe_amp": (0.02, 0.08), "bed_texture_amp": (0.0, 0.02),
            "exposure_ev": (-1.0, 1.0), "vignette": (0.05, 0.20),
            "glare_amp": (0.0, 0.12), "tone_mix": (0.4, 1.0),     # matte: weak, wide
            "auto_level": (0.50, 0.95), "white_ref_scale": (0.92, 1.04),
            "shot_sigma": (2.0, 5.0), "read_sigma": (1.0, 3.0),
            "rot_deg": (0.0, 15.0), "yaw_deg": (0.0, 12.0), "pitch_deg": (0.0, 10.0),
            "shift_x": (-0.04, 0.04), "shift_y": (-0.04, 0.04),
            "fill": (0.60, 1.0), "crop_frac": (0.0, 0.05),
            "curl_deg": (0.0, 6.0),            # plates do not bend; corners may lift
            "motion_px": (0.0, 5.0), "jpeg_q": (55, 85),
            "bleed_p": (0.10, 0.45), "bleed": (0.0, 0.20),  # purge leakage is a plate problem
            "wb_strength": (0.4, 1.0),
        },
        nominal={"mtf_mm": 0.28, "ew_mm": 0.06, "stripe_period_mm": 0.30, "jpeg_q": 75},
    ),
    # FDM plate on glossy PEI: the clipping-highlight case
    "plate-glossy": _p(
        medium="fdm", frame=(1600, 1200), focal_ratio=0.80, desk=(30, 30, 34),
        ranges={
            "mtf_mm": (0.12, 0.35),            # glossy skin is smoother -> sharper
            "defocus_mm": (0.02, 0.25),
            "ew_mm": (0.0, 0.25),
            "stripe_period_mm": (0.20, 0.40), "stripe_amp": (0.01, 0.05),
            "bed_texture_amp": (0.02, 0.06),   # PEI dimples show through
            "exposure_ev": (-1.0, 1.0), "vignette": (0.08, 0.30),
            "glare_amp": (0.35, 1.20), "glare_width_mm": (3.0, 14.0),  # CAN clip to 255
            "tone_mix": (0.4, 1.0),
            # specular light is the reference the AE locks onto: the rest of the
            # plate then falls *below* code 255 while the band itself blows
            "auto_level": (0.55, 1.0), "white_ref_scale": (0.90, 1.00),
            "shot_sigma": (2.0, 5.0), "read_sigma": (1.0, 3.0),
            "rot_deg": (0.0, 15.0), "yaw_deg": (0.0, 15.0), "pitch_deg": (0.0, 12.0),
            "shift_x": (-0.04, 0.04), "shift_y": (-0.04, 0.04),
            "fill": (0.60, 1.0), "crop_frac": (0.0, 0.05),
            "curl_deg": (0.0, 4.0), "motion_px": (0.0, 5.0), "jpeg_q": (55, 85),
            "bleed_p": (0.10, 0.45), "bleed": (0.0, 0.20),
            "wb_strength": (0.4, 1.0),
        },
        nominal={"mtf_mm": 0.22, "glare_amp": 0.8, "jpeg_q": 75},
    ),
}

PRESET_NAMES = tuple(PRESETS)

#: Residual colour cast *after* the camera's auto white balance (geometric mean 1).
#: A ratio decoder survives this; a fixed RGB threshold does not.
WB_SOURCES = {
    "tungsten2500K": (1.10, 1.00, 0.84),
    "daylight5000K": (1.03, 1.00, 0.97),
    "fluorescent": (0.93, 1.09, 0.90),
}

#: Named range patches applied over a preset (CLI: --modifier dark --modifier mono).
MODIFIERS = {
    "dark": {        # dim room: the -2.5..-1.0 EV the spec asks for
        "exposure_ev": (-2.5, -1.0), "shot_sigma": (5.0, 14.0), "read_sigma": (3.0, 8.0),
        "vignette": (0.10, 0.35), "glare_amp": (0.0, 0.15), "tone_mix": (0.6, 1.0),
    },
    "bright": {"exposure_ev": (0.8, 1.8), "glare_amp": (0.1, 0.6)},
    "mono": {"mono_force": (True, True)},      # single filament: colour channel dies
    "bleed": {"bleed_p": (1.0, 1.0)},         # force colour leakage on
    "nomoire": {"moire_amp": (0.0, 0.0)},
    "nocrop": {"crop_frac": (0.0, 0.0)},
    "still": {"motion_px": (0.0, 0.0)},
    "flat": {        # no pose at all: isolates photometry from geometry
        "rot_deg": (0.0, 0.0), "yaw_deg": (0.0, 0.0), "pitch_deg": (0.0, 0.0),
        "curl_deg": (0.0, 0.0), "crop_frac": (0.0, 0.0),
        "shift_x": (0.0, 0.0), "shift_y": (0.0, 0.0),
    },
    "clean": {       # mild photometry only: no lossy coding, no pose, no blur
        "jpeg_q": (0, 0), "shot_sigma": (0.0, 0.5), "read_sigma": (0.0, 0.5),
        "motion_px": (0.0, 0.0), "moire_amp": (0.0, 0.0),
        "rot_deg": (0.0, 0.0), "yaw_deg": (0.0, 0.0), "pitch_deg": (0.0, 0.0),
        "curl_deg": (0.0, 0.0), "crop_frac": (0.0, 0.0),
        "mtf_mm": (0.0, 0.0), "defocus_mm": (0.0, 0.0), "ew_mm": (0.0, 0.0),
    },
}


# ===========================================================================
# small helpers
# ===========================================================================

def _u(rng, lo, hi) -> float:
    """Uniform in [lo,hi]; hi<=lo pins the value (that is how overrides turn a
    knob off)."""
    lo, hi = float(lo), float(hi)
    if hi <= lo:
        return lo
    return float(rng.uniform(lo, hi))


def _rng_stream(seed: int, page_index: int):
    """Per-page stream: a function of the seed and *this page's* index only."""
    return np.random.default_rng(
        np.random.SeedSequence([int(seed) & 0xFFFFFFFFFFFFFFFFFF, max(0, int(page_index))]))


def _range_of(R: dict, key, default=(0.0, 0.0)):
    v = R.get(key, default)
    if isinstance(v, (tuple, list)) and len(v) == 2:
        return (float(v[0]), float(v[1]))
    return (float(v), float(v))


def _jsonable(v):
    if isinstance(v, np.ndarray):
        return [_jsonable(x) for x in v.tolist()]
    if isinstance(v, (tuple, list)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else round(f, 6)
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if v is None or isinstance(v, str):
        return v
    return str(v)


# ===========================================================================
# parameter drawing
# ===========================================================================

def draw_params(preset: str, rng, *, modifiers=(), overrides: dict | None = None) -> dict:
    """Draw one page's physical parameters from a preset's ranges.

    overrides: name -> fixed value, or (lo,hi), replacing the preset range.
    modifiers: names from MODIFIERS, patched over the preset before overrides.
    """
    if preset not in PRESETS:
        raise KeyError(f"unknown preset {preset!r} (have: {', '.join(PRESET_NAMES)})")
    spec = PRESETS[preset]
    R = dict(spec["ranges"])
    for mod in modifiers:
        if mod not in MODIFIERS:
            raise KeyError(f"unknown modifier {mod!r} (have: {', '.join(sorted(MODIFIERS))})")
        R.update(MODIFIERS[mod])
    for k, v in (overrides or {}).items():
        if k not in NEUTRAL and k not in ("bleed_p", "mono_force", "paper_tone_drift", "wb_strength"):
            raise KeyError(f"unknown parameter {k!r}")
        R[k] = v if isinstance(v, (tuple, list)) and len(v) == 2 else (v, v)

    params = dict(NEUTRAL)
    params["medium"] = spec["medium"]
    params["frame"] = spec["frame"]
    params["capture_dpi"] = spec.get("capture_dpi")
    params["focal_ratio"] = spec.get("focal_ratio", 0.8)
    params["desk"] = spec.get("desk", (0, 0, 0))
    params["preset"] = preset
    params["modifiers"] = list(modifiers)
    if preset == "identity":
        return params

    # ---- ink geometry on the print bed --------------------------------------
    params["mtf_mm"] = _u(rng, *_range_of(R, "mtf_mm"))
    params["defocus_mm"] = _u(rng, *_range_of(R, "defocus_mm"))
    params["ew_mm"] = _u(rng, *_range_of(R, "ew_mm"))
    # ---- substrate ----------------------------------------------------------
    # Paper batch tone drift: a few percent per channel, same for the whole page.
    d_lo, d_hi = _range_of(R, "paper_tone_drift", (0.0, 0.0))
    d = _u(rng, d_lo, d_hi)
    if d > 0:
        params["paper_tone"] = tuple(
            float(1.0 + d * rng.uniform(-1, 1)) for _ in range(3))
    params["paper_grain_amp"] = _u(rng, *_range_of(R, "paper_grain_amp"))
    params["stripe_period_mm"] = _u(rng, *_range_of(R, "stripe_period_mm"))
    params["stripe_amp"] = _u(rng, *_range_of(R, "stripe_amp"))
    params["bed_texture_amp"] = _u(rng, *_range_of(R, "bed_texture_amp"))
    # ---- illumination -------------------------------------------------------
    params["exposure_ev"] = _u(rng, *_range_of(R, "exposure_ev"))
    params["vignette"] = _u(rng, *_range_of(R, "vignette"))
    params["glare_amp"] = _u(rng, *_range_of(R, "glare_amp"))
    params["glare_angle_deg"] = _u(rng, *_range_of(R, "glare_angle_deg", (0.0, 180.0)))
    params["glare_width_mm"] = _u(rng, *_range_of(R, "glare_width_mm", (8.0, 45.0)))
    params["glare_x"] = _u(rng, 0.15, 0.85)
    params["glare_y"] = _u(rng, 0.15, 0.85)
    params["tone_mix"] = _u(rng, *_range_of(R, "tone_mix"))
    params["auto_level"] = _u(rng, *_range_of(R, "auto_level", (0.0, 0.0)))
    params["white_ref_scale"] = _u(rng, *_range_of(R, "white_ref_scale", (1.0, 1.0)))
    # ---- white balance ------------------------------------------------------
    names = list(WB_SOURCES)
    params["wb_source"] = str(rng.choice(names))
    strength = _u(rng, *_range_of(R, "wb_strength", (0.4, 1.0)))
    g = np.array(WB_SOURCES[params["wb_source"]], dtype=np.float64) ** strength
    params["wb_gain"] = tuple(float(x) for x in g / np.cbrt(np.prod(g)))
    # ---- pose ---------------------------------------------------------------
    sgn = lambda: 1.0 if rng.random() < 0.5 else -1.0  # noqa: E731
    params["rot_deg"] = sgn() * _u(rng, *_range_of(R, "rot_deg"))
    params["yaw_deg"] = sgn() * _u(rng, *_range_of(R, "yaw_deg"))
    params["pitch_deg"] = sgn() * _u(rng, *_range_of(R, "pitch_deg"))
    params["fill"] = _u(rng, *_range_of(R, "fill", (1.0, 1.0)))
    params["shift_x"] = _u(rng, *_range_of(R, "shift_x", (-0.05, 0.05)))
    params["shift_y"] = _u(rng, *_range_of(R, "shift_y", (-0.05, 0.05)))
    params["crop_frac"] = _u(rng, *_range_of(R, "crop_frac"))
    params["crop_dir"] = int(rng.integers(0, 4))
    params["curl_deg"] = _u(rng, *_range_of(R, "curl_deg"))
    params["curl_axis"] = "y" if rng.random() < 0.75 else "x"
    # ---- sensor -------------------------------------------------------------
    params["shot_sigma"] = _u(rng, *_range_of(R, "shot_sigma"))
    params["read_sigma"] = _u(rng, *_range_of(R, "read_sigma"))
    params["hot_rate"] = _u(rng, *_range_of(R, "hot_rate"))
    # ---- motion -------------------------------------------------------------
    params["motion_px"] = _u(rng, *_range_of(R, "motion_px"))
    params["motion_angle_deg"] = _u(rng, *_range_of(R, "motion_angle_deg", (0.0, 180.0)))
    # ---- moire --------------------------------------------------------------
    params["moire_amp"] = _u(rng, *_range_of(R, "moire_amp"))
    params["moire_ratio"] = _u(rng, *_range_of(R, "moire_ratio", (2.0, 2.0)))
    params["moire_angle_deg"] = _u(rng, *_range_of(R, "moire_angle_deg"))
    params["moire_phase"] = _u(rng, 0.0, 2.0 * math.pi)
    # ---- lossy coding -------------------------------------------------------
    params["jpeg_q"] = int(round(_u(rng, *_range_of(R, "jpeg_q"))))
    # ---- ink set: leakage is a per-page EVENT, not a uniform smear ----------
    if rng.random() < _u(rng, *_range_of(R, "bleed_p", (0.0, 0.0))):
        eps = _u(rng, *_range_of(R, "bleed", (0.0, 0.0)))
        params["bleed_eps"] = eps * (1.0 if rng.random() < 0.5 else -1.0)
    if bool(_range_of(R, "mono_force", (False, False))[0]):
        params["mono"] = True
    return params


def mask_factors(params: dict, only=None, off=None) -> dict:
    """Reset every factor outside `only` / inside `off` to neutral (in place)."""
    keep = set(FACTORS)
    if only is not None:
        keep &= set([only] if isinstance(only, str) else only)
    if off is not None:
        keep -= set([off] if isinstance(off, str) else off)
    bad = (set(only or ()) | set(off or ())) - set(FACTORS)
    if bad:
        raise KeyError(f"unknown factor(s): {', '.join(sorted(bad))}")
    for key, fac in FACTOR_OF.items():
        if fac in keep:
            continue
        nv = NEUTRAL[key]
        params[key] = tuple(nv) if isinstance(nv, tuple) else nv
    # frame / capture_dpi are not in FACTOR_OF because they select a device rather
    # than a degradation, but they decide whether the page is resampled at all -- so
    # "geometry off" has to mean the print grid survives intact, or a test that
    # believes it isolated one factor is in fact also looking at a 3x box filter.
    if "geometry" not in keep:
        params["frame"], params["capture_dpi"], params["focal_ratio"] = "page", None, 0.8
    params["enabled_factors"] = tuple(sorted(keep))
    return params


# ===========================================================================
# stage 0: decompose the pristine page into (substrate, coverage, ink)
# ===========================================================================

def _estimate_substrate(img_u8: np.ndarray) -> np.ndarray:
    """Substrate RGB from the bright end of the histogram (quiet zone dominates)."""
    flat = img_u8.reshape(-1, 3).astype(np.float32)
    step = max(1, flat.shape[0] // 300_000)
    return np.percentile(flat[::step], 92, axis=0).astype(np.float32)


def _kmeans(X: np.ndarray, k: int, rng, iters: int = 20):
    """Small deterministic k-means, k-means++ seeding from the page's own stream."""
    n = X.shape[0]
    cent = np.empty((k, X.shape[1]), dtype=np.float32)
    cent[0] = X[int(rng.integers(0, n))]
    d2 = np.sum((X - cent[0]) ** 2, axis=1)
    for i in range(1, k):
        tot = float(d2.sum())
        j = int(rng.integers(0, n)) if tot <= 1e-12 else int(rng.choice(n, p=d2 / tot))
        cent[i] = X[j]
        d2 = np.minimum(d2, np.sum((X - cent[i]) ** 2, axis=1))
    lab = np.zeros(n, dtype=np.int32)
    for _ in range(iters):
        dist = ((X[:, None, :] - cent[None, :, :]) ** 2).sum(axis=2)
        new = dist.argmin(axis=1).astype(np.int32)
        changed = not np.array_equal(new, lab)
        lab = new
        if not changed:
            break
        for i in range(k):
            sel = lab == i
            if np.any(sel):
                cent[i] = X[sel].mean(axis=0)
    return cent, lab


def _cluster_inks(dev: np.ndarray, mag: np.ndarray, rng, kmax: int = 4):
    """Unit directions of the inks actually present, from strongly-covered pixels.

    A single-ink pixel's deviation from the substrate points along (ink - sub)
    whatever its coverage, so direction alone identifies the ink -- the same
    scale-invariance core/palette.js exploits. Returns (k,3) or None.
    """
    peak = float(np.percentile(mag, 99.9)) if mag.size else 0.0
    if peak <= 20.0:
        return None
    idx = np.flatnonzero(mag.ravel() > max(20.0, 0.62 * peak))
    if idx.size < 200:
        return None
    sel = idx[:: max(1, idx.size // 6000)]
    vecs = dev.reshape(-1, 3)[sel].astype(np.float32)
    dirs = vecs / np.maximum(1e-6, np.linalg.norm(vecs, axis=1, keepdims=True))
    kmax = int(max(1, min(kmax, dirs.shape[0] // 250)))
    best = None
    for k in range(1, kmax + 1):
        cent, lab = _kmeans(dirs, k, rng)
        cnt = np.bincount(lab, minlength=k)
        ok = bool(np.all(cnt >= 0.02 * lab.size))
        for i in range(k):
            for j in range(i + 1, k):
                if float(np.dot(cent[i], cent[j])) > 0.985:     # must be >=~10 deg apart
                    ok = False
        if not ok:
            break
        best = cent
    if best is None:
        return None
    keep = []
    for c in best:
        c = c / max(1e-6, float(np.linalg.norm(c)))
        if all(float(np.dot(c, q)) < 0.985 for q in keep):
            keep.append(c)
    return np.array(keep, dtype=np.float32)


def decompose(page_f32: np.ndarray, rng):
    """-> (substrate(3), coverage(H,W), ink dirs(k,3), ink scale(k), ink index(H,W))."""
    img_u8 = np.clip(np.rint(page_f32), 0, 255).astype(np.uint8)
    sub = _estimate_substrate(img_u8)
    dev = (page_f32 - sub[None, None, :]).astype(np.float32)
    mag = np.sqrt((dev * dev).sum(axis=2))
    peak = max(1.0, float(np.percentile(mag, 99.9)))
    D = _cluster_inks(dev, mag, rng)
    if D is None:
        D = np.array([[0.0, 0.0, -1.0]], dtype=np.float32)
    proj = dev @ D.T                                 # signed coverage*scale, per ink
    ink_i = np.argmax(proj, axis=2)
    best = np.take_along_axis(proj, ink_i[:, :, None], axis=2)[:, :, 0]
    # per-ink full-coverage magnitude, measured on the page itself
    mags = np.full(D.shape[0], peak, dtype=np.float32)
    strong = mag > 0.9 * peak
    if np.any(strong):
        sv = dev[strong]
        own = (sv @ D.T).argmax(axis=1)
        for i in range(D.shape[0]):
            sel = own == i
            if np.count_nonzero(sel) > 24:
                mags[i] = float(np.mean(np.sqrt((sv[sel] * sv[sel]).sum(axis=1))))
    alpha = np.clip(best / np.maximum(1e-6, mags[ink_i]), 0.0, 1.0).astype(np.float32)
    alpha[best <= 0] = 0.0
    return sub, alpha, D, mags, ink_i


# ===========================================================================
# stage 1: ink set (mono collapse / colour bleed)
# ===========================================================================

def _mixed_inks(D: np.ndarray, mags: np.ndarray, params: dict) -> np.ndarray:
    """Ink deviation vectors (k,3) at full coverage after mono / bleed."""
    ink = D.astype(np.float32) * mags[:, None]
    if params.get("mono") and len(ink) > 1:
        # One filament loaded: every island prints in the same (darkest) ink, so
        # the colour channel collapses to one value. The G7 fallback input case.
        dark = int(np.argmin(ink.sum(axis=1)))
        ink = np.repeat(ink[dark:dark + 1], len(ink), axis=0)
    eps = float(params.get("bleed_eps") or 0.0)
    if abs(eps) > 1e-9 and len(ink) > 1:
        # Purge leakage / island cross-contamination: a fraction of the previous
        # island's ink is still in the nozzle. eps<0 models a washed-out
        # (under-fed) ink instead of a contaminated one.
        ink = ink + eps * (np.roll(ink, 1, axis=0) - ink)
    return ink


# ===========================================================================
# stage 2: EW expansion -- sub-pixel morphology, honestly
# ===========================================================================

_LABEL_OFFSET = None


def _label_offset() -> int:
    """Index base of cv2 DIST_LABEL_PIXEL labels (build-dependent; probed once)."""
    global _LABEL_OFFSET
    if _LABEL_OFFSET is not None:
        return _LABEL_OFFSET
    probe = np.full((5, 5), 255, np.uint8)
    probe[2, 2] = 0
    _, lab = cv2.distanceTransformWithLabels(probe, cv2.DIST_L2, 3,
                                             labelType=cv2.DIST_LABEL_PIXEL)
    want = 2 * 5 + 2
    got = int(np.min(lab[lab > 0])) if np.any(lab > 0) else want
    _LABEL_OFFSET = got - want
    return _LABEL_OFFSET


def ew_expand_alpha(alpha: np.ndarray, delta_px: float):
    """Shift the ink boundary by a sub-pixel signed distance, keeping soft edges.

    Method: signed distance field of the coverage iso-contour at `tau`, its
    gradient as the unit boundary normal, then ADVect the coverage field by
    -delta along that normal (cv2.remap). For a binary mask that is exactly a
    dilation/erosion by delta; for a soft edge it moves the whole edge profile
    without changing its peak amplitude -- which is the right physics, because
    over-extrusion fattens a feature, it does not darken it. delta=0 is skipped,
    so the stage is a mathematical no-op when off.

    Two limits, stated rather than hidden:
      * tau is the half-inked contour when one exists. A 0.9 px-wide laser ring
        rendered at 300 dpi never reaches coverage 0.5, so tau falls back to
        0.6 x (peak coverage) and `ew_tau` / `ew_tau_fallback` are reported. The
        shift is then measured against the sampled feature's own mid-level: still
        proportional to delta, but its absolute area effect on features thinner
        than the raster can represent is a model, not a measurement.
      * the boundary *shape* comes from a distance transform on a pixel lattice,
        so contour placement is right to about 0.5 px. An exact SDF would need the
        vector source, not a raster.
    """
    if abs(delta_px) < 1e-4:
        return alpha, None, 0.5, False
    amax = float(np.percentile(alpha, 99.9)) if alpha.size else 0.0
    if amax <= 1e-3:
        return alpha, None, 0.5, False
    tau = 0.5 if amax >= 0.5 else max(1e-3, 0.6 * amax)
    fallback = tau < 0.5 - 1e-9
    mask = (alpha >= tau).astype(np.uint8)
    if not mask.any():
        return alpha, None, tau, fallback
    inside = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    out, lab = cv2.distanceTransformWithLabels((1 - mask).astype(np.uint8), cv2.DIST_L2, 3,
                                               labelType=cv2.DIST_LABEL_PIXEL)
    sdf = np.where(mask > 0, -inside, out).astype(np.float32)
    # a 2-px smoothing keeps the normal field stable on curved 1-px-wide features;
    # without it the gradient of a staircase SDF points the wrong way at corners
    sm = cv2.GaussianBlur(sdf, (0, 0), 1.0, borderType=cv2.BORDER_REPLICATE)
    gx = cv2.Sobel(sm, cv2.CV_32F, 1, 0, ksize=3) * (1.0 / 8.0)
    gy = cv2.Sobel(sm, cv2.CV_32F, 0, 1, ksize=3) * (1.0 / 8.0)
    g = np.sqrt(gx * gx + gy * gy)
    ok = g > 1e-3
    nx = np.zeros_like(gx)
    ny = np.zeros_like(gy)
    nx[ok] = gx[ok] / g[ok]
    ny[ok] = gy[ok] / g[ok]
    # the normal only matters within about |delta| of a boundary; the window
    # widens with delta so a 2-px gain is not silently damped by a 2-px window
    nscale = max(2.0, 1.5 * abs(delta_px) + 1.0)
    falloff = np.exp(-(np.abs(sdf) / nscale)).astype(np.float32)
    nx = (nx * falloff * delta_px).astype(np.float32)
    ny = (ny * falloff * delta_px).astype(np.float32)
    hh, ww = alpha.shape
    yy, xx = np.mgrid[0:hh, 0:ww].astype(np.float32)
    map_x = np.clip(xx - nx, 0, ww - 1)
    map_y = np.clip(yy - ny, 0, hh - 1)
    adv = cv2.remap(alpha, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return np.clip(adv, 0.0, 1.0).astype(np.float32), lab, float(tau), fallback


# ===========================================================================
# stage 3: substrate field
# ===========================================================================

def _substrate_mod(h: int, w: int, ppi: float, params: dict, rng) -> np.ndarray:
    """Additive modulation, in 8-bit units, of the substrate reflectance field."""
    mod = np.zeros((h, w), dtype=np.float32)
    grain = float(params["paper_grain_amp"])
    if grain > 0:
        g = rng.standard_normal((h, w)).astype(np.float32)
        g = cv2.GaussianBlur(g, (0, 0), max(0.5, 0.05 * ppi), borderType=cv2.BORDER_REFLECT_101)
        mod += (g / (float(np.std(g)) + 1e-6) * grain).astype(np.float32)
    if params["stripe_amp"] > 0 and params["stripe_period_mm"] > 0:
        # Directional layer/line stripes: strong along one axis, a weaker cross
        # term for the second top skin. Amplitude is a fraction of 255.
        period = max(1.2, params["stripe_period_mm"] * ppi)
        phase = _u(rng, 0.0, period)
        t = (np.arange(h, dtype=np.float32) + phase) * (2.0 * math.pi / period)
        mod += (params["stripe_amp"] * 255.0 * np.sin(t))[:, None].astype(np.float32)
        p2 = period * 2.0
        s = (np.arange(w, dtype=np.float32) + phase) * (2.0 * math.pi / p2)
        mod += (params["stripe_amp"] * 60.0 * np.sin(s))[None, :].astype(np.float32)
    bed = float(params["bed_texture_amp"])
    if bed > 0:
        per = max(2.0, _u(rng, 0.6, 1.6) * ppi)              # PEI dimple wavelength
        n = rng.standard_normal((max(2, h // 3), max(2, w // 3))).astype(np.float32)
        n = cv2.GaussianBlur(n, (0, 0), 1.0)
        n = cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC)
        mod += (n / (float(np.std(n)) + 1e-6) * bed * 255.0).astype(np.float32)
    return mod


# ===========================================================================
# stages 4 / 6: blur
# ===========================================================================

def _gauss(img: np.ndarray, sigma_px: float) -> np.ndarray:
    if sigma_px < 0.4:
        return img
    return cv2.GaussianBlur(img, (0, 0), float(sigma_px), borderType=cv2.BORDER_REFLECT_101)


# ===========================================================================
# stage 5: geometry
# ===========================================================================

def _rot_matrix(roll_deg: float, yaw_deg: float, pitch_deg: float) -> np.ndarray:
    """Camera-from-page rotation: in-plane roll, then yaw, then pitch."""
    r, y, q = np.deg2rad([roll_deg, yaw_deg, pitch_deg])
    cz, sz = math.cos(r), math.sin(r)
    Rz = np.array([[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]])
    cy, sy = math.cos(y), math.sin(y)
    Ry = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]])
    cx, sx = math.cos(q), math.sin(q)
    Rx = np.array([[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]])
    return Rx @ Ry @ Rz


def _project(pts_mm: np.ndarray, R: np.ndarray, d_mm: float, f: float):
    cam = (R @ pts_mm.T).T
    z = cam[:, 2] + d_mm
    return np.stack([f * cam[:, 0] / z, f * cam[:, 1] / z], axis=1)


def _clip_rect_area(poly: np.ndarray, x0: float, y0: float, x1: float, y1: float) -> float:
    """Area of a convex polygon intersected with an axis-aligned rect.

    Sutherland-Hodgman against the four half-planes, then the shoelace formula.
    """
    cur = np.asarray(poly, dtype=np.float64).reshape(-1, 2)
    for ax, lo in ((0, float(x0)), (1, float(y0))):
        if cur.shape[0] < 3:
            return 0.0
        nxt = []
        n = len(cur)
        for i in range(n):
            a, b = cur[i], cur[(i + 1) % n]
            ia, ib = a[ax] >= lo, b[ax] >= lo
            if ia:
                nxt.append(a)
            if ia != ib:
                den = b[ax] - a[ax]
                t = (lo - a[ax]) / den if abs(den) > 1e-12 else 0.0
                nxt.append(a + t * (b - a))
        cur = np.array(nxt, dtype=np.float64).reshape(-1, 2)
    for ax, hi in ((0, float(x1)), (1, float(y1))):
        if cur.shape[0] < 3:
            return 0.0
        nxt = []
        n = len(cur)
        for i in range(n):
            a, b = cur[i], cur[(i + 1) % n]
            ia, ib = a[ax] <= hi, b[ax] <= hi
            if ia:
                nxt.append(a)
            if ia != ib:
                den = b[ax] - a[ax]
                t = (hi - a[ax]) / den if abs(den) > 1e-12 else 0.0
                nxt.append(a + t * (b - a))
        cur = np.array(nxt, dtype=np.float64).reshape(-1, 2)
    if cur.shape[0] < 3:
        return 0.0
    x, y = cur[:, 0], cur[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _poly_area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _marker_visibility(quad: np.ndarray, W: int, H: int, out_w: int, out_h: int,
                       pitch_px: float) -> tuple:
    """How much of each corner marker region survived, as four fractions.

    The corner marker region is the 4x4-cell square at each page corner (the
    3-cell solid fiducial plus a cell of guard, per docs/RENDER-CONTRACT.md), so
    "visible" here means the receiver has enough of *that* to lock on. Testing
    whether the mathematical corner point of the quad happens to be inside the
    frame is not a decodability criterion: a corner point can be out of frame with
    the whole fiducial intact, or in frame with the fiducial half cut off.
    """
    page_corners = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(page_corners, quad.astype(np.float32))
    side = 4.0 * pitch_px
    frac = []
    for i, (cx, cy) in enumerate(((0, 0), (W, 0), (W, H), (0, H))):
        x0 = float(cx) if i in (0, 3) else float(cx) - side
        y0 = float(cy) if i in (0, 1) else float(cy) - side
        box = np.array([[x0, y0], [x0 + side, y0], [x0 + side, y0 + side],
                        [x0, y0 + side]], dtype=np.float64)
        homog = np.hstack([box, np.ones((4, 1))]) @ m.T
        fb = homog[:, :2] / np.maximum(1e-9, homog[:, 2:3])
        whole = max(1e-9, _poly_area(fb))
        frac.append(_clip_rect_area(fb, 0, 0, out_w, out_h) / whole)
    return tuple(round(float(f), 5) for f in frac)


def _place(H: int, W: int, params: dict) -> dict:
    """Pose -> homography + capture sampling + crop bookkeeping.

    Physical content: a pinhole camera with f = focal_ratio * frame_size px (a
    phone's ~70 deg horizontal field of view), aimed at the page centre, page
    rotated in its own plane by `rot_deg` and tilted by `yaw_deg` / `pitch_deg`
    (which is what *produces* the keystone rather than decorating it), translated
    by `shift_*`, and pushed further out along one corner diagonal until
    `crop_frac` of the page area has left the frame.

    Crop policy -- PLAN 6 wants "half page in frame" but never to lose more than
    one corner marker region without the page staying identifiable. So the crop is
    always a CORNER CUT: the translation direction is the diagonal from the page
    centre to one page corner, which removes a triangle around that corner and (for
    crop_frac <= 0.12 on these aspect ratios) keeps the other three fiducials
    fully in view. `corners_visible` is reported; if the requested crop would take
    two marker regions with it, the crop is backed off until three corners remain,
    and if even that fails the crop is dropped entirely.
    """
    ppi_print = params["_ppi_print"]
    w_mm, h_mm = W / ppi_print, H / ppi_print
    frame = params["frame"]
    fr = float(params["focal_ratio"])
    scan_like = frame in ("scan", "page")
    roll = math.radians(float(params["rot_deg"]))

    if frame == "page":                     # identity: no resampling at all
        out_w, out_h = W, H
        ppi_cap = ppi_print
    elif scan_like:
        cap_dpi = params["capture_dpi"] or params["_dpi"]
        ppi_cap = cap_dpi / MM_PER_IN
        fill = max(0.05, float(params["fill"]))
        # A scanner's glass is bigger than the sheet, so a slightly skew-fed page
        # does not lose its corners: size the frame from the page's *bounding box*
        # under in-plane rotation, then let `fill` be how much of that the sheet
        # occupies. Deriving the frame from the unrotated page instead made every
        # scan with rot>0 clip corners for no physical reason.
        bw = w_mm * abs(math.cos(roll)) + h_mm * abs(math.sin(roll))
        bh = w_mm * abs(math.sin(roll)) + h_mm * abs(math.cos(roll))
        out_w = int(max(8, round(bw * ppi_cap / fill)))
        out_h = int(max(8, round(bh * ppi_cap / fill)))
    else:
        out_w, out_h = int(frame[0]), int(frame[1])

    f = fr * max(out_w, out_h)
    R = _rot_matrix(params["rot_deg"], params["yaw_deg"], params["pitch_deg"])
    corners_mm = np.array([
        [-w_mm / 2, -h_mm / 2, 0.0], [w_mm / 2, -h_mm / 2, 0.0],
        [w_mm / 2, h_mm / 2, 0.0], [-w_mm / 2, h_mm / 2, 0.0],
    ])

    if scan_like:
        d = f / ppi_cap                     # sampling fixed by the device's own dpi
    else:
        target = max(8.0, params["fill"] * min(out_w, out_h))

        def size_at(dd):
            p = _project(corners_mm, R, dd, f)
            return max(p[:, 0].max() - p[:, 0].min(), p[:, 1].max() - p[:, 1].min())

        lo, hi = f / 2e5, f / 1e-4          # absurdly close .. absurdly far (mm)
        for _ in range(64):                 # projected size is monotone in 1/d
            mid = math.sqrt(lo * hi)
            if size_at(mid) > target:
                lo = mid
            else:
                hi = mid
        d = math.sqrt(lo * hi)
        ppi_cap = f / d

    base = _project(corners_mm, R, d, f)
    quad = base - base.mean(axis=0) + np.array(
        [out_w / 2.0 + params["shift_x"] * out_w, out_h / 2.0 + params["shift_y"] * out_h])

    # ---- corner cut ---------------------------------------------------------
    # Model: the sheet slides off the frame towards one corner, which is what a
    # page fed square into a tray with its corner past the glass, or a phone held
    # with the near corner out of shot, actually looks like.
    #
    # HONESTY NOTE, because this is where a convenient lie would be easy: on a
    # rectangular frame, a straight cut that removes a *corner* of the page also
    # takes the two corners adjacent to whichever edge it crosses, so "lose a
    # chosen fraction of the page" and "lose exactly one corner marker" are not
    # simultaneously satisfiable in general. The policy here is therefore explicit
    # -- keep the crop only as far as at most ONE corner marker region (the 3-cell
    # fiducial plus a cell of guard, measured by _marker_visibility) falls below
    # half visible, backing off by 0.75/0.5/0.25 and dropping the crop entirely if
    # even the smallest cut would take two. `crop_capped` and `marker_visible` are
    # reported so a test can tell the difference between "crop did not happen" and
    # "crop happened and stayed decodable".
    shift = np.zeros(2)
    crop_req = float(params["crop_frac"])
    crop_capped = False
    pitch_px = float(params.get("_pitch_px", 0.0))
    vis0 = _marker_visibility(quad, W, H, out_w, out_h, pitch_px)

    def n_bad(v):
        return sum(1 for f in v if f < 0.5)

    if crop_req > 1e-4 and n_bad(vis0) == 0:
        ci = int(params["crop_dir"]) % 4
        dirv = quad[ci] - quad.mean(axis=0)
        dirv = dirv / (float(np.linalg.norm(dirv)) + 1e-12)
        full = _poly_area(quad)
        s_lo, s_hi = 0.0, 3.0 * max(out_w, out_h)
        for _ in range(52):                 # bisect the shift that yields crop_req
            s = 0.5 * (s_lo + s_hi)
            inside = _clip_rect_area(quad + dirv * s, 0, 0, out_w, out_h)
            if inside / max(1e-9, full) > (1.0 - crop_req):
                s_lo = s
            else:
                s_hi = s
        shift = dirv * (0.5 * (s_lo + s_hi))
        for frac in (1.0, 0.75, 0.5, 0.25, 0.0):
            v = _marker_visibility(quad + shift * frac, W, H, out_w, out_h, pitch_px)
            if n_bad(v) <= 1:
                shift = shift * frac
                crop_capped = frac < 1.0
                break
    quad = quad + shift
    inside_frac = _clip_rect_area(quad, 0, 0, out_w, out_h) / max(1e-9, _poly_area(quad))
    vis = _marker_visibility(quad, W, H, out_w, out_h, pitch_px)

    page_corners = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.float32)
    q32 = quad.astype(np.float32)
    meta = {
        "out_w": int(out_w), "out_h": int(out_h),
        "ppi_capture": float(ppi_cap), "d_mm": float(d), "f_px": float(f),
        "quad": q32,
        "H_page_to_frame": cv2.getPerspectiveTransform(page_corners, q32),
        "H_frame_to_page": cv2.getPerspectiveTransform(q32, page_corners),
        "marker_visible": vis,
        "corners_visible": int(sum(1 for f in vis if f >= 0.5)),
        "visible_frac": float(inside_frac),
        "crop_capped": bool(crop_capped),
        "w_mm": float(w_mm), "h_mm": float(h_mm),
    }
    return meta


def _curl_page(page: np.ndarray, params: dict) -> np.ndarray:
    """Bend the sheet in its own domain: arc-length compression + tilt shading.

    Surface: lift h(s) = A*sin(pi*s) across the compressed axis, so the *slope*
    peaks at the two ends and is zero mid-page -- a sheet over a roller, which is
    what an ADF curl and a warped plate both look like from above. Local tilt
    phi = atan(dh/ds); printed lines then arrive at the camera crowded together by
    cos(phi), and the surface returns less light by the same Lambert factor.
    Total extent is preserved (the ends stay where the pose put them), so this is
    a redistribution, not a resize: the affine part of the deformation belongs to
    `rot/yaw/pitch/fill`, and duplicating it here would double-count it.
    """
    amp = math.radians(float(params["curl_deg"]))
    axis = params["curl_axis"]
    n = page.shape[1] if axis == "y" else page.shape[0]
    if n < 4:
        return page
    s = (np.arange(n, dtype=np.float64) + 0.5) / n
    phi = np.arctan(math.tan(amp) * np.cos(math.pi * s))
    c = np.cos(phi)
    u = np.concatenate(([0.0], np.cumsum(c) / c.sum()))     # arc length, n+1 knots
    s_knot = np.concatenate((s, [1.0]))                     # sample centres + far end
    out_pos = s                                  # where each output sample sits
    src = np.interp(out_pos, u, s_knot)          # invert the arc-length map
    src_px = np.clip(src * n - 0.5, 0.0, n - 1.0).astype(np.float32)
    shade = np.interp(out_pos, u, np.concatenate((c, [c[-1]]))).astype(np.float32)
    yy, xx = np.mgrid[0:page.shape[0], 0:page.shape[1]].astype(np.float32)
    if axis == "y":
        map_x = np.broadcast_to(src_px[None, :], (page.shape[0], n)).copy()
        map_y = yy
        w = shade[None, :, None]
    else:
        map_x = xx
        map_y = np.broadcast_to(src_px[:, None], (n, page.shape[1])).copy()
        w = shade[:, None, None]
    out = cv2.remap(page, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return out * w


def _apply_geometry(page: np.ndarray, params: dict, meta: dict) -> np.ndarray:
    """Resample the print-grid page into the capture frame, then bend it (curl)."""
    out_w, out_h = meta["out_w"], meta["out_h"]
    desk = [float(v) for v in params["desk"]]
    m = meta["H_frame_to_page"].astype(np.float64)
    ys, xs = np.mgrid[0:out_h, 0:out_w]
    homog = np.stack([xs.ravel(), ys.ravel(), np.ones(out_h * out_w)], axis=1).astype(np.float64)
    den = homog @ m[2]
    src = (homog @ m.T)[:, :2] / np.maximum(1e-9, den[:, None])
    map_x = src[:, 0].reshape(out_h, out_w).astype(np.float32)
    map_y = src[:, 1].reshape(out_h, out_w).astype(np.float32)
    # ---- curl: object-space arc-length compression ---------------------------
    # `curl_axis` names the axis of the bend, i.e. the cylinder the sheet lies on.
    # A bend about y (a hot-dog roll, axis vertical) tilts the surface as you move
    # along x, so the *horizontal* spacing of the printed lines compresses as you
    # travel in x; a bend about x compresses along y. Applying it in the page
    # domain (before the camera sees anything) is what makes it physical: the
    # sheet is bent first, and the pose then maps the bent sheet.
    #
    # What this model does NOT do: it keeps the sheet's projected extent fixed and
    # redistributes the lines inside it, and it approximates the surface by one
    # sinusoidal half-wave of tilt. A real curled plate also moves out of the depth
    # of field non-uniformly and changes its perspective, and recovering that from
    # one frame is not possible -- which is exactly why rectify() refuses to undo a
    # curl. The Lambert term below is the tilt's shading; the blur that would come
    # with it is left to `defocus_mm`, because folding a depth-dependent defocus
    # into this would need a depth map we do not have.
    if abs(params["curl_deg"]) > 1e-6:
        page = _curl_page(page, params)

    # A real sensor integrates over its aperture. On minification INTER_AREA *is*
    # that box filter, so under-sampling produces honest aliasing instead of fake
    # point samples; INTER_LINEAR only when magnifying.
    downsample = meta["ppi_capture"] < params["_ppi_print"]
    interp = cv2.INTER_AREA if downsample else cv2.INTER_LINEAR
    out = cv2.remap(page, map_x, map_y, interp,
                    borderMode=cv2.BORDER_CONSTANT, borderValue=desk)
    # which frame pixels actually hold the page (the AGC reference must not see
    # the desk, and neither should the clipping statistic)
    ones = np.ones(page.shape[:2], dtype=np.float32)
    mask = cv2.remap(ones, map_x, map_y, cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)
    meta["page_mask"] = (mask > 0.5)
    if not np.any(meta["page_mask"]):                    # page entirely out of frame
        meta["page_mask"] = np.ones((out_h, out_w), dtype=bool)
    meta["map_page"] = (map_x, map_y)          # frame px -> page px, for diagnostics
    return out


# ===========================================================================
# stage 7: motion blur
# ===========================================================================

def _motion_blur(img: np.ndarray, length_px: float, angle_deg: float) -> np.ndarray:
    n = int(max(3, round(length_px))) | 1                    # odd kernel
    k = np.zeros((n, n), dtype=np.float32)
    a = math.radians(angle_deg)
    dx, dy = math.cos(a), math.sin(a)
    c = (n - 1) / 2.0
    for i in range(n):
        x = int(round(c + (i - c) * dx))
        y = int(round(c + (i - c) * dy))
        k[min(max(y, 0), n - 1), min(max(x, 0), n - 1)] = 1.0
    k /= float(k.sum())
    return cv2.filter2D(img, -1, k, borderType=cv2.BORDER_REFLECT_101)


# ===========================================================================
# stages 8-11: photometry on the capture grid
# ===========================================================================

def _auto_level(img: np.ndarray, params: dict, mask: np.ndarray) -> tuple:
    """Automatic gain / white level, as a scanner or phone ISP really runs it.

    The device measures the page's own white and drives the analogue gain so it
    lands at a nominal code value. `auto_level` in [0,1] is the *fraction* of that
    correction applied (a real AGC is band-limited and, with a partially cropped
    page or a bright desk, it does not converge) -- applied as gain**strength, so
    0 is exactly "no AGC" and 1 is full normalisation.

    This matters more than it looks: a *uniform* exposure error is invisible to a
    ratio decoder once AGC has eaten it, while the spatially varying parts (a
    vignette, and above all a specular band that raises the AGC reference itself)
    survive. That asymmetry is the physics PLAN 6 is pointing at, and without an
    AGC stage the channel would over-report how dangerous exposure is.
    """
    s = float(params["auto_level"])
    if s <= 1e-6:
        return img, 1.0, float("nan")
    v = img[mask]
    if v.shape[0] < 16:
        return img, 1.0, float("nan")
    measured = float(np.percentile(v.mean(axis=1), 92))
    nominal = float(params.get("_white_nominal", 246.0)) * float(params["white_ref_scale"])
    if measured <= 1e-6:
        return img, 1.0, measured
    gain = (nominal / measured) ** s
    return img * np.float32(gain), gain, measured


def _illumination(img: np.ndarray, params: dict, ppi: float, mask: np.ndarray) -> tuple:
    h, w = img.shape[:2]
    out = img * float(2.0 ** params["exposure_ev"])
    if params["vignette"] > 0:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        cx = w * (0.5 + 0.15 * params["shift_x"])
        cy = h * (0.5 + 0.15 * params["shift_y"])
        r2 = ((xx - cx) / (0.5 * w)) ** 2 + ((yy - cy) / (0.5 * h)) ** 2
        r2 = np.clip(r2 / max(1e-6, float(np.max(r2))), 0.0, 1.0)
        out *= (1.0 - params["vignette"] * r2)[:, :, None]
    if params["glare_amp"] > 0:
        # A specular band: long in one direction, narrow across it. Its peak is
        # allowed above the clip point AFTER exposure, so highlights really clip.
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        a = math.radians(params["glare_angle_deg"])
        ux, uy = math.cos(a), math.sin(a)
        u = (xx - params["glare_x"] * w) * ux + (yy - params["glare_y"] * h) * uy
        v = -(xx - params["glare_x"] * w) * uy + (yy - params["glare_y"] * h) * ux
        sv = max(1.0, 0.5 * params["glare_width_mm"] * ppi)
        su = max(sv, 0.45 * max(h, w))
        band = np.exp(-0.5 * (v / sv) ** 2) * np.exp(-0.5 * (u / su) ** 2)
        out *= (1.0 + params["glare_amp"] * band)[:, :, None]
    return out


def _tone_curve(img: np.ndarray, mix: float) -> np.ndarray:
    """Linear reflectance -> display-referred code value (sRGB transfer), blended."""
    if mix <= 1e-6:
        return img
    lin = np.clip(img / 255.0, 0.0, None)
    gam = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)
    return 255.0 * (lin * (1.0 - mix) + gam * mix)


def _moire(img: np.ndarray, params: dict, ppi: float, pitch_mm: float) -> np.ndarray:
    """Beating of the page lattice against the sensor pitch.

    Additive in LOG space (multiplicative in radiance) with an exposure-independent
    amplitude, which is what real moire does: normalising the picture cannot undo
    it because it moves ink *between* neighbouring cells, not the page as a whole.
    Two gratings of period P (page lattice) and S (sensor) beat with
    lambda = P*S/|S-P| = ratio/(ratio-1) * P when S = ratio*P.
    """
    amp = float(params["moire_amp"])
    ratio = float(params["moire_ratio"])
    if amp <= 0 or pitch_mm <= 0 or ratio <= 1.0 + 1e-6:
        return img
    pitch_px = pitch_mm * ppi
    beat = pitch_px * ratio / (ratio - 1.0)
    if beat < 1.5:
        return img                          # unresolvable: physically invisible here
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = math.radians(params["moire_angle_deg"])
    t1 = (xx * math.cos(a) + yy * math.sin(a)) * (2.0 * math.pi / beat) + params["moire_phase"]
    b = a + math.pi / 2.0                    # the other lattice direction, slightly off
    t2 = (xx * math.cos(b) + yy * math.sin(b)) * (2.0 * math.pi / (beat * 1.07)) \
        + 0.5 * params["moire_phase"]
    gain = np.exp(amp * (0.7 * np.cos(t1) + 0.3 * np.cos(t2))).astype(np.float32)
    return img * gain[:, :, None]


def _white_balance(img: np.ndarray, params: dict) -> np.ndarray:
    """AWB *residual*: purely chromatic by construction.

    A real camera's white balance also re-normalises overall level, so what
    survives a mis-balance is the ratio *between* channels -- exactly the part
    that leaves a coverage-ratio decoder alone and kills a fixed colour
    threshold. Normalising the gain to unit mean encodes that; without it a "wb"
    test would silently also be an exposure test.
    """
    g = np.asarray(params["wb_gain"], dtype=np.float32)
    g = g / float(np.mean(g))
    return img * g[None, None, :]


def _sensor_noise(img: np.ndarray, params: dict, rng) -> np.ndarray:
    """shot: sigma ~ sqrt(signal); read: constant floor. Both in 8-bit units.

    So the *absolute* noise falls with level while the *relative* noise rises in
    the dark areas -- that is what "more noise in the shadows" means physically,
    and the read floor is why shadows rather than highlights set the limit.
    """
    shot = float(params["shot_sigma"])
    read = float(params["read_sigma"])
    hot = float(params["hot_rate"])
    if shot <= 0 and read <= 0 and hot <= 0:
        return img
    out = img
    if shot > 0 or read > 0:
        sigma = read + shot * np.sqrt(np.clip(img, 0.0, None) / 255.0)
        out = img + rng.standard_normal(img.shape).astype(np.float32) * sigma
    if hot > 0:
        n = int(round(hot * out.shape[0] * out.shape[1]))
        if n:
            ys = rng.integers(0, out.shape[0], size=n)
            xs = rng.integers(0, out.shape[1], size=n)
            out[ys, xs] = 255.0
    return out


# ===========================================================================
# the channel
# ===========================================================================

_SKIP_REPORT = ("frame", "desk", "nominal", "medium", "preset", "_dpi", "_ppi_print",
                "_rng", "_pitch_px", "_white_nominal")


def process(page_u8: np.ndarray, params: dict, *, pitch_mm: float | None = None) -> tuple:
    """Run the physical channel on one pristine page (RGB uint8, print grid).

    Returns (out_u8, report, meta). `meta` carries the applied transform so a test
    can rectify with ground truth -- see rectify().
    """
    if page_u8.ndim != 3 or page_u8.shape[2] != 3:
        raise ValueError("process: expect HxWx3 RGB uint8")
    img = page_u8.astype(np.float32)
    H, W = img.shape[:2]
    params["_ppi_print"] = float(params["_dpi"]) / MM_PER_IN
    ppi = params["_ppi_print"]
    report = {k: _jsonable(v) for k, v in params.items() if k not in _SKIP_REPORT}

    if params.get("preset") == "identity":
        # Deliberate bypass, not "a physically perfect round trip": identity exists
        # to prove the harness (same basename, same pixels, manifest copied).
        report["out_size"] = [int(W), int(H)]
        report["capture_ppi"] = round(float(ppi), 4)
        report["jpeg_quality"] = 0
        return page_u8.copy(), report, {"identity": True, "out_w": W, "out_h": H,
                                        "ppi_capture": ppi, "corners_visible": 4,
                                        "visible_frac": 1.0, "crop_capped": False}

    # ---- 0. decompose -------------------------------------------------------
    sub, alpha, D, mags, ink_i = decompose(img, params["_rng"])
    report["substrate_rgb"] = [round(float(x), 1) for x in sub]
    report["ink_count"] = int(D.shape[0])
    report["mean_coverage"] = round(float(alpha.mean()), 4)
    # what the capture device is aiming at when it says "white"
    params["_white_nominal"] = float(np.mean(sub))
    if pitch_mm is None:
        pitch_mm = estimate_pitch_mm(alpha, ppi)
    report["pitch_mm_used"] = round(float(pitch_mm), 4)
    params["_pitch_px"] = float(pitch_mm) * ppi      # the crop policy needs a cell size

    # ---- 1. ink set ---------------------------------------------------------
    ink_vec = _mixed_inks(D, mags, params)
    report["mono"] = bool(params["mono"])
    report["bleed_eps"] = round(float(params["bleed_eps"]), 4)

    # ---- 2. EW expansion (mm -> px on the print grid) ----------------------
    ew_px = float(params["ew_mm"]) * ppi
    alpha_ew, lab, ew_tau, ew_fallback = ew_expand_alpha(alpha, ew_px)
    report["ew_expansion_mm"] = round(float(params["ew_mm"]), 4)
    report["ew_expansion_px"] = round(float(ew_px), 4)
    report["ew_tau"] = round(float(ew_tau), 4)
    report["ew_tau_fallback"] = bool(ew_fallback)
    report["ink_area_gain"] = round(float(alpha_ew.sum() / max(1e-6, alpha.sum()) - 1.0), 5)

    # ---- 3. substrate + recomposite (only when an ink-side stage is live) ---
    mod = _substrate_mod(H, W, ppi, params, params["_rng"])
    tone = np.asarray(params["paper_tone"], dtype=np.float32)
    live = (abs(ew_px) > 1e-4) or bool(np.any(mod != 0)) or bool(np.any(tone != 1.0)) \
        or bool(params["mono"]) or abs(float(params["bleed_eps"])) > 1e-9
    # how well the ink/substrate decomposition reproduces the INPUT with the
    # channel stages off -- i.e. the model's own fidelity, not its effect
    ref = (sub[None, None, :] +
           (D * mags[:, None])[ink_i] * alpha[:, :, None])
    report["decomp_resid_max"] = round(float(np.max(np.abs(ref - img))), 3)
    report["decomp_resid_mean"] = round(float(np.mean(np.abs(ref - img))), 4)
    if live:
        sub_t = (sub * tone).astype(np.float32)          # drifted substrate, (3,)
        base = sub_t[None, None, :] + ink_vec[ink_i] * alpha_ew[:, :, None]
        page = base.astype(np.float32)
        if lab is not None:
            grown = (alpha_ew > alpha + 1e-3) & (alpha < 0.05)
            if np.any(grown):
                off = _label_offset()
                flat_idx = np.clip((lab.astype(np.int64, copy=False) - off).reshape(-1),
                                   0, H * W - 1)
                gh, gw = np.nonzero(grown)
                src_ink = ink_vec[ink_i.reshape(-1)[flat_idx[gh * W + gw]]]
                page[gh, gw] = sub_t + src_ink * alpha_ew[gh, gw][:, None]
        # substrate texture adds to what the *substrate* contributes; opaque ink
        # hides most of it (0.4 of the local coverage is enough to swallow it)
        page = page + mod[:, :, None] * (1.0 - 0.6 * alpha_ew)[:, :, None]
    else:
        page = img                                  # untouched pristine pixels
        report["decomp_resid_max"] = 0.0
    report["substrate_mod_rms"] = round(float(np.std(mod)), 3)

    # ---- 4. printer MTF (mm on the PRINT grid) ------------------------------
    mtf_px = float(params["mtf_mm"]) * ppi
    page = _gauss(page, mtf_px)

    # ---- 5. geometry: bend the sheet, then put a camera in front of it -------
    if abs(params["curl_deg"]) > 1e-6:
        page = _curl_page(page, params)
    meta = _place(H, W, params)
    meta["curl_deg"] = float(params["curl_deg"])
    meta["curl_axis"] = params["curl_axis"]
    report["scale"] = round(meta["ppi_capture"] / ppi, 6)
    report["rotation_deg"] = round(float(params["rot_deg"]), 4)
    report["yaw_deg"] = round(float(params["yaw_deg"]), 4)
    report["pitch_deg"] = round(float(params["pitch_deg"]), 4)
    report["curl_deg"] = round(float(params["curl_deg"]), 4)
    report["fill"] = round(float(params["fill"]), 4)
    report["crop_frac"] = round(float(1.0 - meta["visible_frac"]), 5)
    report["crop_requested_frac"] = round(float(params["crop_frac"]), 5)
    report["crop_capped"] = meta["crop_capped"]
    report["corners_visible"] = meta["corners_visible"]
    report["marker_visible"] = list(meta["marker_visible"])
    report["frame_px"] = [meta["out_w"], meta["out_h"]]
    report["capture_ppi"] = round(meta["ppi_capture"], 4)
    report["page_mm"] = [round(meta["w_mm"], 3), round(meta["h_mm"], 3)]
    frame_img = _apply_geometry(page, params, meta)

    # ---- 6. capture defocus (mm on the CAPTURE grid) ------------------------
    cap_ppi = meta["ppi_capture"]
    defocus_px = float(params["defocus_mm"]) * cap_ppi
    frame_img = _gauss(frame_img, defocus_px)
    report["blur_sigma_mm"] = round(math.hypot(float(params["mtf_mm"]), float(params["defocus_mm"])), 4)
    report["blur_sigma_px"] = round(mtf_px + defocus_px, 3)
    report["blur_mtf_px_print"] = round(mtf_px, 3)
    report["blur_defocus_px_capture"] = round(defocus_px, 3)

    # ---- 7. motion ----------------------------------------------------------
    if params["motion_px"] > 0.5:
        frame_img = _motion_blur(frame_img, params["motion_px"], params["motion_angle_deg"])
    report["motion_px"] = round(float(params["motion_px"]), 3)
    report["motion_angle_deg"] = round(float(params["motion_angle_deg"]), 3)

    # ---- 8. illumination -----------------------------------------------------
    # The camera transfer curve is deliberately applied LAST, after moire/WB/noise:
    # shot noise is born in the linear photoelectrons and it is the curve's steep
    # shadow slope that turns it into visible grain. Noise added *after* the curve
    # would put the grain in the highlights instead, which is backwards -- and the
    # moire's log-space modulation only commutes with exposure in linear space.
    pmask = meta.get("page_mask")
    if pmask is None:
        pmask = np.ones(frame_img.shape[:2], dtype=bool)
    frame_img = _illumination(frame_img, params, cap_ppi, pmask)
    report["exposure_ev"] = round(float(params["exposure_ev"]), 4)
    report["vignette"] = round(float(params["vignette"]), 4)
    report["glare_amp"] = round(float(params["glare_amp"]), 4)
    report["glare_width_mm"] = round(float(params["glare_width_mm"]), 3)

    # ---- 9. moire ------------------------------------------------------------
    frame_img = _moire(frame_img, params, cap_ppi, pitch_mm)
    report["moire_amp"] = round(float(params["moire_amp"]), 4)
    report["moire_ratio"] = round(float(params["moire_ratio"]), 4)
    report["moire_period_px"] = round(float(pitch_mm * cap_ppi * params["moire_ratio"] /
                                            max(1e-6, params["moire_ratio"] - 1.0)), 3)

    # ---- 10. white balance ---------------------------------------------------
    frame_img = _white_balance(frame_img, params)
    report["wb_source"] = params["wb_source"]
    report["wb_gain"] = [round(float(x), 4) for x in params["wb_gain"]]

    # ---- 10b. AE/AWB level, after the balance --------------------------------
    # A real device converges so that its white reference lands on the nominal
    # code value *after* the per-channel gains; normalising before them invented a
    # highlight clip out of nothing (the boosted channel simply crossed 255).
    frame_img, agc_gain, agc_ref = _auto_level(frame_img, params, pmask)
    report["auto_level"] = round(float(params["auto_level"]), 4)
    report["agc_gain"] = round(float(agc_gain), 4)
    report["agc_ref_level"] = round(agc_ref, 2) if agc_ref == agc_ref else None

    # ---- 11. sensor noise (linear photoelectrons) ----------------------------
    frame_img = _sensor_noise(frame_img, params, params["_rng"])
    report["noise_sigma"] = round(float(params["read_sigma"]) +
                                  float(params["shot_sigma"]) * math.sqrt(0.5), 4)
    report["noise_sigma_paper"] = round(float(params["read_sigma"]) +
                                        float(params["shot_sigma"]) * 0.98, 4)
    report["noise_sigma_ink"] = round(float(params["read_sigma"]) +
                                      float(params["shot_sigma"]) * 0.30, 4)
    report["hot_rate"] = round(float(params["hot_rate"]), 8)

    # ---- 11b. camera transfer curve, then the code-value clip ----------------
    frame_img = _tone_curve(frame_img, params["tone_mix"])
    report["tone_mix"] = round(float(params["tone_mix"]), 4)
    page_px = frame_img[pmask] if pmask.any() else frame_img.reshape(-1, 3)
    # 高光削顶, on the page only (the desk is not a highlight), before the clip
    report["clipped_frac"] = round(float(np.mean(np.max(page_px, axis=1) >= 255.0)), 6)
    report["near_clip_frac"] = round(float(np.mean(np.max(page_px, axis=1) >= 250.0)), 6)
    # On a white sheet clipped_frac reports the PAPER (substrate sits at code 255 and
    # an ordinary scan of it is 13% "clipped" by that definition), which is not a
    # statement about damage. Saturation matters only where there is ink, so bring the
    # page's own coverage into the frame and count wiped ink. Sampling alpha_ew through
    # the pre-curl map leaves a few percent of one axis wrong on a curled plate -- the
    # number is a fraction of an area, so that error is below what it can resolve.
    mapp = meta.get("map_page")
    if mapp is not None:
        a_f = cv2.remap(alpha_ew, mapp[0], mapp[1], cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT)
        sat = (np.max(frame_img, axis=2) >= 255.0) & (pmask & (a_f > 0.5))
        bare = pmask & (a_f <= 0.5)
        report["glare_ink_wiped_frac"] = round(float(sat.sum() / max(1.0, float(
            (pmask & (a_f > 0.5)).sum()))), 6)
        report["paper_sat_frac"] = (round(float(np.mean(
            np.max(frame_img[bare], axis=1) >= 255.0)), 6) if bare.any() else None)

    # ---- 12. quantize, JPEG in memory ---------------------------------------
    q = int(params["jpeg_q"])
    out_u8 = np.clip(np.rint(frame_img), 0.0, 255.0).astype(np.uint8)
    if 0 < q < 100:
        ok, buf = cv2.imencode(".jpg", cv2.cvtColor(out_u8, cv2.COLOR_RGB2BGR),
                               [int(cv2.IMWRITE_JPEG_QUALITY), q])
        if not ok:
            raise RuntimeError("cv2.imencode('.jpg') failed")
        out_u8 = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    report["jpeg_quality"] = q
    report["out_size"] = [int(out_u8.shape[1]), int(out_u8.shape[0])]
    return out_u8, report, meta


def rectify(out_u8: np.ndarray, meta: dict, page_hw: tuple, *, strict: bool = True):
    """Ground-truth rectification for tests -- NOT a decoder, and not a cheat that
    helps the channel: it exists so a test can ask "did the *photometry* survive?"
    with the geometry removed by construction.

    It inverts the exact homography the channel applied. It cannot undo the curl
    (a non-planar bend is not invertible from a single frame), so with strict=True
    it refuses rather than silently returning a badly registered page.
    """
    if meta.get("identity"):
        return out_u8
    if strict and abs(float(meta.get("curl_deg", 0.0))) > 1e-6:
        raise ValueError(
            f"rectify: this page was bent (curl_deg={meta.get('curl_deg')}), and a "
            f"non-planar bend is not invertible from one frame. Returning the "
            f"planar-rectified image anyway would be a lie about registration; pass "
            f"strict=False if you want the homography undone and the residual bend "
            f"kept as part of what is being measured.")
    H, W = page_hw
    src = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(meta["quad"].astype(np.float32), src)
    return cv2.warpPerspective(out_u8, M, (W, H), flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))


def estimate_pitch_mm(alpha: np.ndarray, ppi: float) -> float:
    """Dominant lattice period in mm, from row/column projections of the coverage.

    Used to set the moire beat when there is no manifest. Falls back to the
    P-M1-300 nominal 0.847 mm when the spectrum has no credible peak.
    """
    try:
        cands = []
        for proj in (alpha.mean(axis=1), alpha.mean(axis=0)):
            x = (proj - proj.mean()).astype(np.float64)
            n = x.size
            if n < 24:
                continue
            sp = np.abs(np.fft.rfft(x * np.hanning(n)))
            fr = np.fft.rfftfreq(n, 1.0)
            band = (fr >= 1.0 / 200.0) & (fr <= 1.0 / 3.0)     # periods 3..200 px
            if not np.any(band):
                continue
            k = int(np.argmax(np.where(band, sp, 0.0)))
            if sp[k] <= 0:
                continue
            if 0 < k < len(sp) - 1:
                a, b, c = sp[k - 1], sp[k], sp[k + 1]
                den = a - 2 * b + c
                d = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
                fk = (k + d) / n
            else:
                fk = fr[k]
            cands.append(1.0 / max(1e-9, fk))
        if not cands:
            return 0.847
        return float(np.median(cands)) / ppi
    except Exception:
        return 0.847


# ===========================================================================
# files / CLI
# ===========================================================================

IMAGE_RE = re.compile(r"\.(png|jpg|jpeg|tif|tiff|bmp)$", re.I)


def page_index_of(name: str, fallback: int) -> int:
    """Index that seeds this page's stream: the number IN THE FILENAME.

    page-007.png -> 7. That is what makes a page's degradation independent of which
    other pages exist. The LAST digit group wins (plate-3-page-004.png -> 4). A
    name without digits falls back to the sorted position and says so.
    """
    nums = re.findall(r"(\d+)", os.path.basename(name))
    if not nums:
        return int(fallback)
    return int(nums[-1])


def read_rgb(path: str) -> np.ndarray:
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"could not decode image: {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def write_png(path: str, rgb: np.ndarray, dpi: float) -> None:
    """RGB 8-bit non-interlaced PNG with the *capture* dpi recorded.

    The recorded dpi is the capture sampling of the physical page, not the print
    dpi: after a resampling these are different numbers and claiming the print one
    would be a lie. The receiver gets the print geometry from manifest.json.
    """
    from PIL import Image
    d = max(1, int(round(float(dpi))))
    Image.fromarray(rgb).save(path, format="PNG", dpi=(d, d), optimize=False)


def process_page_file(in_path: str, out_path: str, *, preset: str, seed: int, page_index: int,
                      dpi: float, modifiers=(), only=None, off=None, overrides=None,
                      manifest: dict | None = None, out=None) -> dict:
    """One page through the channel; returns its report (out= receives the image)."""
    page = read_rgb(in_path)
    rng = _rng_stream(seed, page_index)
    params = draw_params(preset, rng, modifiers=modifiers, overrides=overrides)
    params["_rng"] = rng
    params["_dpi"] = float(dpi)
    if only or off:
        mask_factors(params, only=only, off=off)
    pitch = None
    if manifest:
        try:
            pitch = float(manifest["pageGeometry"]["pitchMm"])
        except Exception:
            pitch = None
    img, report, meta = process(page, params, pitch_mm=pitch)
    report["page"] = int(page_index)
    report["page_index_source"] = "filename" if re.search(r"\d", os.path.basename(in_path)) else "position"
    report["file"] = os.path.basename(out_path)
    report["input"] = os.path.basename(in_path)
    report["preset"] = preset
    report["modifiers"] = list(modifiers)
    report["seed"] = int(seed)
    report["print_dpi"] = float(dpi)
    report["pitch_px_print"] = round(report.get("pitch_mm_used", 0.0) * float(dpi) / MM_PER_IN, 3)
    write_png(out_path, img, meta.get("ppi_capture", dpi) * MM_PER_IN)
    if out is not None:
        out.append((img, meta))
    return report


def _gather_inputs(in_path: str) -> list:
    if os.path.isdir(in_path):
        return [os.path.join(in_path, n)
                for n in sorted(os.listdir(in_path)) if IMAGE_RE.search(n)]
    return [in_path] if IMAGE_RE.search(in_path) else []


def _parse_pages(spec):
    if not spec:
        return None
    want = set()
    for part in re.split(r"[,\s]+", str(spec).strip()):
        if not part:
            continue
        m = re.match(r"^(\d+)-(\d+)$", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            want.update(range(min(a, b), max(a, b) + 1))
        elif part.isdigit():
            want.add(int(part))
        else:
            raise SystemExit(f"--pages: cannot understand {part!r}")
    return want


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="sim/channel.py",
        description="Deterministic print+capture degradation channel for PSKT fixtures.")
    ap.add_argument("--in", dest="in_path", required=True, help="dir of page images or one file")
    ap.add_argument("--out", required=True, help="output directory (created)")
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--preset", required=True, choices=PRESET_NAMES)
    ap.add_argument("--dpi", type=float, default=None,
                    help="print dpi of the input pages (default: manifest dpi, else 300)")
    ap.add_argument("--pages", default=None, help='page selection, e.g. "0,2,5-7"')
    ap.add_argument("--manifest", default=None,
                    help="manifest to copy verbatim into --out (default: <in>/manifest.json)")
    ap.add_argument("--report", action="store_true",
                    help="print one JSON object per page, plus a summary line, on stdout")
    ap.add_argument("--modifier", action="append", default=[], choices=sorted(MODIFIERS),
                    help="named range patch (repeatable): dark, mono, bleed, flat, clean, ...")
    ap.add_argument("--only", action="append", default=None, metavar="LIST",
                    help="comma list: enable ONLY these factors (repeatable)")
    ap.add_argument("--off", action="append", default=None, metavar="LIST",
                    help="comma list: disable these factors (repeatable)")
    ap.add_argument("--param", action="append", default=[], metavar="K=V",
                    help="override one generator parameter (repeatable), e.g. --param ew_mm=0.1")
    args = ap.parse_args(argv)

    def die(msg: str, code: int = 2) -> int:
        sys.stderr.write(f"channel: {msg}\n")
        return code

    inputs = _gather_inputs(args.in_path)
    if not inputs:
        return die(f"no images found in {args.in_path!r}")

    src_manifest = args.manifest or (
        os.path.join(args.in_path, "manifest.json") if os.path.isdir(args.in_path) else None)
    manifest = load_manifest(src_manifest) if src_manifest else None

    dpi = args.dpi or (manifest or {}).get("dpi") or 300.0
    if not (dpi > 0):
        return die(f"--dpi must be positive, got {dpi}")
    mdpi = (manifest or {}).get("dpi")
    if args.dpi and mdpi and abs(float(args.dpi) - float(mdpi)) > 1e-6:
        # Refused rather than honoured: every mm-based factor in this channel (MTF,
        # EW, layer stripes, glare width, defocus) is converted to pixels through
        # this number, so a mismatch does not shift the picture, it silently rescales
        # physics by that ratio and still exits 0.
        return die(f"--dpi {args.dpi} contradicts manifest.dpi {mdpi}: the channel "
                   f"turns millimetres into pixels with this number, so one of the "
                   f"two is wrong about what was printed. Drop --dpi to trust the "
                   f"manifest, or point --manifest at the manifest that matches "
                   f"{args.dpi} dpi.")

    want = _parse_pages(args.pages)
    def _flist(v):
        """--off a,b --off c  ->  ['a','b','c']; empty/absent -> None."""
        if not v:
            return None
        items = [v] if isinstance(v, str) else v
        out = [s for it in items for s in re.split(r"[,\s]+", it) if s]
        return out or None

    only, off = _flist(args.only), _flist(args.off)
    bad = (set(only or ()) | set(off or ())) - set(FACTORS)
    if bad:
        return die(f"unknown factor(s) {', '.join(sorted(bad))}; factors are: "
                   f"{', '.join(FACTORS)}")
    overrides = {}
    for kv in args.param:
        if "=" not in kv:
            return die(f"--param wants KEY=VALUE, got {kv!r}")
        k, v = kv.split("=", 1)
        try:
            overrides[k.strip()] = json.loads(v)
        except ValueError:
            overrides[k.strip()] = v.strip()

    os.makedirs(args.out, exist_ok=True)
    reports = []
    for pos, path in enumerate(inputs):
        idx = page_index_of(path, pos)
        if want is not None and idx not in want:
            continue
        base = os.path.basename(path)
        # keep the basename but normalise a non-PNG input to .png (a JPEG container
        # would be unreadable by the Node reader anyway)
        name = re.sub(r"\.(jpe?g|tif|tiff|bmp)$", ".png", base, flags=re.I)
        rep = process_page_file(path, os.path.join(args.out, name), preset=args.preset,
                                seed=args.seed, page_index=idx, dpi=dpi,
                                modifiers=args.modifier, only=only, off=off,
                                overrides=overrides, manifest=manifest)
        reports.append(rep)
        if not args.report:
            sys.stderr.write(f"  {name}: {rep['out_size'][0]}x{rep['out_size'][1]} "
                             f"blur={rep.get('blur_sigma_mm')}mm crop={rep.get('crop_frac')}\n")
    if not reports:
        return die(f"--pages {args.pages!r} selected nothing out of {len(inputs)} image(s)")

    # manifest: verbatim copy, a receiver cannot work without it
    copied = False
    if src_manifest and os.path.exists(src_manifest):
        with open(src_manifest, "rb") as fh:
            blob = fh.read()
        with open(os.path.join(args.out, "manifest.json"), "wb") as fh:
            fh.write(blob)
        copied = True

    if args.report:
        for rep in reports:
            sys.stdout.write(json.dumps(_jsonable(rep), sort_keys=True) + "\n")
        keys = ("blur_sigma_mm", "ew_expansion_mm", "exposure_ev", "glare_amp", "noise_sigma",
                "crop_frac", "moire_amp", "jpeg_quality", "rotation_deg", "scale")
        summary = {
            "summary": True, "preset": args.preset, "seed": args.seed,
            "pages": len(reports), "out": args.out, "manifest_copied": copied,
            "print_dpi": float(dpi), "modifiers": list(args.modifier),
            "only": only, "off": off,
            "mean": {k: round(float(np.mean([r[k] for r in reports if isinstance(r.get(k), (int, float))])), 5)
                     for k in keys},
            "max": {k: round(float(np.max([r[k] for r in reports if isinstance(r.get(k), (int, float))])), 5)
                    for k in keys},
            "out_sizes": sorted({tuple(r["out_size"]) for r in reports}),
        }
        sys.stdout.write(json.dumps(_jsonable(summary), sort_keys=True) + "\n")
    else:
        sys.stderr.write(f"channel: {len(reports)} page(s) -> {args.out} "
                         f"(preset={args.preset} seed={args.seed} dpi={dpi} "
                         f"manifest={'copied' if copied else 'none'})\n")
    return 0


def load_manifest(path):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8"))
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
