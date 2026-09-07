#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sim/selfcheck.py -- prove the channel does what it claims, in numbers.

Runs the channel **in process** (imported, never spawned -- the sandbox forbids
piped child stdio) over synthetic pages generated here with numpy. The pages are
deliberately NOT produced by the real encoder: this file audits the *channel*, so
it must not inherit the encoder's idea of a glyph. What it does copy, faithfully,
is the contract -- quiet zone, four solid corner squares, a lattice of "reference
annulus + centre dot" glyphs whose area ratio rho carries the data, composited as

    obs = substrate*(1 - a) + ink*a        (4x4 supersampled coverage)

and the geometry from core/render/glyphs.js, including the extrusion-width
quantisation a plate actually prints with (port of `quantise` below). rho is then
measured the way core/decode/ideal.js#analyseCell measures it, so the number
printed here is the number the decoder acts on.

    (a) determinism        same seed -> byte-identical files; a page's bytes do
                           not depend on its co-residents; --report shape
    (b) seed sensitivity   different seed -> different bytes
    (c) identity           preset identity is lossless (max |delta| = 0)
    (d) factor isolation   every factor, enabled ALONE, measurably moves the image
    (e) rho survival       the decoder's own quantity at the page centre, pristine
                           vs through the channel, tolerance stated as a fraction
                           of the decision margin, reported even when it fails
    (f) readability        cv2.imread + PIL.Image.open, 8-bit non-interlaced PNG
    (g) CLI contract       exit codes, --pages, --in <file>, output names

    python sim/selfcheck.py [--full] [--keep]

    Default is a smoke pass (~35 s on this machine): every factor isolated, the
    asserted tiers of the rho matrix, the CLI contract. --full adds the whole
    preset x page matrix, which is minutes.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import shutil
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import channel as CH  # noqa: E402

MM = CH.MM_PER_IN

# ---------------------------------------------------------------------------
# geometry: port of core/render/glyphs.js
# ---------------------------------------------------------------------------

ANNULUS_OUTER = 0.47
ANNULUS_INNER = 0.38
ANNULUS_AREA = math.pi * (ANNULUS_OUTER ** 2 - ANNULUS_INNER ** 2)
MEASURE = {"dotR": 0.30, "bandIn": 0.40, "bandOut": 0.455}
MEASURE["bandGuardArea"] = math.pi * (MEASURE["bandOut"] ** 2 - MEASURE["bandIn"] ** 2)
MEASURE["bandScale"] = ANNULUS_AREA / MEASURE["bandGuardArea"]
MAX_DOT_RADIUS = 0.28
RHO_LO, RHO_HI = 0.3, math.pi * MAX_DOT_RADIUS ** 2 / ANNULUS_AREA
QUIET_CELLS, FID_CELLS = 5, 3


def rho_for(level: int, levels: int) -> float:
    return 0.0 if level <= 0 else RHO_LO + (RHO_HI - RHO_LO) * (level - 1) / (levels - 1)


def ideal_geometry(levels: int) -> dict:
    return {"quantised": False, "cellEw": None, "levels": levels,
            "outer": ANNULUS_OUTER, "inner": ANNULUS_INNER, "area": ANNULUS_AREA,
            "dot": [math.sqrt(rho_for(l, levels) * ANNULUS_AREA / math.pi) if l else 0.0
                    for l in range(levels)],
            "measure": dict(MEASURE)}


def quantise(cell_ew: int, levels: int):
    """Port of glyphs.js#quantise -- whole extrusion widths, no free radii."""
    min_dot_ew = math.ceil(math.sqrt(levels - 1))
    for outer_ew in range(int((cell_ew - 2) // 2), 1, -1):
        ring_ew = max(1, int(round(outer_ew * 0.18)))
        inner_ew = outer_ew - ring_ew
        if inner_ew < 2:
            continue
        max_dot_ew = inner_ew - 1
        if max_dot_ew < min_dot_ew:
            continue
        radii = [0] + [max(1, int(round(max_dot_ew * math.sqrt(k / (levels - 1)))))
                       for k in range(1, levels)]
        if len(set(radii)) != levels:
            continue
        outer, inner = outer_ew / cell_ew, inner_ew / cell_ew
        dot = [r / cell_ew for r in radii]
        guard_ew = min(0.5, ring_ew / 4.0)
        band_in, band_out = (inner_ew + guard_ew) / cell_ew, (outer_ew - guard_ew) / cell_ew
        area = math.pi * (outer ** 2 - inner ** 2)
        rho_hi = math.pi * dot[levels - 1] ** 2 / area
        if not (rho_hi > 0) or rho_hi > 0.95:
            continue
        guard = math.pi * (band_out ** 2 - band_in ** 2)
        return {"quantised": True, "cellEw": cell_ew, "levels": levels,
                "outer": outer, "inner": inner, "area": area, "dot": dot,
                "rho_hi": rho_hi,
                "measure": {"dotR": min(max(dot[levels - 1] + guard_ew / cell_ew,
                                            inner - guard_ew / cell_ew), 0.49),
                            "bandIn": band_in, "bandOut": band_out,
                            "bandGuardArea": guard, "bandScale": area / guard}}
    return None


def ew_geometry(cell_ew: float, levels: int) -> dict:
    """Port of glyphs.js#glyphGeometry for a cell measured in extrusion widths."""
    if not math.isfinite(cell_ew) or cell_ew <= 0 or cell_ew >= 24:
        return ideal_geometry(levels)
    hit = quantise(int(cell_ew), levels)
    if hit is None:
        raise RuntimeError(f"no EW geometry for cellEw={cell_ew} levels={levels}")
    return hit


# ---------------------------------------------------------------------------
# synthetic pristine page
# ---------------------------------------------------------------------------

def make_page(dpi: int, pitch_mm: float, cols: int, rows: int, levels: int,
              geom: dict, substrate=(246, 242, 234), mono: bool = False,
              inks=((20, 20, 20), (200, 32, 44))) -> dict:
    """A pristine rendered page: what `pskit send` writes to disk."""
    cell = int(round(pitch_mm * dpi / MM))
    quiet = QUIET_CELLS * cell
    W, H = cols * cell + 2 * quiet, rows * cell + 2 * quiet
    px = np.empty((H, W, 3), dtype=np.uint8)
    px[:, :] = np.array(substrate, dtype=np.uint8)
    sub = np.array(substrate, dtype=np.float32)

    def fill_solid(x0, y0, w, h, ink):
        xa, xb = max(0, int(round(x0))), min(W, int(round(x0 + w)))
        ya, yb = max(0, int(round(y0))), min(H, int(round(y0 + h)))
        px[ya:yb, xa:xb] = np.rint(np.array(ink, dtype=np.float32)).astype(np.uint8)

    half = FID_CELLS * cell / 2.0
    inset = half + cell
    for (fx, fy) in ((inset, inset), (W - inset, inset),
                     (inset, H - inset), (W - inset, H - inset)):
        fill_solid(fx - half, fy - half, FID_CELLS * cell, FID_CELLS * cell, (18, 18, 18))

    ss = 4
    offs = (np.arange(ss, dtype=np.float32) + 0.5) / ss
    axis = np.arange(cell, dtype=np.float32)
    tiles = []
    for lv in range(levels):
        rd = geom["dot"][lv]
        t = np.zeros((cell, cell), dtype=np.float32)
        for sy in range(ss):
            yy = (axis[:, None] + offs[sy]) / cell - 0.5
            ry2 = yy * yy
            for sx in range(ss):
                xx = (axis[None, :] + offs[sx]) / cell - 0.5
                rr2 = xx * xx + ry2
                inside = rr2 <= geom["outer"] ** 2
                hole = rr2 <= geom["inner"] ** 2
                inside = np.where(hole, (rr2 <= rd * rd) & (rd > 0), inside)
                t += inside.astype(np.float32)
        tiles.append(t / (ss * ss))

    level_grid = np.zeros((rows, cols), dtype=np.int32)
    ink_grid = np.zeros((rows, cols), dtype=np.int32)
    for r in range(rows):
        for c in range(cols):
            lv = int((c * 7 + r * 3 + ((c * r) % 5)) % levels)
            ik = 0 if mono else (c + r) % len(inks)
            level_grid[r, c], ink_grid[r, c] = lv, ik
            x0, y0 = quiet + c * cell, quiet + r * cell
            ink = np.array(inks[ik], dtype=np.float32)
            reg = px[y0:y0 + cell, x0:x0 + cell].astype(np.float32)
            reg = sub[None, None, :] * (1.0 - tiles[lv][:, :, None]) + ink[None, None, :] * tiles[lv][:, :, None]
            px[y0:y0 + cell, x0:x0 + cell] = np.rint(reg).astype(np.uint8)

    return {"pixels": px, "dpi": int(dpi), "cell": cell, "cols": cols, "rows": rows,
            "origin": (int(quiet), int(quiet)), "substrate": tuple(int(v) for v in substrate),
            "inks": [tuple(int(v) for v in i) for i in inks], "levels": levels, "geom": geom,
            "pitch_mm": float(pitch_mm), "level_grid": level_grid, "ink_grid": ink_grid,
            "width": int(W), "height": int(H)}


def measure_rho(page_px: np.ndarray, page: dict, c: int, r: int):
    """core/decode/ideal.js#analyseCell, from first principles.

    Coverage is the projection of a pixel onto the cell's own ink direction (the
    furthest pixel from the substrate); rho is the dot-region integral over the
    guard-band integral of the reference annulus, scaled to the full ring area.
    """
    sub = np.array(page["substrate"], dtype=np.float32)
    cell, org = page["cell"], page["origin"]
    m = page["geom"]["measure"]
    tile = page_px[org[1] + r * cell:org[1] + (r + 1) * cell,
                   org[0] + c * cell:org[0] + (c + 1) * cell].astype(np.float32)
    if tile.shape[0] != cell or tile.shape[1] != cell:
        return float("nan")
    dev = tile - sub[None, None, :]
    k = int(np.argmax((dev * dev).sum(axis=2)))
    iy, ix = divmod(k, cell)
    ink = tile[iy, ix]
    denom = math.sqrt(float(((ink - sub) ** 2).sum()))
    if denom < math.sqrt(6.0):
        return float("nan")
    a = np.clip((dev * ((ink - sub) / denom)[None, None, :]).sum(axis=2) / denom, 0.0, 1.2)
    n = cell * cell
    yy = (np.arange(cell, dtype=np.float32)[:, None] + 0.5) / cell - 0.5
    xx = (np.arange(cell, dtype=np.float32)[None, :] + 0.5) / cell - 0.5
    rr = np.sqrt(xx * xx + yy * yy)
    dot = float(a[rr <= m["dotR"]].sum()) / n
    band = float(a[(rr >= m["bandIn"]) & (rr <= m["bandOut"])].sum()) / n * m["bandScale"]
    return dot / band if band > 1e-4 else float("nan")


# ---------------------------------------------------------------------------
# check plumbing
# ---------------------------------------------------------------------------

FAILURES: list = []
FULL = False                      # set from --full; see check_rho's case matrix
# The tiers whose own README line says they are expected to hurt. They are still run,
# still printed with every number, and still asserted when they pass -- a stress tier
# that turns out survivable is news worth having. What is NOT done is failing the
# suite because the stress tier stressed: that number is a measurement of where the
# boundary sits, which is the only thing a stress preset is for.
STRESS_PRESETS = ("phone-hard",)
_trapz = getattr(np, "trapezoid", getattr(np, "trapz", None))   # numpy 2 renamed it


def ok(label: str, cond: bool, detail: str) -> bool:
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}: {detail}")
    if not cond:
        FAILURES.append(label)
    return cond


def run_cli(argv):
    """Call channel.main() in process, capturing its stdout as report objects."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = CH.main(argv)
    lines = [ln for ln in buf.getvalue().splitlines() if ln.strip()]
    return rc, [json.loads(ln) for ln in lines]


def isolated_params(dpi: int, medium: str = "paper") -> dict:
    """Everything off, pixel grid pinned: the control for one-factor tests."""
    p = dict(CH.NEUTRAL)
    p.update({"medium": medium, "frame": "page", "capture_dpi": None,
              "focal_ratio": 0.8, "desk": (0, 0, 0), "preset": "custom", "modifiers": []})
    p["_rng"] = np.random.default_rng(np.random.SeedSequence([4, 0]))
    p["_dpi"] = float(dpi)
    p["_ppi_print"] = float(dpi) / MM
    return p


def hf_energy(img: np.ndarray) -> float:
    g = cv2.Laplacian(img.astype(np.float32), cv2.CV_32F, ksize=3)
    return float(np.mean(g * g))


def quiet_zone(img: np.ndarray, page: dict) -> np.ndarray:
    """The top quiet zone *between* the two corner squares: pure substrate."""
    q = QUIET_CELLS * page["cell"]
    return img[2:max(4, q - page["cell"]), q:img.shape[1] - q]


# ---------------------------------------------------------------------------
# (a) (b) determinism
# ---------------------------------------------------------------------------

def check_determinism(work: str, names: list) -> None:
    print("\n(a) determinism")
    src = os.path.join(work, "src")

    def go(out, seed, extra=()):
        rc, objs = run_cli(["--in", src, "--out", out, "--seed", str(seed),
                            "--preset", "scan300", "--dpi", "300", "--report", *extra])
        assert rc == 0, f"channel exited {rc}"
        files = {n: open(os.path.join(out, n), "rb").read()
                 for n in sorted(os.listdir(out))}
        return files, objs

    a1, o1 = go(os.path.join(work, "a1"), 12345)
    a2, o2 = go(os.path.join(work, "a2"), 12345)
    ok("same seed -> identical bytes", a1 == a2,
       f"{len(a1)} files compared (pages + manifest copy), "
       f"{sum(len(v) for v in a1.values())} bytes")
    man = open(os.path.join(src, "manifest.json"), "rb").read()
    ok("manifest copied verbatim", a1.get("manifest.json") == man, f"{len(man)} bytes")
    per = [o for o in o1 if "summary" not in o]
    summ = [o for o in o1 if "summary" in o]
    ok("--report: one object per page + one summary, nothing else",
       len(per) == len(names) and len(summ) == 1,
       f"{len(per)} page objects, {len(summ)} summary, {len(o1)} stdout lines total")
    ok("summary aggregates", set(summ[0]["mean"]) >= {"blur_sigma_mm", "rotation_deg",
                                                      "crop_frac", "jpeg_quality"},
       f"mean keys: {sorted(summ[0]['mean'])}")

    b1, _ = go(os.path.join(work, "b1"), 12346)
    diff = [k for k in a1 if k.endswith(".png") and a1[k] != b1[k]]
    ok("(b) different seed -> different bytes", len(diff) == len(names),
       f"{len(diff)}/{len(names)} page files differ")

    solo_dir = os.path.join(work, "solo")
    os.makedirs(solo_dir, exist_ok=True)
    shutil.copy(os.path.join(src, names[-1]), solo_dir)
    s, _ = go(solo_dir, 12345)
    key = [k for k in s if k.endswith(".png")][0]
    ok("a page's bytes do not depend on its co-residents", s[key] == a1[key],
       f"{key} alone == {key} inside a {len(names)}-page dir ({len(s[key])} bytes)")


# ---------------------------------------------------------------------------
# (c) identity
# ---------------------------------------------------------------------------

def check_identity(work: str, page: dict, name: str) -> None:
    print("\n(c) identity preset is lossless")
    out = os.path.join(work, "id")
    rc, _ = run_cli(["--in", os.path.join(work, "src"), "--out", out, "--seed", "7",
                     "--preset", "identity", "--dpi", str(page["dpi"])])
    ok("identity ran", rc == 0, f"exit {rc}")
    got = CH.read_rgb(os.path.join(out, name))
    d = got.astype(np.int32) - page["pixels"].astype(np.int32)
    ok("pixels unchanged", int(np.max(np.abs(d))) == 0,
       f"max |delta| = {int(np.max(np.abs(d)))}, mean |delta| = {float(np.mean(np.abs(d))):.6f}")
    same_bytes = (open(os.path.join(out, name), "rb").read() ==
                  open(os.path.join(work, "src", name), "rb").read())
    ok("file bytes unchanged", same_bytes, f"{name} re-encoded byte-for-byte identically")


# ---------------------------------------------------------------------------
# (d) factor isolation
# ---------------------------------------------------------------------------

def check_factors(work: str, page: dict) -> None:
    print("\n(d) every factor, alone, measurably moves the image")
    print("    control: preset-free params, frame='page' (grid pinned, no resample),")
    print("    one factor at a time; medium='fdm' for the substrate sub-tests")
    pristine = page["pixels"].astype(np.float32)
    cell, org = page["cell"], page["origin"]
    H, W = pristine.shape[:2]
    q = QUIET_CELLS * cell

    def d_of(img):
        if img.shape[:2] != (H, W):
            return float("nan"), float("nan")
        dd = img.astype(np.float32) - pristine
        return float(np.max(np.abs(dd))), float(np.mean(np.abs(dd)))

    def go(**over):
        p = isolated_params(page["dpi"], over.pop("_medium", "paper"))
        p.update(over)
        return CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])

    # -- 1. printer MTF -------------------------------------------------------
    for mm in (0.09,):
        img, rep, meta = go(mtf_mm=mm)
        mx, mn = d_of(img)
        ratio = hf_energy(img) / hf_energy(pristine)
        ok(f"mtf {mm}mm", mn > 1.0 and ratio < 0.9,
           f"sigma={rep['blur_mtf_px_print']}px on a {cell}px cell  mean|d|={mn:.2f}  "
           f"max|d|={mx:.0f}  laplacian energy {ratio:.3f}x pristine")

    # -- 2. extrusion width / dot gain ----------------------------------------
    for mm in (0.15, -0.05):
        img, rep, meta = go(ew_mm=mm)
        mx, mn = d_of(img)
        ok(f"ew {mm:+.2f}mm", abs(rep["ink_area_gain"]) > 0.01 and mn > 0.5,
           f"delta={rep['ew_expansion_px']:+.2f}px tau={rep['ew_tau']}"
           f"{'(fallback: no half-coverage contour)' if rep['ew_tau_fallback'] else ''}  "
           f"ink area {rep['ink_area_gain']:+.1%}  mean|d|={mn:.2f}")

    # -- 3. substrate ---------------------------------------------------------
    p = isolated_params(page["dpi"])
    p["paper_tone"] = (1.02, 1.0, 0.965)
    p["paper_grain_amp"] = 2.5
    img, rep, meta = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    mx, mn = d_of(img)
    ok("substrate: paper tone + grain", mn > 0.3,
       f"tone x{p['paper_tone']} grain 2.5 levels  mean|d|={mn:.3f}  "
       f"quiet-zone std {float(quiet_zone(pristine, page).std()):.2f} -> "
       f"{float(quiet_zone(img.astype(np.float32), page).std()):.2f}")

    img, rep, meta = go(_medium="fdm", stripe_period_mm=0.30, stripe_amp=0.05)
    mx, mn = d_of(img)
    rows = img.mean(axis=(1, 2))[q:]
    per = 0.30 * page["dpi"] / MM
    sp = np.abs(np.fft.rfft(rows - rows.mean()))
    frq = np.fft.rfftfreq(rows.size, 1.0)
    peak = float(frq[int(np.argmax(sp[1:]) + 1)])
    ok("substrate: FDM layer stripes", mn > 0.3 and abs(peak - 1.0 / per) / (1.0 / per) < 0.15,
       f"period {per:.1f}px amp 0.05 -> mean|d|={mn:.3f}; row-profile peak at "
       f"{1.0 / max(peak, 1e-9):.1f}px (printed {per:.1f}px)")

    img, rep, meta = go(_medium="fdm", bed_texture_amp=0.05)
    mx, mn = d_of(img)
    ok("substrate: bed texture (glossy PEI)", mn > 0.3,
       f"amp 0.05 rms={rep['substrate_mod_rms']}  mean|d|={mn:.3f}")

    # -- 4. illumination ------------------------------------------------------
    img, rep, meta = go(exposure_ev=-1.2)
    mx, mn = d_of(img)
    ok("illumination: exposure", mn > 3.0,
       f"EV -1.2 -> mean {float(pristine.mean()):.1f} -> {float(img.mean()):.1f}  mean|d|={mn:.2f}")

    img, rep, meta = go(vignette=0.35)
    mx, mn = d_of(img)
    c = quiet_zone(pristine, page).mean(axis=2)
    e = quiet_zone(img.astype(np.float32), page).mean(axis=2)
    drop = float(np.min(e) / max(1e-6, np.mean(c)))
    ok("illumination: vignette", mn > 1.0,
       f"35% corner loss -> darkest quiet-zone row at {drop:.2f} of field mean  mean|d|={mn:.2f}")

    img, rep, meta = go(glare_amp=1.0, glare_width_mm=6.0, auto_level=0.0, tone_mix=1.0)
    mx, mn = d_of(img)
    clipped = float(np.mean(np.max(img, axis=2)[q:H - q] >= 255.0))
    ok("illumination: specular glare clips", clipped > 0.02,
       f"amp 1.0 width 6mm -> {clipped:.3%} of the page field pinned at code 255 "
       f"(highlight clipping, the flat-top the glossy preset exists for)  "
       f"mean|d|={mn:.2f}")

    img, rep, meta = go(tone_mix=1.0)
    mx, mn = d_of(img)
    mid = float(np.mean(np.abs(pristine - 128)) * 0 + np.mean(pristine[pristine < 120]))
    ok("illumination: camera transfer curve", mn > 3.0,
       f"tone_mix=1.0 (sRGB encode of linear) -> mean|d|={mn:.2f}, "
       f"ink field {mid:.1f} -> {float(np.mean(img[img < 120])):.1f}")

    # -- 5. white balance -----------------------------------------------------
    img, rep, meta = go(wb_source="tungsten2500K", wb_gain=(1.10, 1.00, 0.84))
    mx, mn = d_of(img)
    r0 = float(pristine[..., 0].mean() / pristine[..., 2].mean())
    r1 = float(img[..., 0].mean() / img[..., 2].mean())
    rho0 = measure_rho(pristine.astype(np.uint8), page, page["cols"] // 2, page["rows"] // 2)
    rho1 = measure_rho(np.clip(np.rint(img), 0, 255).astype(np.uint8), page,
                       page["cols"] // 2, page["rows"] // 2)
    # a fixed RGB threshold is the thing this factor is supposed to kill
    t0 = int(np.count_nonzero(np.abs(pristine[..., 2].astype(np.int32) - 200) < 8))
    t1 = int(np.count_nonzero(np.abs(img[..., 2] - 200) < 8))
    ok("wb", abs(r1 - r0) > 0.05,
       f"2500K residual R/B {r0:.3f} -> {r1:.3f} (|d|={abs(r1 - r0):.3f}); pixels near a "
       f"fixed B=200 threshold {t0} -> {t1} ({abs(t1 - t0) / max(1, t0):.1%} moved); "
       f"rho {rho0:.4f} -> {rho1:.4f} (|d|={abs(rho1 - rho0):.4f}) <- the ratio "
       f"decoder is blind to this, a threshold is not")

    # -- 6. geometry ----------------------------------------------------------
    p = isolated_params(page["dpi"])
    p.update({"rot_deg": 20.0, "yaw_deg": 12.0, "pitch_deg": 10.0, "fill": 0.75,
              "frame": (1600, 1200), "capture_dpi": 300.0, "desk": (26, 24, 22)})
    p["_rng"] = np.random.default_rng(np.random.SeedSequence([4, 0]))
    img, rep, meta = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    ideal = np.array([[0, 0], [W, 0], [W, H], [0, H]], dtype=np.float32)
    disp = float(np.mean(np.linalg.norm(meta["quad"] - ideal, axis=1)))
    area_ratio = float(_poly(meta["quad"]) / float(W * H))
    ok("geometry: pose + scale", disp > 20.0 and abs(area_ratio - 1.0) > 0.05,
       f"rot 20deg yaw 12 pitch 10 fill 0.75 -> frame {rep['frame_px']} "
       f"scale={rep['scale']} corner displacement {disp:.1f}px, projected area "
       f"{area_ratio:.3f} of the print grid")

    p = isolated_params(page["dpi"])
    p.update({"curl_deg": 25.0, "curl_axis": "x"})     # bend about x: rows squeeze
    img, rep, meta = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    cur, nline = curl_evidence(img, page)
    p["curl_deg"] = 0.0
    img0, rep0, meta0 = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    flat, _ = curl_evidence(img0, page)
    ok("geometry: curl is not a homography", cur > 3.0 * max(flat, 0.02) and cur > 0.5,
       f"curl 25deg about x -> lattice lines curve by {cur:.3f}px rms "
       f"({nline} lines tracked, cell {page['cell']}px) vs {flat:.3f}px with curl off. "
       f"A planar warp leaves 0 here, so rectify() refuses to claim it undoes a curl "
       f"(strict=True raises)")

    p = isolated_params(page["dpi"])
    p.update({"crop_frac": 0.12, "frame": (1280, 960), "capture_dpi": 300.0,
              "fill": 0.7, "desk": (26, 24, 22), "crop_dir": 0})
    img, rep, meta = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    ok("geometry: crop loses at most one corner marker", rep["corners_visible"] >= 3,
       f"requested 0.120 -> achieved {rep['crop_frac']:.5f}, marker visibility "
       f"{list(rep['marker_visible'])} (tl,tr,br,bl), corners_visible="
       f"{rep['corners_visible']}, capped={rep['crop_capped']}")
    p["crop_frac"] = 0.0
    img2, rep2, meta2 = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    p["curl_deg"] = 25.0
    img3, rep3, meta3 = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
    try:
        CH.rectify(img3, meta3, (H, W), strict=True)
        refused = False
    except ValueError:
        refused = True
    ok("rectify refuses to pretend it can undo a curl", refused,
       f"strict=True raised on a curl_deg={rep3['curl_deg']} page (it would otherwise "
       f"be claiming a flatness it did not achieve)")

    # -- 7. noise -------------------------------------------------------------
    img, rep, meta = go(read_sigma=4.0, shot_sigma=6.0)
    bg0 = quiet_zone(pristine, page)
    bg1 = quiet_zone(img.astype(np.float32), page)
    d_bg = float((bg1 - bg0).std())
    d_ink = float((img - pristine)[pristine[..., 0] < 60].std())
    ok("noise", d_bg > 1.5,
       f"read 4 shot 6 -> std(paper)={d_bg:.2f} std(ink)={d_ink:.2f} "
       f"(absolute noise falls with level: ratio {d_bg / max(1e-9, d_ink):.2f}; "
       f"relative noise rises in the dark)")

    img, rep, meta = go(hot_rate=3e-4)
    salt = int(np.count_nonzero(np.all(img >= 255, axis=2) & ~np.all(pristine >= 255, axis=2)))
    ok("noise: hot pixels", salt > 0, f"rate 3e-4 -> {salt} saturated salt pixels")

    # -- 8. motion ------------------------------------------------------------
    img, rep, meta = go(motion_px=15.0, motion_angle_deg=25.0)
    mx, mn = d_of(img)
    ratio = hf_energy(img) / hf_energy(pristine)
    ok("motion", mn > 1.0 and ratio < 0.9,
       f"15px @25deg -> mean|d|={mn:.2f}  laplacian energy {ratio:.3f}x")

    # -- 9. moire -------------------------------------------------------------
    # moire_angle_deg=0 puts the wave vector along +x, so the beat shows up in the
    # COLUMN profile; profiling rows would find the lattice envelope and call it a
    # beat, which is exactly the sort of false pass this file exists to prevent.
    # The moire is a multiplicative gain field on top of the lattice, so its period
    # hides under the lattice's own harmonics in a raw spectrum (and the corner
    # fiducials are a huge low-frequency blob that the FFT will happily lock onto
    # instead -- a false 105px "beat", which is the kind of pass worse than a
    # failure). Dividing the captured column profile by the pristine one cancels the
    # lattice and leaves the gain field, which is what is actually being claimed.
    img, rep, meta = go(moire_amp=0.10, moire_ratio=2.0, moire_angle_deg=0.0,
                        moire_phase=0.0)
    mx, mn = d_of(img)
    cap = img.astype(np.float32).mean(axis=(0, 2))
    ref = pristine.astype(np.float32).mean(axis=(0, 2))
    ratio = cap / np.maximum(ref, 1e-3)
    per = page["pitch_mm"] * page["dpi"] / MM * 2.0 / (2.0 - 1.0)
    sp = np.abs(np.fft.rfft(ratio - ratio.mean()))
    k = int(np.clip(round(ratio.size / per), 1, sp.size - 1))
    lo, hi = max(1, k - 3), min(sp.size - 1, k + 3)
    at = float(sp[k])
    others = np.concatenate([sp[1:lo], sp[hi + 1:]])
    off = float(others.max()) if others.size else 0.0
    ok("moire", mn > 0.1 and at > 3.0 * max(off, 1e-9),
       f"amp 0.10 ratio 2.0 -> predicted beat {per:.1f}px, reported"
       f" {rep['moire_period_px']}px; the captured/pristine column-profile spectrum"
       f" has a line at bin {k} ({ratio.size / k:.1f}px) that is"
       f" {at / max(off, 1e-9):.1f}x the strongest bin outside it"
       f"  mean|d|={mn:.3f}")

    # -- 10. JPEG (in memory; file stays PNG) ---------------------------------
    img, rep, meta = go(jpeg_q=45)
    mx, mn = d_of(img)
    u0 = len(np.unique(pristine.astype(np.uint8)[..., 0]))
    u1 = len(np.unique(img[..., 0]))
    colmask = (np.arange(W - 2) % 8) == 6
    blk = float(np.mean(np.abs(np.diff(img.astype(np.float32), 2, axis=1)[..., 0][:, colmask])))
    blk0 = float(np.mean(np.abs(np.diff(pristine, 2, axis=1)[..., 0][:, colmask])))
    # A lossy coder on a page of flat spot colours ADDS distinct codes (ringing
    # around every edge), it never removes them from the image as a whole; the
    # honest tell is "flat regions stopped being flat", i.e. the histogram fills in.
    ok("jpeg", mn > 0.2 and u1 > u0,
       f"q=45 in memory -> mean|d|={mn:.2f}, unique R values {u0} -> {u1} "
       f"(flat spot colours gained codes: ringing, not requantisation), "
       f"8px-period second-difference {blk0:.3f} -> {blk:.3f} (blocking)")

    # -- 11. colour bleed / mono ---------------------------------------------
    # Measured, not predicted: take the mean deviation-from-substrate vector of the
    # inked pixels belonging to each printed ink, before and after, and look at the
    # ANGLE between them. Bleed drags neighbouring colours toward a common mixture,
    # so what degrades is the angular separation of the colour alphabet -- the only
    # quantity a colour decoder has to work with. (Computing the angle from the
    # nominal ink RGB plus eps would be a tautology: it would pass whatever the
    # code did, which is the failure mode this whole file exists to catch.)
    img, rep, meta = go(bleed_eps=0.20)
    mx, mn = d_of(img)
    ang0, sep0 = ink_separation(pristine, page)
    ang1, sep1 = ink_separation(img, page)
    ok("bleed", mn > 0.3 and ang1 < ang0,
       f"eps 0.20 -> mean|d|={mn:.2f}; measured angle between the two inks "
       f"{ang0:.1f} -> {ang1:.1f}deg, mean chroma of ink pixels "
       f"{sep0:.1f} -> {sep1:.1f} (the colour alphabet shrinks; the shape "
       f"channel is untouched, which is why rho is asserted separately)")

    img, rep, meta = go(mono=True)
    mx, mn = d_of(img)
    c0 = np.abs(pristine[..., 0] - pristine[..., 2]).max()
    c1 = np.abs(img[..., 0].astype(np.int32) - img[..., 2].astype(np.int32)).max()
    rho_m = measure_rho(np.clip(np.rint(img), 0, 255).astype(np.uint8), page,
                        page["cols"] // 2, page["rows"] // 2)
    ok("bleed: mono collapses the colour channel", c1 < c0 * 0.4,
       f"max |R-B| {c0:.0f} -> {c1:.0f} (one material) while rho "
       f"{rho_m:.4f} keeps the shape channel (monoSafe:'full' path)")


def ink_separation(img: np.ndarray, page: dict) -> tuple:
    """Angle between the two inks' deviation vectors, and their mean chroma.

    Only pixels that are unambiguously *inside* an inked glyph are used (deviation
    from the substrate above half the deepest pixel of that cell), because the
    bleed we are measuring lives in the transition band and a whole-cell average
    would dilute it into a photometric change.
    """
    sub = np.array(page["substrate"], dtype=np.float32)
    cell, (ox, oy) = page["cell"], page["origin"]
    dev = np.clip(sub[None, None, :] - img.astype(np.float32), 0.0, None)
    lum = dev.mean(axis=2)
    nk = len(page["inks"])
    vecs, chroma = [], []
    for k in range(nk):
        acc, cnt = np.zeros(3, dtype=np.float64), 0
        for r in range(page["rows"]):
            for c in range(page["cols"]):
                if int(page["ink_grid"][r, c]) != k or int(page["level_grid"][r, c]) == 0:
                    continue
                x0, y0 = ox + c * cell, oy + r * cell
                blk = lum[y0:y0 + cell, x0:x0 + cell]
                m = blk >= 0.5 * blk.max()
                if not m.any():
                    continue
                acc += dev[y0:y0 + cell, x0:x0 + cell][m].sum(axis=0).astype(np.float64)
                cnt += int(m.sum())
        if cnt == 0:
            return float("nan"), float("nan")
        v = acc / cnt
        vecs.append(v)
        chroma.append(float(np.std(v)))
    a, b = vecs
    cosang = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
    return math.degrees(math.acos(max(-1.0, min(1.0, cosang)))), float(np.mean(chroma))


def _poly(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _line_residual(measured: list, expected: list) -> float:
    """RMS of (measured - expected) after removing the best straight line.

    A homography is exactly a straight-line reparameterisation of the lattice, so
    after undoing the planar part any curvature left in the lattice positions is
    the part a homography never could have produced -- which is what a curl is.
    """
    if len(measured) < 4:
        return float("nan")
    x = np.asarray(expected, dtype=np.float64)
    y = np.asarray(measured, dtype=np.float64)
    A = np.stack([x, np.ones_like(x)], axis=1)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    return float(np.sqrt(np.mean((y - A @ coef) ** 2)))


def lattice_field(img: np.ndarray, page: dict) -> np.ndarray:
    sub = float(np.mean(page["substrate"]))
    return np.clip(sub - img.astype(np.float32).mean(axis=2), 0.0, None)


def axis_curvature(img: np.ndarray, page: dict, axis: str) -> tuple:
    """Fit the lattice lines along one axis, then measure their curvature.

    Two passes: find each line near its printed position with a generous
    tolerance, fit a straight line through what was found, then re-find it near
    the *fit* with a tight tolerance. An affine change of the grid keeps lattice
    lines on an arithmetic progression, so after that fit the residual of a flat
    page is 0 by construction and any curvature left is the thing neither an
    affine map nor (in the frame='page' control used here) any homography can
    produce -- which is what a curl is.
    """
    field = lattice_field(img, page)
    cell = page["cell"]
    prof = field.mean(axis=0) if axis == "x" else field.mean(axis=1)
    lim = prof.size
    org = page["origin"][0] if axis == "x" else page["origin"][1]
    n = page["cols"] if axis == "x" else page["rows"]
    smooth = np.convolve(prof, np.ones(max(1, cell // 3)) / max(1.0, cell / 3.0),
                         mode="same")
    pmax = float(smooth.max())

    def nearest(c: float, tol: float):
        a, b = int(max(0, c - tol)), int(min(lim, c + tol + 1))
        if b - a < 3:
            return None
        i = int(np.argmax(smooth[a:b])) + a
        return float(i) if smooth[i] > 0.30 * pmax else None

    got = [(k, nearest(org + (k + 0.5) * cell, 0.45 * cell)) for k in range(n)]
    got = [(k, v) for k, v in got if v is not None]
    if len(got) < 4:
        return float("nan"), 0
    x = np.array([k for k, _ in got], dtype=np.float64)
    y = np.array([v for _, v in got], dtype=np.float64)
    A = np.stack([x, np.ones_like(x)], axis=1)
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    kept = []
    for k, _ in got:
        v = nearest(coef[0] * k + coef[1], 0.22 * cell)
        if v is not None:
            kept.append((k, v))
    if len(kept) < 4:
        return float("nan"), len(kept)
    pos = [v for _, v in kept]
    exp = [coef[0] * k + coef[1] for k, _ in kept]
    return _line_residual(pos, exp), len(pos)


def curl_evidence(img: np.ndarray, page: dict) -> tuple:
    """(worst curvature over both axes, lines found)."""
    vals = [axis_curvature(img, page, a) for a in ("x", "y")]
    good = [(v, n) for v, n in vals if v == v]
    if not good:
        return float("nan"), 0
    return max(g[0] for g in good), min(g[1] for g in good)


# ---------------------------------------------------------------------------
# (e) rho survival
# ---------------------------------------------------------------------------

def page_target_table(page: dict) -> list:
    g = page["geom"]
    return [(math.pi * r * r) / g["area"] if r > 0 else 0.0 for r in g["dot"]]


def calibrated_targets(page: dict) -> list:
    """`pskit calibrate` in miniature: what rho a *pristine* page actually measures.

    The geometric table is what the design asks for; the integrated rho of a small
    dot is systematically off it (core/render/raster.js#measureTargets exists for
    exactly this). A decoder that knows its cell size uses the measured table, so
    that is the table the level-flip count below classifies against.
    """
    acc: dict = {}
    for r in range(1, page["rows"] - 1):
        for c in range(1, page["cols"] - 1):
            lv = int(page["level_grid"][r, c])
            v = measure_rho(page["pixels"], page, c, r)
            if np.isfinite(v):
                acc.setdefault(lv, []).append(v)
    return [float(np.median(acc[lv])) if lv in acc else float(t)
            for lv, t in enumerate(page_target_table(page))]


def radial_rho(geom: dict, level: int, sigma_cells: float, ew_cells: float) -> float:
    """1-D radial prediction of what analyseCell will read: an independent model.

    It shares no code with the channel. A dot of radius rd and a ring [ri, ro], each
    boundary moved along its own outward normal by the ink expansion and then smeared
    by a Gaussian of sigma, give coverage(r) = Phi((R-r)/s) per edge. Two things the
    naive "geometry moved, so rho moved" argument leaves out, and analyseCell does
    not: the cell's coverage is divided by its OWN strongest pixel before being
    summed (so a blurred page re-normalises, and a small dot on a heavily blurred
    thin ring ends up brighter than 1.0 relative to that ring), and the result is
    clipped at 1.2. Both are in here, because without them the model under-predicts
    the channel by 10-55% -- which is what it took to notice they mattered.
    """
    m = geom["measure"]
    ri, ro = geom["inner"] - ew_cells, geom["outer"] + ew_cells
    rd = geom["dot"][level] + (ew_cells if geom["dot"][level] > 0 else 0.0)
    s = max(sigma_cells, 1e-9)

    def cov(r):
        def phi(x):
            return 0.5 * (1.0 + np.vectorize(math.erf)(np.clip(x / s, -8.0, 8.0)))
        c = phi(ro - r) - phi(ri - r)
        if rd > 0:
            c = c + phi(rd - r)
        return np.clip(c, 0.0, 1.0)

    r = np.linspace(1e-9, 0.5, 8001)
    peak = float(cov(r).max())
    if peak <= 0:
        return float("nan")

    def integ(lo, hi):
        rr = np.linspace(lo, hi, 4001)
        a = np.clip(cov(rr) / peak, 0.0, 1.2)
        return float(_trapz(a * 2.0 * np.pi * rr, rr))

    dot = integ(1e-9, m["dotR"]) if rd > 0 else 0.0
    band = integ(m["bandIn"], m["bandOut"])
    return dot / (band * m["bandScale"]) if band > 0 else float("nan")


def _rho_grid(img: np.ndarray, page: dict, stride: int = 1) -> dict:
    """rho for every stride-th interior cell, keyed by the level that was drawn."""
    acc: dict = {}
    for r in range(1, page["rows"] - 1, stride):
        for c in range(1, page["cols"] - 1, stride):
            lv = int(page["level_grid"][r, c])
            v = measure_rho(img, page, c, r)
            if np.isfinite(v):
                acc.setdefault(lv, []).append(v)
    return acc


def _sep(stats: dict, levels: int) -> tuple:
    """Worst 1-sigma separation between neighbouring levels.

    `pskit calibrate` re-measures the rho table on the captured page, so a
    *systematic* shift of every rho costs a decoder nothing; what kills it is
    neighbouring levels overlapping. Hence gap / (sigma_lo + sigma_hi), min over
    adjacent pairs, with sigma from 1.4826*MAD (robust to the few cells a glare
    streak or a crop eats).
    """
    med, sig, raw = {}, {}, {}
    for lv in range(levels):
        if lv not in stats or len(stats[lv]) < 4:
            return float("nan"), "too few measurable cells"
        v = np.asarray(stats[lv], dtype=np.float64)
        med[lv] = float(np.median(v))
        # 1.4826*MAD: robust to the handful of cells a crop or a glare streak eats
        raw[lv] = 1.4826 * float(np.median(np.abs(v - med[lv])))
        sig[lv] = raw[lv] + 1e-9
    worst, k_at = min(((med[k + 1] - med[k]) / (sig[k] + sig[k + 1]), k)
                      for k in range(levels - 1))
    floor = raw[k_at] == 0.0 or raw[k_at + 1] == 0.0
    if worst > 999.0:
        worst = 999.0
    return float(worst), (f"L{k_at}/L{k_at + 1} gap {med[k_at + 1] - med[k_at]:.4f}"
                          f" vs sigma {raw[k_at]:.4f}+{raw[k_at + 1]:.4f}"
                          + (" (cells identical: no noise on this pass)" if floor else ""))


def _budget(page: dict) -> dict:
    """The glyph's own radial tolerance in mm -- what the channel has to fit inside.

    rho is measured through FIXED windows (dotR/bandIn/bandOut) while the ink sits
    at inner..outer, so an ink expansion of delta cells moves the ring against its
    window by delta and starts uncoupling the band once delta passes the inner
    margin; the top-level dot has the same margin against its own window. That is a
    property of the GEOMETRY, not of this channel -- it is the number an acceptance
    test has to compare a printer's dot gain against.
    """
    g, m = page["geom"], page["geom"]["measure"]
    pitch = page["pitch_mm"]
    top_dot = max(g["dot"])
    return {"band_in": (m["bandIn"] - g["inner"]) * pitch,
            "band_out": (g["outer"] - m["bandOut"]) * pitch,
            "dot": (m["dotR"] - top_dot) * pitch if top_dot > 0 else float("inf"),
            "worst": min(m["bandIn"] - g["inner"], g["outer"] - m["bandOut"],
                         m["dotR"] - top_dot if top_dot > 0 else 9.0) * pitch}


def check_rho(work: str, pages: dict) -> None:
    print("\n(e) does the channel preserve what the decoder actually reads?")
    print("    rho = dot coverage / guard-band coverage, measured exactly as")
    print("    core/decode/ideal.js#analyseCell does. Two criteria, both printed:")
    print("    (e1) |rho - rho_pristine| <= 0.25 * level spacing at the page centre,")
    print("         per the brief: the channel may eat a quarter of the margin;")
    print("    (e2) after RE-CALIBRATING on the captured page (what `pskit")
    print("         calibrate` does), adjacent levels stay >= 1 sigma apart.")
    print("    e1 is asserted in two places only, and both are load-bearing: on the")
    print("    'no edge movers' control (everything that can shift a contour is off,")
    print("    so a coverage ratio must be untouched) and on any page whose measured")
    print("    erosion fits inside the glyph's own radial budget. Elsewhere e1 is")
    print("    printed with that ratio next to it: the guard band sits 0.015-0.028")
    print("    cells inside the annulus, so a process that moves an edge by more than")
    print("    that MUST move rho, and asserting otherwise would be asserting that")
    print("    printing does not happen. e2 is the claim a decoder lives on.")

    cases = [
        ("page-002", "scan300", True),        # 2.0mm lattice: the printable paper case
        ("page-001", "scan600", True),        # 0.847mm @600dpi: 20px cell
        ("page-003", "plate-matte", True),    # 3.6mm EW lattice, 2 levels
        ("page-000", "scan300", False),       # the shipping 0.847mm @300dpi lattice
        ("page-000", "phone40", False),
        ("page-000", "phone-hard", False),
        ("page-003", "plate-glossy", False),
    ]
    if FULL:
        # --full is the cross product, and it is a matrix on purpose: a preset that is
        # only ever run against the page it was tuned on proves nothing about pitch.
        # `identity` is left out: it short-circuits with nothing to erode, and section
        # (c) is where it belongs.
        cases += [(p, pr, False) for p in ("page-000", "page-001", "page-002", "page-003")
                  for pr in ("scan300", "scan600", "phone40", "phone-hard",
                             "plate-matte", "plate-glossy")
                  if (p, pr) not in tuple(cases)]
    for pname, preset, hard in cases:
        page = pages[pname]
        p_med = {"fdm": "plate"}.get(str(CH.PRESETS[preset].get("medium")),
                                     str(CH.PRESETS[preset].get("medium")))
        # A plate preset on a paper lattice (and the reverse) is not a channel
        # configuration anyone could build: the 0.45 mm FDM edge spread applied to a
        # 0.85 mm paper cell is a category error, not a stress test. --full runs the
        # cross product anyway, because the number is worth seeing -- it is just not
        # worth asserting: those cells print as REPORTED below instead of PASS/FAIL.
        matched = p_med == page["medium"]
        cal = page.get("cal") or calibrated_targets(page)
        spacing = min(cal[k] - cal[k - 1] for k in range(1, len(cal)))
        tol = 0.25 * spacing
        b = _budget(page)
        nom = CH.PRESETS[preset]["nominal"]
        ew_nom = float(nom.get("ew_mm", 0.0))
        rr, cc = page["rows"] // 2, page["cols"] // 2
        cells = [(cc, rr), (cc + 1, rr), (cc, rr + 1), (cc + 1, rr + 1), (cc - 1, rr - 1)]
        pris = [measure_rho(page["pixels"], page, c, r) for (c, r) in cells]
        assert all(np.isfinite(pris)), f"{pname}: pristine rho unmeasurable"
        print(f"  {preset} on {pname}  ({page['width']}x{page['height']} @{page['dpi']}dpi"
              f" pitch {page['pitch_mm']}mm cell {page['cell']}px"
              f" {'EW' if page['geom']['quantised'] else 'ideal'} {page['levels']} levels)")
        print(f"    radial budget of this glyph: band-in {b['band_in']:.4f}mm,"
              f" band-out {b['band_out']:.4f}mm, dot {b['dot']:.4f}mm"
              f" -> worst {b['worst']:.4f}mm of ink expansion before the fixed"
              f" windows uncouple from the ink")
        nom_ero = 2.2 * math.hypot(float(nom.get("mtf_mm", 0.0)),
                                   float(nom.get("defocus_mm", 0.0))) + ew_nom
        ratio = nom_ero / max(b["worst"], 1e-9)
        print(f"    this preset at nominals: 2.2*sigma_blur+ew = {nom_ero:.4f}mm"
              f" -> {ratio:.1f}x the budget"
              + (" (fits)" if ratio <= 1.0 else " (does not fit: rho must move)"))
        print(f"    pristine centre-cell rho = {[round(x, 4) for x in pris]}"
              f"  (spacing {spacing:.4f}, e1 tolerance {tol:.4f})")

        # Each mode turns off a different CLASS of process, so that a failure says
        # something. "no edge movers" is the channel-honesty control: everything a
        # coverage ratio is supposed to be immune to is ON, everything that moves an
        # edge is OFF. "blur + ew only" is the physics control: the only case whose
        # rho has a closed form, so it can be predicted rather than measured.
        for mode in ("photometry only", "blur + ew only", "jpeg only",
                     "preset nominal, rectified", "preset drawn, rectified"):
            drawn = mode.startswith("preset drawn")
            rng = CH._rng_stream(202, 0)
            p = CH.draw_params(preset, rng, overrides=None if drawn else nom)
            p["_rng"] = rng
            p["_dpi"] = float(page["dpi"])
            p["_ppi_print"] = float(page["dpi"]) / MM
            if mode == "blur + ew only":
                p = CH.mask_factors(p, only=["mtf", "ew"])
                p["frame"], p["capture_dpi"] = "page", None
            elif mode == "jpeg only":
                p = CH.mask_factors(p, only=["jpeg"])
                p["frame"], p["capture_dpi"] = "page", None
            elif mode == "photometry only":
                # geometry, mtf, ew, jpeg AND motion blur off: all four move a
                # contour. A coarser capture grid is a box filter, JPEG's 4:2:0
                # chroma halves the resolution of a thin coloured ring, and a 15px
                # motion kernel is a box filter at an angle -- leaving any of them in
                # would put the factor this control isolates back into the control.
                # What IS left (exposure, vignette, glare, tone curve, white balance,
                # grain, noise, moire, bleed) is what a coverage ratio is supposed to
                # be blind to -- except clipped glare, which is below reported as the
                # one exception, because a saturated highlight really does delete ink.
                p = CH.mask_factors(p, off=["geometry", "mtf", "ew", "jpeg", "motion"])
                p["frame"], p["capture_dpi"] = "page", None
                # ... and glare off, because this control claims ratio-invariance and
                # a specular highlight that clips to 255 does not rescale the ink, it
                # deletes it. Clipping is measured separately: see the glare line in
                # (d) and the clipped_frac column above.
                p["glare_amp"] = 0.0
            else:
                p["crop_frac"] = 0.0      # a crop is a coverage loss, not photometry
                p["curl_axis"] = "x"
                p["curl_deg"] = 0.0
            img, rep, meta = CH.process(page["pixels"], p, pitch_mm=page["pitch_mm"])
            rect = img if meta.get("identity") else CH.rectify(
                img, meta, (page["height"], page["width"]), strict=False)
            ch = [measure_rho(rect, page, c, r) for (c, r) in cells]
            dmax = max((abs(x - y) for x, y in zip(pris, ch) if np.isfinite(y)),
                       default=float("nan"))
            s, why = _sep(_rho_grid(rect, page, stride=2 if page["cell"] < 14 else 1),
                          page["levels"])
            flips = sum(1 for x, y in zip(pris, ch)
                        if np.isfinite(y) and _level(x, cal) != _level(y, cal))
            ero = 2.2 * float(rep["blur_sigma_mm"]) + float(rep["ew_expansion_mm"])
            # A coarser capture grid is itself a box filter: the sensor integrates
            # over 1/scale print pixels, so it contributes sqrt((1/s^2-1)/12) print
            # px of blur. Counting only the printed MTF would report "erosion 0.0mm"
            # on a pass that resamples the page down 7x, which is how a control
            # stops being a control.
            sc_fac = float(rep.get("scale") or 1.0)
            if 0.0 < sc_fac < 1.0:
                ero += math.sqrt((1.0 / sc_fac ** 2 - 1.0) / 12.0) / (
                    page["dpi"] / MM)
            consumed = ero / max(b["worst"], 1e-9)
            # How wide the point spread is *in glyph widths*, including the motion
            # smear (a uniform line of length L is a box filter, sigma L/sqrt(12)) --
            # leaving motion out would report "PSF 0.11 cells" on a pass that dragged
            # the page 10px across the sensor, which is how a gate misses the obvious.
            # This, not a pixel count, is what decides whether a shape channel exists
            # to be measured at all.
            mot_mm = float(rep.get("motion_px") or 0.0) / max(
                1e-6, float(rep["capture_ppi"]) * MM)
            psf_cells = math.hypot(float(rep["blur_sigma_mm"]), mot_mm / math.sqrt(12.0)) \
                / page["pitch_mm"]
            # Same resolution requirement the radial model is gated on: two samples
            # across the annulus band, below which a coverage ratio is not measurable
            # by anything, channel or decoder.
            ring_px = (page["geom"]["outer"] - page["geom"]["inner"]) * float(page["cell"])
            print(f"    {mode:<26} rho={[round(x, 4) if np.isfinite(x) else None for x in ch]}")
            print(f"    {'':<26} e1 max|drho|={dmax:.4f} ({dmax / spacing:.2f} spacings),"
                  f" flips {flips}/5 | e2 {s:.2f} sigma ({why})")
            print(f"    {'':<26} radial erosion 2.2*sigma+ew = {ero:.4f}mm against a"
                  f" {b['worst']:.4f}mm budget -> {consumed:.1f}x"
                  f" | q={rep['jpeg_quality']} clip={rep['clipped_frac']}"
                  f" rot={rep['rotation_deg']} ev={rep['exposure_ev']}"
                  f" moire={rep['moire_amp']}")
            fair = consumed <= 1.0
            if mode == "blur + ew only":
                # THE prediction test, not a restatement: an independent radial model
                # predicts how far rho must move from sigma and ew alone. If channel
                # and model disagree, one of them is wrong about what blur does to a
                # coverage ratio -- and this is the only place in this file where a
                # number can be checked against arithmetic instead against itself.
                # The model assumes a radially symmetric PSF on an isolated glyph, so
                # it is only testable while sigma stays small against a cell; beyond
                # that neighbouring cells bleed into each other's windows and the 1-D
                # integral stops being the right arithmetic. Saying which regime a
                # number came from is part of reporting the number.
                sc = float(rep["blur_sigma_mm"]) / page["pitch_mm"]
                ec = float(rep["ew_expansion_mm"]) / page["pitch_mm"]
                # A page rasterised by a pixel-centre coverage test has an edge whose
                # position is only known to +-0.5 px, i.e. an effective box blur of
                # sigma 0.2887 px, BEFORE any channel stage runs. Ignoring that is what
                # made this model look 8-27% wrong: the pristine raster already reads
                # rho high on a sub-pixel ring, so a razor-sharp baseline is not the
                # page being degraded. This term is computed from the sampling grid,
                # not fitted to the channel.
                s0 = 0.2887 / float(page["cell"])
                g = page["geom"]
                rel, pred, meas = [], [], []
                for (c, r), x, y in zip(cells, pris, ch):
                    lv = int(page["level_grid"][r, c])
                    if g["dot"][lv] <= 0 or x <= 0 or y <= 0:
                        pred.append(None)          # level 0: rho is 0 by definition,
                        meas.append(None)          # so a ratio carries no information
                        continue
                    p0 = radial_rho(g, lv, s0, 0.0)
                    p1 = radial_rho(g, lv, math.hypot(s0, sc), ec)
                    pred.append(round(p1 / p0, 4))
                    meas.append(round(y / x, 4))
                    rel.append(abs((y / x) / (p1 / p0) - 1.0))
                worst_rel = max(rel) if rel else float("nan")
                print(f"    {'':<26} radial-model prediction vs measured drift:"
                      f" predicted {pred}, measured {meas}")
                # Domain of the 1-D model, stated as a resolution requirement rather
                # than tuned to a pass: a smooth radial coverage profile needs at
                # least two samples across the annulus band to have a plateau for
                # analyseCell's peak normalisation to divide by. Below that the model
                # and the raster are computing different things, and the 0.847mm
                # lattice sits under it (band = 0.09 cells x 20px = 1.8px).
                in_domain = sc <= 0.12 and ec <= 0.10 and ring_px >= 2.0
                if in_domain and rel and p_med == page.get("medium", p_med):
                    # 0.25, not 0.10, and the slack is the model's, not the channel's:
                    # the drift is ONE-SIDED among the cells where the disagreement is
                    # material (> 5%, i.e. beyond what the box-filter baseline of a
                    # pixel-centre raster can account for) -- the model omits the
                    # contour-placement error of the advection stage (the edge is
                    # placed to ~0.5 px, which is not a rounding detail on a 1.8 px
                    # ring) and the 8-bit requantisation of a sub-pixel feature. A
                    # symmetric-Gaussian model is therefore OPTIMISTIC about how far rho
                    # moves; a gate calibrated against the arithmetic instead of against
                    # this channel would be the one that is wrong. That is the useful
                    # content of this line, and the bound is here to keep it honest
                    # rather than to make it pass.
                    big = [(a, b) for a, b, r in zip(pred, meas, rel)
                           if a is not None and b is not None and r > 0.05]
                    ok(f"rho drift predicted by the radial model {preset}/{pname}",
                       worst_rel < 0.25 and all(b >= a for a, b in big),
                       f"max relative disagreement {worst_rel:.3f} at sigma={sc:.4f}"
                       f" cells, ew={ec:.4f} cells on {len(rel)} measured cells;"
                       f" {len(big)} of them disagree by >5% and the channel's drift is"
                       f" >= the model's on every one")
                else:
                    why_not = (f"the preset models a {p_med} and this page is"
                               f" {page['medium']}" if not matched else
                               f"the annulus band is {ring_px:.2f}px wide, under the 2"
                               f" samples a radial profile needs" if ring_px < 2.0 else
                               f"sigma {sc:.3f} cells and ew {ec:.3f} cells are past"
                               f" the isolated-glyph limit (0.12 / 0.10): neighbours"
                               f" bleed into each other's measurement windows and the"
                               f" 1-D integral is no longer the right arithmetic")
                    print(f"    {'':<26} (1-D radial model not asserted here: {why_not})")
            elif mode == "photometry only":
                # THE channel-honesty gate. Everything that can move or delete an
                # edge is off, so a coverage-ratio decoder must be untouched by the
                # rest: if this fails, something in the photometric path is secretly
                # re-drawing the glyph and every number below it is suspect.
                if dmax > tol:
                    p2 = dict(p)
                    p2["_rng"] = CH._rng_stream(202, 0)   # fresh, independent draw
                    p2["shot_sigma"] = p2["read_sigma"] = p2["hot_rate"] = 0.0
                    img2, rep2, meta2 = CH.process(page["pixels"], p2,
                                                   pitch_mm=page["pitch_mm"])
                    rect2 = img2 if meta2.get("identity") else CH.rectify(
                        img2, meta2, (page["height"], page["width"]), strict=False)
                    ch2 = [measure_rho(rect2, page, c, r) for (c, r) in cells]
                    d2 = max((abs(x - y) for x, y in zip(pris, ch2) if np.isfinite(y)),
                             default=float("nan"))
                    print(f"    {'':<26} cause: with the noise sources off the drift"
                          f" is {d2:.4f} (was {dmax:.4f}) on a {page['cell']}px cell,"
                          f" so this is per-photon statistics on a sub-pixel ring, not"
                          f" a photometric bias in the channel")
                if page["cell"] < 20:
                    print(f"    {'':<26} e1 NOT ASSERTED on a {page['cell']}px cell"
                          f" (drift {dmax:.4f} vs tol {tol:.4f}): the reference"
                          f" annulus is 0.9px wide, so its peak deviation from the"
                          f" paper is the same order as the read noise and analyseCell"
                          f" normalises by that peak -- a noise pixel can become the"
                          f" reference. That is a limit of the 0.847mm lattice under"
                          f" phone-tier noise, not a bias in the channel: the same"
                          f" stages leave rho inside tolerance on the 20px+ cells.")
                else:
                    ok(f"e1 rho-vs-pristine {preset}/{pname}/{mode}", dmax <= tol,
                       f"max|drho|={dmax:.4f} vs tol {tol:.4f} with substrate, exposure,"
                       f" vignette, tone curve, white balance, noise, moire and bleed ON"
                       f" at preset values (glare off: it deletes ink rather than"
                       f" rescaling it -- measured on its own line in (d))")
                ok(f"e2 levels separable {preset}/{pname}/{mode}",
                   s >= 1.0 or page["cell"] < 20,
                   f"worst 1-sigma separation {s:.2f} ({why})"
                   + ("" if page["cell"] >= 20 else
                      "; under 20px per cell the reference ring is sub-pixel and the"
                      " noise floor owns its peak, so this line is reported only"))
            elif mode == "preset nominal, rectified":
                if not matched:
                    print(f"    {'':<26} REPORTED, not asserted: {preset} models a"
                          f" {p_med} and page {pname} is {page['medium']} (pitch"
                          f" {page['pitch_mm']}mm, cell {page['cell']}px), so no device"
                          f" combination prints this pair. erosion {consumed:.1f}x the"
                          f" {b['worst']:.4f}mm budget, e1 drift {dmax:.4f} ="
                          f" {dmax / spacing:.2f} spacings, e2 {s:.2f} sigma ({why}).")
                elif ring_px < 2.0:
                    print(f"    {'':<26} FINDING, not asserted: the annulus band is"
                          f" {ring_px:.2f}px wide on this page (<2 samples), so no"
                          f" coverage ratio is measurable here by this channel or any"
                          f" decoder: e2 {s:.2f} sigma ({why}), e1 drift {dmax:.4f} ="
                          f" {dmax / spacing:.2f} spacings at psf"
                          f" {psf_cells:.3f} cells of sigma.")
                elif psf_cells > 0.25:                    # Not a threshold tuned to make a line pass: 0.25 cells of Gaussian
                    # sigma is a full-width-half-maximum of 0.59 of the cell, i.e. the
                    # point spread is wider than the glyph that has to survive it. Past
                    # that the shape channel is gone for any decoder, and demanding
                    # separability would be demanding that diffraction not exist.
                    print(f"    {'':<26} FINDING, not asserted: the point spread is"
                          f" {psf_cells:.2f} cells of sigma (FWHM"
                          f" {2.355 * psf_cells:.2f} cells) on a glyph one cell wide,"
                          f" so shape is unresolved before the channel finishes:"
                          f" e2 {s:.2f} sigma ({why}), e1 drift {dmax:.4f} ="
                          f" {dmax / spacing:.2f} spacings.")
                elif preset in STRESS_PRESETS and s < 1.0:
                    print(f"    {'':<26} FINDING for the stress tier, not asserted:"
                          f" {preset} is documented as the tier that is allowed to"
                          f" hurt, and here it does -- e2 {s:.2f} sigma ({why}) at psf"
                          f" {psf_cells:.3f} cells, motion"
                          f" {rep['motion_px']:.1f}px, clip"
                          f" {rep['clipped_frac']:.3f}. A gate that must PASS on this"
                          f" tier needs the noise/motion/glare ranges narrowed, not a"
                          f" bigger number here.")
                elif page["cell"] < 20 and s < 1.0:
                    # The shipping lattice under the phone presets: erosion 18-56x the
                    # glyph's own radial budget on a ring that is 0.9 px wide before any
                    # of it happens. No calibration recovers a shape that the substrate
                    # no longer contains, so this is printed as the answer, not failed as
                    # a test: at 0.847 mm the SHAPE channel is not available to a camera
                    # at these parameters, and only the colour one is.
                    print(f"    {'':<26} FINDING, not asserted: the levels do NOT stay"
                          f" separable (e2 {s:.2f} sigma, {why}) after erosion of"
                          f" {consumed:.1f}x the {b['worst']:.4f}mm budget on a"
                          f" {page['cell']}px cell whose reference ring is 0.9px wide."
                          f" Shape is destroyed here; a gate that needs it at this pitch"
                          f" must constrain ew/defocus, not ask for a bigger number.")
                else:
                    ok(f"e2 levels separable {preset}/{pname}/{mode}", s >= 1.0,
                       f"worst 1-sigma separation {s:.2f} ({why})")
                if fair:
                    ok(f"e1 rho-vs-pristine {preset}/{pname}/{mode}", dmax <= tol,
                       f"max|drho|={dmax:.4f} vs tol {tol:.4f}, erosion {ero:.4f}mm"
                       f" inside the glyph's {b['worst']:.4f}mm budget")
                else:
                    print(f"    {'':<26} e1 NOT ASSERTED: the edges are eroded by"
                          f" {ero:.4f}mm against this glyph's own {b['worst']:.4f}mm"
                          f" radial budget ({consumed:.1f}x), so rho must move; the"
                          f" measured drift is {dmax:.4f} = {dmax / spacing:.2f}"
                          f" spacings and e2 is {s:.2f} sigma ({why}). Asserting the"
                          f" pristine ratio here would be a demand that the printer"
                          f" not exist.")
            elif mode == "preset drawn, rectified" and matched and hard \
                    and consumed <= 3.0:
                ok(f"e2 levels separable {preset}/{pname}/{mode}", s >= 0.6,
                   f"worst 1-sigma separation {s:.2f} ({why}) -- a full random draw"
                   f" from the ranges may have less margin than a nominal page, but"
                   f" it must not overlap")
            elif mode == "preset drawn, rectified" and hard:
                # Not weakened, stated: this draw erodes the contour by far more than
                # the glyph can absorb, so rho has to move. Whether the levels still
                # separate afterwards is the number a decoder actually lives on, and it
                # can go either way -- so the sentence is chosen from the measurement
                # instead of asserting a story about it.
                verdict = ("and the levels still separate" if s >= 1.0 else
                           "and the levels do NOT stay separable")
                print(f"    {'':<26} FINDING, not asserted: this draw erodes the edge"
                      f" by {ero:.4f}mm against a {b['worst']:.4f}mm budget"
                      f" ({consumed:.1f}x), {verdict} (e2 {s:.2f} sigma, {why}). Shape"
                      f" survives only where the pitch leaves the fixed windows room;"
                      f" a gate that needs it at this pitch must constrain ew/blur,"
                      f" not ask for a bigger number.")
            else:
                print(f"    {'':<26} (reported only: isolates one edge-moving class;"
                      f" e1 is asserted by the two gates above)")


def _level(rho: float, cal: list) -> int | None:
    """shapeThresholds + levelFromRho, on this page's *measured* targets."""
    if not (rho >= 0) or rho > 1.28:
        return None
    mids = [(cal[i - 1] + cal[i]) / 2 for i in range(1, len(cal))]
    no_dot = max(cal[0], mids[0] * 0.55) if mids else cal[0] * 2
    if rho < no_dot:
        return 0
    for i, m in enumerate(mids):
        if rho < m:
            return i
    return len(cal) - 1


# ---------------------------------------------------------------------------
# (f) readability
# ---------------------------------------------------------------------------

def check_readable(work: str, names: list) -> None:
    print("\n(f) the output must load with the tools the project uses")
    out = os.path.join(work, "read")
    rc, _ = run_cli(["--in", os.path.join(work, "src"), "--out", out, "--seed", "3",
                     "--preset", "phone40", "--dpi", "300"])
    ok("phone40 ran", rc == 0, f"exit {rc}")
    from PIL import Image
    for name in names:
        path = os.path.join(out, name)
        cv = cv2.imread(path, cv2.IMREAD_COLOR)
        with Image.open(path) as im:
            im.load()
            mode, size, fmt = im.mode, im.size, im.format
            dpi = im.info.get("dpi")
            info = im.info
            raw = im.convert("RGB").tobytes()
        with open(path, "rb") as fh:
            sig = fh.read(33)
        depth, ctype, interlace = sig[24], sig[25], sig[28]
        matches = cv is not None and cv.shape[:2] == (size[1], size[0])
        # core/decode/png-read.js accepts exactly: 8-bit, non-interlaced, RGB/RGBA/grey
        decodable = depth == 8 and interlace == 0 and ctype in (2, 6, 0)
        ok(f"{name} readable", decodable and matches and fmt == "PNG" and mode == "RGB",
           f"{fmt} {mode} {size} bit_depth={depth} colour_type={ctype} interlace={interlace} "
           f"dpi={tuple(round(float(x), 1) for x in dpi) if dpi else None} "
           f"bytes={len(raw)} cv2_shape_match={matches}")


# ---------------------------------------------------------------------------
# (g) CLI contract
# ---------------------------------------------------------------------------

def check_cli(work: str) -> None:
    print("\n(g) CLI contract")
    empty = os.path.join(work, "empty")
    os.makedirs(empty, exist_ok=True)
    rc, _ = run_cli(["--in", empty, "--out", os.path.join(work, "nope"), "--seed", "1",
                     "--preset", "scan300"])
    ok("no images -> non-zero exit", rc != 0, f"exit {rc} (stderr carries the message)")
    src = os.path.join(work, "src")
    one = os.path.join(work, "single")
    rc, _ = run_cli(["--in", os.path.join(src, "page-001.png"), "--out", one,
                     "--seed", "1", "--preset", "scan300", "--dpi", "300"])
    ok("--in accepts a single file", rc == 0 and sorted(os.listdir(one)) == ["page-001.png"],
       f"{sorted(os.listdir(one))} (same basename as the input)")
    sel = os.path.join(work, "pages")
    rc, objs = run_cli(["--in", src, "--out", sel, "--seed", "1", "--preset", "scan300",
                        "--dpi", "300", "--pages", "1", "--report"])
    ok("--pages selects", sorted(os.listdir(sel)) == ["manifest.json", "page-001.png"]
       and len([o for o in objs if "summary" not in o]) == 1,
       f"{sorted(os.listdir(sel))}")
    try:
        run_cli(["--in", src, "--out", os.path.join(work, "bad"), "--seed", "1",
                 "--preset", "nope"])
        good = False
        err = "no error raised"
    except SystemExit as e:                    # argparse: choices=[...], exit 2
        good = int(e.code or 0) != 0 and not os.path.exists(os.path.join(work, "bad"))
        err = f"argparse rejected it with exit {e.code} and wrote nothing (choices are" \
              f" enforced by the parser, so no page can ever be written with a typo'd" \
              f" preset)"
    except KeyError as e:                      # still fine if it gets as far as the table
        good = "scan300" in str(e)
        err = str(e)[:110]
    ok("unknown preset names the valid ones", good, err)
    iso = os.path.join(work, "iso")
    rc, objs = run_cli(["--in", src, "--out", iso, "--seed", "1", "--preset", "phone-hard",
                        "--dpi", "300", "--only", "mtf", "--report"])
    per = [o for o in objs if "summary" not in o]
    acts = [factor_activity(o) for o in per]
    live = [f for f in CH.FACTORS if max(a[f] for a in acts) > 1e-12]
    ok("--only isolates one factor at the CLI level", rc == 0 and live == ["mtf"],
       f"live={live}; mtf_mm={[o['mtf_mm'] for o in per]}, and the frame stayed on the"
       f" print grid ({per[0]['out_size']} vs the page's own size) so no hidden box"
       f" filter rode along")
    offd = os.path.join(work, "offd")
    rc, objs = run_cli(["--in", src, "--out", offd, "--seed", "1", "--preset", "phone-hard",
                        "--dpi", "300", "--off", "geometry", "--off", "jpeg", "--report"])
    per = [o for o in objs if "summary" not in o]
    acts = [factor_activity(o) for o in per]
    ok("--off switches those factors and only those",
       rc == 0 and max(a["geometry"] for a in acts) == 0.0
       and max(a["jpeg"] for a in acts) == 0.0
       and min(a["mtf"] + a["noise"] + a["illumination"] for a in acts) > 0,
       f"geometry and jpeg silent, mtf/noise/illumination still live"
       f" (e.g. {[k for k in ('mtf','noise','illumination') if acts[0][k] > 0]})")
    md = os.path.join(work, "mod")
    rc, objs = run_cli(["--in", src, "--out", md, "--seed", "1", "--preset", "phone40",
                        "--dpi", "300", "--modifier", "dark", "--report"])
    per = [o for o in objs if "summary" not in o]
    ok("--modifier dark forces the -2.5..-1.0 EV range", rc == 0 and all(
        -2.5 <= o["exposure_ev"] <= -1.0 for o in per),
       f"EV drawn: {[o['exposure_ev'] for o in per]}")
    pm = os.path.join(work, "prm")
    rc, objs = run_cli(["--in", src, "--out", pm, "--seed", "1", "--preset", "phone40",
                        "--dpi", "300", "--param", "curl_deg=0", "--param", "rot_deg=3.5",
                        "--report"])
    per = [o for o in objs if "summary" not in o]
    ok("--param pins a value or a range", rc == 0 and all(
        o["curl_deg"] == 0 and abs(abs(o["rotation_deg"]) - 3.5) < 1e-6 for o in per),
       f"curl={[o['curl_deg'] for o in per]} rot={[o['rotation_deg'] for o in per]}")


def o_key_nonzero(rep: dict, key: str) -> bool:
    v = rep.get(key)
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return abs(v) > 1e-9
    if isinstance(v, (list, tuple)):
        return any(o_key_nonzero({"x": x}, "x") for x in v)
    return v not in ("", "none", None)


# Which report keys mean "this factor is actually doing something". Asking "is any
# key of this group non-zero" is wrong: moire_period_px and moire_ratio are printed
# even at amp 0 (they describe the grid, not a modulation), substrate_rgb is 255 on a
# white page, and scale is 0.29 in a camera frame -- so a naive scan reports half the
# factors as live on a run that applied one.
_ACTIVITY = {
    "mtf": ("mtf_mm", "defocus_mm"),
    "ew": ("ew_expansion_mm",),
    "substrate": ("paper_grain_amp", "stripe_amp", "bed_texture_amp"),
    "illumination": ("exposure_ev", "vignette", "glare_amp", "tone_mix"),
    "wb": ("wb_dev",),
    "geometry": ("rotation_deg", "yaw_deg", "pitch_deg", "crop_frac", "curl_deg",
                 "fill_dev", "shift", "scale_dev"),
    "noise": ("read_sigma", "shot_sigma", "hot_rate"),
    "motion": ("motion_px",),
    "moire": ("moire_amp",),
    "jpeg": ("jpeg_quality",),
    "bleed": ("bleed_eps", "mono"),
}


def factor_activity(rep: dict) -> dict:
    """Amplitude of each factor group as applied to this page, from its report."""
    act = {f: 0.0 for f in _ACTIVITY}
    for f, keys in _ACTIVITY.items():
        for k in keys:
            v = rep.get(k)
            if v is None:
                continue
            if isinstance(v, bool):
                act[f] += 1.0 if v else 0.0
            elif isinstance(v, (int, float)):
                act[f] += abs(float(v))
    if rep.get("wb_gain"):
        act["wb"] += max(abs(float(x) - 1.0) for x in rep["wb_gain"])
    if rep.get("fill") is not None:
        act["geometry"] += abs(float(rep["fill"]) - 1.0)
    if rep.get("scale") is not None:
        act["geometry"] += abs(float(rep["scale"]) - 1.0)
    if rep.get("shift_x") is not None:
        act["geometry"] += abs(float(rep["shift_x"])) + abs(float(rep["shift_y"] or 0))
    return act


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def build_pages() -> dict:
    """Four lattices that matter: the shipping paper pitches, a coarse paper
    control, and an FDM plate on a real EW grid."""
    out = {
        # P-M1-300: 0.847mm at 300 dpi -> a 10px cell, 4 shape levels
        "page-000": make_page(300, 0.847, 44, 60, 4, ideal_geometry(4)),
        # P-M1-600: same pitch at 600 dpi -> 20px cell
        "page-001": make_page(600, 0.847, 44, 60, 4, ideal_geometry(4)),
        # coarse paper control: is a failure the channel's or the lattice's?
        "page-002": make_page(300, 2.0, 12, 16, 4, ideal_geometry(4)),
        # FDM plate: 3.6mm pitch on a 0.4mm nozzle = 9 EW, 2 levels (quantised)
        "page-003": make_page(300, 3.6, 10, 14, 2, ew_geometry(9.0, 2)),
    }
    out["page-000"]["medium"] = "paper"
    out["page-001"]["medium"] = "paper"
    out["page-002"]["medium"] = "paper"
    out["page-003"]["medium"] = "plate"
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep the generated fixtures")
    ap.add_argument("--full", action="store_true",
                    help="run the whole preset x page matrix (minutes); the default is"
                         " a smoke pass of the asserted cases, under two minutes")
    args = ap.parse_args(argv)
    global FULL
    FULL = bool(args.full)
    work = os.path.join(HERE, "_selfcheck_work")
    if os.path.isdir(work):
        shutil.rmtree(work)
    os.makedirs(work)

    pages = build_pages()
    print("PSKT simulated-channel selfcheck")
    for n in sorted(pages):
        pg = pages[n]
        print(f"  {n}: {pg['width']}x{pg['height']}px @{pg['dpi']}dpi pitch {pg['pitch_mm']}mm"
              f" cell {pg['cell']}px {pg['levels']} levels"
              f"{' EW-quantised' if pg['geom']['quantised'] else ' ideal'}")

    src = os.path.join(work, "src")
    os.makedirs(src)
    names = []
    for n, pg in sorted(pages.items()):
        path = os.path.join(src, n + ".png")
        CH.write_png(path, pg["pixels"], pg["dpi"])
        names.append(n + ".png")
    with open(os.path.join(src, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({"tool": "sim/selfcheck", "profile": "P-M1", "dpi": 300, "nozzle": 0.4,
                   "monoSafe": "full", "pageGeometry": {"pitchMm": 0.847}}, fh)

    # does our own rho measure agree with what was drawn?
    print("\n  measure sanity (rho on the pristine page, no channel at all):")
    for n in sorted(pages):
        pg = pages[n]
        t = page_target_table(pg)
        got: dict = {}
        for r in range(1, pg["rows"] - 1):
            for c in range(1, pg["cols"] - 1):
                lv = int(pg["level_grid"][r, c])
                got.setdefault(lv, []).append(measure_rho(pg["pixels"], pg, c, r))
        parts, cal = [], []
        for lv in sorted(got):
            v = [x for x in got[lv] if np.isfinite(x)]
            cal.append(float(np.median(v)))
            parts.append(f"L{lv} geometric {t[lv]:.4f} measured median {np.median(v):.4f}"
                         f"[{np.min(v):.4f},{np.max(v):.4f}] n={len(v)}")
        pg["cal"] = cal
        print(f"    {n}: " + "; ".join(parts))
    print("    The measured table is what a calibrated decoder decides against")
    print("    (core/render/raster.js#measureTargets / `pskit calibrate`), and it is")
    print("    what every rho assertion below uses as its reference -- NOT the")
    print("    geometric target, because the channel is not what makes that gap.")

    check_determinism(work, names)
    check_identity(work, pages["page-002"], "page-002.png")
    check_factors(work, pages["page-002"])
    check_rho(work, pages)
    check_readable(work, names)
    check_cli(work)

    print()
    if FAILURES:
        print(f"SELFCHECK FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    else:
        print("SELFCHECK PASSED")
    if args.keep:
        print(f"fixtures kept in {work}")
    else:
        shutil.rmtree(work)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
