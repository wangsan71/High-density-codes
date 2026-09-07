# sim/ — a simulated physical channel, so PSKT's gates can be run before the hardware does

`channel.py` takes pages that `pskit send` already rendered and puts them through a
model of the world between the printer and the decoder: a laser printer or FDM bed,
a piece of paper or a plate, a lamp, a lens, a sensor, and a JPEG encoder. It writes
PNGs in the same page naming, with the manifest copied verbatim, so
`pskit receive <out_dir>` can be pointed at its output and nothing on the Node side
has to know that no printer was involved.

This is a **degradation model**, not a renderer: it never redraws a glyph. It reads
each page, decomposes it into (substrate, per-pixel ink coverage, ink colours),
applies physics to those, and recomposites. If a stage cannot be expressed as
something that happens to ink or to light, it is not in this file.

```
sim/
  channel.py     the channel + CLI (stdlib, numpy, opencv — no new dependencies)
  selfcheck.py   4 synthetic pages built in numpy + 7 sections of assertions
  README.md      this file
```

---

## 1. Run it

```powershell
# encode some real pages once (Node side, unchanged)
node cli/pskit.mjs send my.txt --profile P-M1-300 --out .tmp\src

# put them through the channel
python sim/channel.py --in .tmp/src --out .tmp/scan300 --seed 7 --preset scan300 --report

# decode what came back
node cli/pskit.mjs receive .tmp/scan300
```

**Heads-up on that last line, measured today:** on this profile's own lattice
(`P-M1-300`, 0.8467 mm → a 10 px cell at 300 dpi) the receiver rejects the pack —
`FAIL readout/echo-bad-magic` on page 0, `REJECTED page 1 (intra-fail)` on page 1, and
nothing written. `--photo` is not the workaround either: it fails the same way on the
*pristine* `pskit send` output (§8, row 1). §8 has the numbers that pin which factor
does it and how far it must be constrained before the pack decodes again — a 10 px cell
cannot carry a sub-pixel feature through an edge-moving process, and no rejection here
was ever a silent mis-decode.

`--in` is a directory of page images (or one file). `--out` is created. The output
keeps the input's basename per page (`page-000.png` → `page-000.png`) and copies
`manifest.json` byte-for-byte from `<in>/manifest.json` (or `--manifest <path>`).

Everything the channel decided for a page goes to stdout as **one JSON object per
page plus one summary line, and nothing else on stdout** (`--report`). Status goes to
stderr. Non-zero exit if the input has no readable images.

Full CLI:

```
--in PATH            dir of page images or one file          (required)
--out DIR            output directory, created               (required)
--seed INT           deterministic master seed               (required)
--preset NAME        identity|scan300|scan600|phone40|phone-hard|plate-matte|plate-glossy
--dpi NUM            print dpi of the INPUT pages (default: manifest dpi, else 300)
--pages LIST         page selection, e.g. "0,2,5-7" (default: all)
--manifest PATH      manifest to copy verbatim (default: <in>/manifest.json)
--report             one JSON object per page + one summary line, on stdout
--modifier NAME      repeatable named range patch (see §4)
--only LIST          enable ONLY these factor groups (see §3)
--off LIST           disable these factor groups
--param K=V          repeatable, pin one generator parameter (scalar, range, or name)
```

Measured cost on this machine: three 2260×3290 A4 pages at 300 dpi through `scan300`
in **13.6 s** (~4.5 s/page). `python sim/selfcheck.py` is a **44 s** smoke pass
(61 assertions), `--full` the whole preset × page matrix in **102 s** (113
assertions). Both exit 0 today.

## 2. Determinism contract

* One master `--seed`. Per page the generator is `default_rng(SeedSequence([seed, pageIndex]))`,
  so **a page's bytes do not depend on its co-residents**: running `page-000.png`
  alone gives the identical file to running it inside a 3-page directory (asserted).
* `numpy.random.default_rng` only. No `random`, no `Math.random`, no global state.
* Same seed + preset + input ⇒ same bytes, to the hash (asserted, 5 files / 5.1 MB).
* Different seed ⇒ every page differs (asserted).
* `--pages 0` and `--pages 0-2` produce identical bytes for page 0 (asserted).
* The copy of `manifest.json` in the output is bit-identical to the input's (asserted).

The page index comes from the filename (`page-NNN.png`), which is what the renderer
writes and what `pskit receive` reads; the positional index is used only when the
name does not carry one, and the report says which it used
(`page_index_source: "filename" | "ordinal"`).

## 3. The presets and the physical cause each one stands for

Ranges are **per page, drawn independently** — one page of a pack may be in the
glare and the next may not. Every range is a range, not a constant, because a gate
that passes on a fixed page proves nothing about a noisy channel; `nominal` is the
number a well-tuned device of that class hits, and it is what `--param`-free
`selfcheck` tier runs use.

| preset | medium / frame | stands for | the ranges that matter |
|---|---|---|---|
| `identity` | — | **no channel at all.** Output pixels == input pixels, file re-encoded byte-identical. Proves the harness plumbing, not the physics. | all factors neutral |
| `scan300` | paper / scanbed, capture 300 dpi | a flatbed or ADF sheet-fed scan of a laser print. Aligned, scaled 1:1, glass bigger than the sheet. | MTF σ 0.03–0.11 mm (toner edge spread), EW −0.05…+0.15 mm (dot gain / ink bleed), defocus ≤0.02 mm, paper tone drift, grain ≤3 levels, vignette ≤12 %, glare ≤8 %, tone curve ≤25 %, AWB residual ≤4 %, read 1–2.5 + shot 1–2.5, crop ≤2 %, rot ≤1.2°, JPEG q 84–92 |
| `scan600` | paper / scanbed, 600 dpi | the same sheet at 600 dpi: better optics, **moire**, more noise per mm² because the pixels are smaller. | as scan300 plus moiré amp 0–0.10 with sensor/print pitch ratio 1.6–2.5, JPEG q 82–92 |
| `phone40` | paper / camera | a phone held over a page at ~40 px per lattice cell: real perspective, AF not on the code, mild motion, big vignette, white balance guessing under a room lamp. | rot ≤20°, yaw ≤14°, pitch ≤12°, fill 0.62–0.95, curl ≤6°, defocus ≤0.5 mm, motion 0–4 px, vignette ≤28 %, glare ≤45 %, EV −1.5…+1.5, AWB ≤8 %, read 2–5 + shot 3–8, hot pixels ≤1e-4, crop ≤5 %, JPEG q 62–86 |
| `phone-hard` | paper / camera | the same phone, badly: hand shake, corner out of frame, 35° in-plane, glossy paper glare, q≈50 JPEG. **A stress preset: it is expected to hurt.** | rot ≤35°, yaw ≤22°, pitch ≤16°, fill 0.55–0.85, curl ≤10°, defocus ≤0.75 mm, motion 5–15 px, vignette ≤35 %, glare ≤100 % (clipping), EV −2.5…−1.0 with `dark`, read 4–9 + shot 6–14, hot ≤6e-4, crop ≤12 %, JPEG q 45–65 |
| `plate-matte` | FDM bed | a printed plate: 0.2–0.4 mm layer stripes, bed texture, a *much* coarser lattice, and 0.1–0.3 mm of printed line width. | MTF σ 0.12–0.45 mm, EW 0…0.25 mm (extrusion width − nozzle), stripe period 0.28–0.42 mm, bed texture ≤6 %, curl ≤12°, defocus ≤0.35 mm, JPEG q 68–88 |
| `plate-glossy` | FDM bed, shiny | the same plate on glossy PETG/PEI: **specular glare that clips to 255**, and a hot end that smears. | glare amp 0.4–1.0 (width 8–30 mm), bed texture ≤12 %, MTF σ 0.1–0.35 mm, curl ≤8° |

Substrate is *decomposed from the page* (median colour = substrate, per-pixel
coverage = how far each pixel sits between the substrate and the nearest ink in the
palette), so paper tone and FDM texture apply to the paper and not the ink, and a
mono plate gets a single material.

## 4. Modifiers, factor groups, isolation

`--modifier` is a named patch over the ranges (`--param` beats it):

`dark` (EV −2.5…−1.0) · `bright` · `mono` (force one material, the `monoSafe` path) ·
`bleed` (colour bleed always on) · `nomoire` · `nocrop` · `still` (no motion blur) ·
`flat` (no curl) · `clean` (no substrate texture, no moiré, no crop, no bleed).

Factor groups for `--only` / `--off`, one each, independently switchable:

`mtf` `ew` `substrate` `illumination` `wb` `geometry` `noise` `motion` `moire` `jpeg` `bleed`

```powershell
# the paper path with ink expansion ONLY  (everything else neutral)
python sim/channel.py --in .tmp/src --out .tmp/only-ew --seed 7 --preset scan300 --only ew --param ew_mm=0.10
# the same page with moire and JPEG switched off, nothing else changed
python sim/channel.py --in .tmp/src --out .tmp/nomoire --seed 7 --preset scan600 --off moire,jpeg
```

`--only`/`--off` are repeatable as flags *and* as comma lists, and an unknown factor
name exits 2 with the list of real ones. **`--off geometry` also pins the device to the
print grid** (`frame=page`, `capture_dpi=null`): `frame` and `capture_dpi` are not in
`FACTOR_OF` because they select a device rather than a degradation, so without that
pin a test that believes it isolated one factor is also looking at a 3× box filter.
This was not a design decision made in advance — the selfcheck's `--only mtf` line
failed first and pointed at it.

`selfcheck.py` section (d) is exactly this: it re-runs the channel with **one** factor
at a time and asserts the number moved, with the measurement named on the line
(ink-area change for EW, FFT peak for the layer period, near-threshold pixel count
for white balance, spectral line for the moiré beat, 8-px second difference for
JPEG blocking, …).

## 5. Output convention a gate should wire against

* **One output image per input page, same basename.** Nothing is tiled, nothing is
  renamed, so `page-007.png` in the input is `page-007.png` out — a gate can pair
  input and output by name without parsing anything.
* **`manifest.json` is copied verbatim, never rewritten.** The channel does not know
  the payload or the ECC, and if it changed one byte of the manifest the receiver's
  integrity check would stop being a check. `summary.manifest_copied` says whether it
  was there.
* **The output image is not the same size as the input.** `frame_px` / `out_size` give
  the capture frame; `scale` is capture PPI ÷ print PPI. A scan is 1:1 (the sheet on
  the glass), a camera frame is whatever `fill` put in it.
* **`--report` is machine-readable and complete.** Per page: every drawn parameter
  (`mtf_mm`, `ew_expansion_mm`, `exposure_ev`, `wb_gain`, `curl_deg`, `moire_ratio`,
  `jpeg_q`, `crop_frac`, …) and every measured consequence
  (`ink_area_gain`, `substrate_mod_rms`, `clipped_frac`, `near_clip_frac`,
  `decomp_resid_max`, `marker_visible`, `corners_visible`, `pitch_px_print`,
  `capture_ppi`). The final line has `summary: true` with `pages`, `mean`, `max`,
  `out_sizes`, and the CLI flags, so a gate can assert "the mean crop stayed under
  1 %", "no page exceeded EV 1.5" or "every page kept 3 corner markers"
  from the report alone.
* A page whose parameters were forced neutral is still reported with the neutral
  values — nothing is silently skipped.
* The channel keeps a `meta` dict per page for tests: `rectify(out, meta, (h, w))`
  inverts **the planar warp the channel applied**, from ground truth. It is not a
  decoder and it is not available to production code; with `strict=True` it
  **raises** on a curled page rather than pretending a homography can flatten one.

## 6. Where I chose physical honesty over a convenient answer

These are the places where the easy version would have made more tests pass.

1. **JPEG inside a PNG, deliberately.** `cv2.imencode('.jpg') + imdecode` in memory,
   then the degraded result is written back out as PNG. So the artefacts are real
   (8×8 blocking, chroma subsampling, ringing) while the file stays inside what
   `core/decode/png-read.js` accepts (8-bit, non-interlaced RGB/RGBA/grey).
   Consequence a reader must know: **a PNG from this channel is not a pristine
   render, it is a photograph of a JPEG.** `jpeg_q` and `jpeg_quality` are in every
   report so nothing can confuse the two.
2. **The paper is white, so `clipped_frac` was a lie until it was split.** On a real
   page the substrate sits at code 255, so "fraction of pixels ≥ 255" reported 13 %
   on an undamaged scan. The report now carries three numbers instead:
   `clipped_frac` 0.1302, `paper_sat_frac` 0.1748 (the bare paper, harmless — it is
   what white looks like) and **`glare_ink_wiped_frac` 0.0000** — the fraction of
   *actually printed ink area* that saturation erased, with the page's own coverage
   mapped into the frame through the channel's own inverse warp. Saturation only
   matters where there is ink; on `plate-glossy`, where the glare is the point, that
   column is what a gate should watch.
3. **`--off` silently kept only its last value**, so `--off geometry --off jpeg` did
   one of the two. The selfcheck's `--only mtf` line caught it by failing for a reason
   that had nothing to do with what it was testing, which is the only kind of bug
   report worth having. Both flags are `action="append"` now, and the fact that
   "geometry off" also has to pin the capture device to the print grid (§4) came out of
   the same line.
4. **A curl is applied to the sheet, in the sheet's own domain**, as an arc-length
   compression plus the Lambert shading that comes with a surface tilted away. It is
   emphatically not affine, and `rectify()` refuses to undo it (`strict=True` raises)
   because a non-planar bend is not invertible from one frame. The cheap version was
   to fold curl into the homography and let every geometry test pass.
5. **The crop policy is stated as a compromise, not as a success.** On a rectangular
   frame a straight cut that removes a chosen corner also takes the corners adjacent
   to the edge it crosses — "crop 12 %" and "lose exactly one corner marker" are not
   simultaneously satisfiable. The channel bisects the crop, then backs off in
   0.75/0.5/0.25 steps and **drops the crop entirely** if even the smallest cut would
   take two markers, and reports `crop_capped: true`, `crop_requested_frac`, and the
   four `marker_visible` fractions. Corner visibility is measured as the area of the
   4×4-cell marker square that survives, not as whether the quad's corner point
   happens to be inside the frame.
6. **The scanbed frame is sized from the page's rotated bounding box, not the page.**
   My first version derived the glass from the unrotated page, so every scan with a
   rotation lost corners for no physical reason — a scanner's glass is bigger than
   the sheet, and the sheet's own rotation cannot push it off the glass.
7. **`--dpi` mismatch is refused, not silently reinterpreted** (a page rendered at
   600 dpi but declared 300 would have its blur, moiré and every mm-based number
   computed against the wrong grid). `--dpi` overrides the manifest; equal to it is a
   no-op; otherwise the run fails with the two numbers in the message.
8. **White balance is purely chromatic.** The per-channel gains are normalised to
   unit mean, and the report shows both `agc_gain` (measured) and `auto_level` (how
   much of the camera's auto-white the channel applied). Without this, a "wb" test
   would quietly also be an exposure test, and one knob could not isolate the other.
9. **The auto-white model is explicit about its failure.** It finds the 92nd
   percentile of the *page's own substrate* in the frame and scales toward a nominal
   white, because the shipping palette's `PAPER1` white is code 255 and a real
   scanner really does hit it. So `--param auto_level=0.0` exists to measure the
   uncorrected channel, and the assertion for a boosted-channel artefact is written
   in *relative* terms for that reason.
10. **Photon noise is applied in the linear domain and the tone curve comes after
   it.** Grain in the shadows and mush in the highlights only come out right in that
   order; doing it the other way round is the classic way to get a channel that looks
   noisy but whose dark-end SNR is wrong by an order of magnitude.
11. **`decomp_resid_max` measures the decomposition round-trip, not the channel.**
    The first implementation compared input to output and reported 172–227, which is
    a statement about how much degradation was requested. Now it compares the page
    recomposited from (substrate, coverage, ink) with every channel stage off, which
    is the only thing that number was ever supposed to mean. On the real P-M1-300
    pages it is 1.77 (8-bit levels) — the cost of calling the palette's white 255 and
    asking for a continuous coverage field, and the floor under every photometric
    assertion in `selfcheck.py`.
12. **The EW stage says what it cannot do.** Contour advection along a Gaussian
    distance-transform gradient places the shifted edge to ~0.5 px, not to the exact
    offset, because the only geometry available is the rasterised page; an exact
    offset would need the vector source. And when a feature's sampled coverage never
    reaches the 0.5 threshold (a 0.9 px annulus on the shipping lattice), the shift is
    measured against that feature's own mid-level, and the report says so with
    `ew_tau: 0.548, ew_tau_fallback: true` instead of quietly applying a shift
    against a threshold the ink never crosses.
13. **The moiré is multiplicative in log space, with an exposure-independent
    amplitude**, because that is what moiré is: it moves ink between neighbouring
    cells and cannot be undone by normalising the picture.
14. **`plate-matte`'s nominal EW is 0.06 mm, not the range's midpoint.** 0.06 mm is
    what a 0.4 mm nozzle laying a 0.28 mm-wide extrusion actually spreads to; the
    midpoint of 0…0.25 would have made the preset a caricature and every "FDM
    survives" assertion meaningless.

## 7. What the channel measured, in numbers (selfcheck, 2026-07-31)

Two results a gate author needs before wiring G2/G4.

**(a) The shipping `P-M1-300` lattice cannot carry the shape channel through a paper
capture, and this is arithmetic, not optics.** ρ is measured through *fixed* windows
(`dotR=0.30`, `bandIn=0.40`, `bandOut=0.455`) while the annulus ink sits at
`[0.38, 0.47]` of the cell. The guard band therefore has **0.015–0.028 cells of
radial margin** — at the 0.8467 mm pitch that is **0.013 mm**, and at 2.0 mm pitch
0.030 mm. Meanwhile the paper EW range alone is −0.05…+0.15 mm. So:

| page | pitch | cell | budget | scan300 nominal erosion (2.2σ+EW) | ratio |
|---|---|---|---|---|---|
| page-000 | 0.847 mm | 10 px | 0.0127 mm | 0.162 mm | **12.8×** |
| page-001 | 0.847 mm | 20 px | 0.0127 mm | 0.140 mm | **11.0×** |
| page-002 | 2.0 mm | 24 px | 0.0300 mm | 0.162 mm | **5.4×** |
| page-003 (plate, EW geometry) | 3.6 mm | 43 px | 0.100 mm | 0.676 mm | **6.8×** |

Every preset's nominal parameters erode the contour 5–13× further than the fixed
windows can absorb. `|ρ − ρ_pristine|` therefore cannot be held inside a quarter of a
level spacing on any of them — measured drifts are 0.31–1.34 spacings — and asserting
that on those configurations would be asserting that printing does not happen. The
selfcheck asserts ρ-vs-pristine **only** where the erosion fits the budget (the
"photometry only" control: substrate, exposure, vignette, tone curve, white balance,
noise, moiré and bleed all on; everything that moves or *deletes* an edge — geometry,
MTF, EW, JPEG, motion, clipped glare — off), and it passes there: **max|Δρ| = 0.0030
at a 0.0550 tolerance on the 2 mm lattice, 0.0382 on the 600 dpi lattice, 0.0071 on the
plate** — i.e. the photometric half of the channel really is ratio-neutral. What breaks
ρ is edge motion, and that is the finding.

The independent cross-check: with only blur and EW on, the measured ρ drift matches a
1-D radial model of the glyph's edges (`radial_rho`, written without reference to the
channel) to within **10.0 %** on the 2 mm lattice and **18.9 %** on the plate, and the
drift is *always at least as large as the model says*. That bound is the model's, not
the channel's: it omits the advection stage's ±0.5 px contour-placement error and the
8-bit requantisation of a sub-pixel feature, so a symmetric-Gaussian argument is
**optimistic** about how far ρ moves, and a gate calibrated against the arithmetic
instead of against this channel would be the one that is wrong. The model is only
asserted where it has a domain — σ ≤ 0.12 cells, EW ≤ 0.10 cells, and at least two
samples across the annulus band — which excludes the shipping lattice (its band is
0.09 × 20 px = **1.8 px**, so a smooth radial profile does not exist there to model).
(Writing the model caught a bug in *it*, not in the channel: it had the annulus's hole
moving outward instead of inward, and disagreed by 27 % until that was fixed.)

**(b) What *does* survive is the recalibrated decision, and the margin is
pitch-dependent.** Judged as `pskit calibrate` would judge it — re-measure the ρ table
on the captured page, then ask whether neighbouring levels stay ≥1σ apart — `scan300`
separates the levels of the 2 mm lattice by **46σ** on the photometry-only control,
**8.29σ** at full nominal and **8.61σ** on a full random draw; `scan600` on the 0.847 mm
lattice by **3.85σ / 5.87σ**, and `plate-matte` on 3.6 mm by **27.96σ / 13.95σ**. The
tiers that stop being assertable stop for stated physical reasons, printed on the line:

| case | e2 | why not asserted |
|---|---|---|
| `phone-hard`, 2 mm lattice, nominal | 0.42σ | declared stress tier, and it hurt (motion 10 px, clipping 0.15, read+shot noise at the top of the range) |
| `phone-hard`, 0.847 mm @600, nominal | 0.31σ | annulus band is 1.8 px — under two samples |
| `scan600`, 0.847 mm, drawn | 0.52σ | erosion 17.4× the budget; the sentence is chosen from the measurement, not asserted about it |
| any preset on the other medium | — | `--full` runs the cross product and reports it: a 0.45 mm FDM edge spread on a 0.85 mm paper cell is a category error, not a stress test |


**(c) White balance is exactly as harmless as the design needs and exactly as
lethal as a fixed threshold.** At 2500 K the residual R/B ratio moves 1.097→1.334,
the fraction of pixels near a fixed B=200 threshold moves **2 696 → 259 080**
(9 510 %), while ρ — a coverage ratio — moves only 0.0203. That pair of numbers is
the entire argument for the shape+colour split, and `--only wb` reproduces it.

## 8. What the real decoder said (round trips through `pskit receive`)

Not my opinion about the model — the receiver's verdict on the channel's output, on
this machine, 2026-07-31. Two source packs: `P-M1-300` (0.8467 mm pitch, 216×319,
one data + two parity pages, 421-byte payload) and `PL-G --nozzle 0.4` (3.6 mm pitch,
42×42, 2236×2236 px @300 dpi).

| through the channel | receive | verdict |
|---|---|---|
| nothing (pristine `.tmp/sim-src`) | `--photo` | **FAIL `markers/no-hollow-corner`, 0 of 3 pages** |
| nothing (pristine) | plain | received 421 bytes, sha256 matches ✓ |
| `identity` seed 7 | plain (paper) / `--photo` (plate) | received 421 bytes ✓ both |
| `scan300`, `--off geometry,mtf,ew` | plain (paper) | **received 421 bytes ✓** |
| `scan300`, `--off geometry`, `--param ew_mm=0.02 --param mtf_mm=0.02` | plain | REJECTED page 0 (intra-fail) |
| `scan300`, `--off geometry` (mtf/ew at nominals) | plain | FAIL `readout/echo-bad-magic` |
| `scan300` as drawn | plain, `--photo` | FAIL `markers/no-hollow-corner` |
| `plate-matte` as drawn | `--photo` | FAIL `no-rectangular-quad` / `no-hollow-corner` |
| `phone40`, `phone-hard` as drawn | `--photo` (plate) | FAIL `no-hollow-corner` (phone40 data page: intra-fail) |
| `plate-matte --param mtf_mm=0.06 --param ew_mm=0.02 --modifier flat --off motion` | **`--photo`** | **received 421 bytes ✓ (all 3 pages, markers + perspective)** |

Read the table by what it *separates*:

1. **The photometric half of the channel is survivable and the shape half is not, at
   the shipping paper lattice.** With geometry, MTF and EW off, everything else at
   `scan300` values — paper grain and tone, exposure, vignette, clipped glare, tone
   curve, auto-white, photon noise, moiré, q≈84 JPEG — the real receiver recovers the
   payload byte-for-byte. Turn on 0.02 mm of edge movement (a *third* of the preset's
   nominal EW) and the same pack is rejected by its own ECC. At 10 px per cell, with
   a reference annulus 0.9 px wide, that is the whole story of §7 on paper.
2. **It never silently mis-decodes.** Every failure above is `FAIL` (no markers found)
   or `REJECTED … intra-fail`, and nothing was written. The channel's harshness shows
   up as refusal, which is the outcome AGENTS.md demands; the danger case — a wrong
   payload with a happy exit — did not occur in any of these runs.
3. **The two factors that break the front end at their drawn nominals are curl and
   motion blur**, not the printer. On the 3.6 mm plate, `plate-matte` with blur and EW
   pinned near their physical minimum and `--modifier flat --off motion` round-trips
   through the *photo* path — markers, perspective and all. Same preset as drawn, same
   pitch, same seed: no markers. So a gate author who wants a passing G2/G4 today
   should pin `curl_deg` and `motion_px` first; those are the two ranges most likely to
   be over-represented in this model, since neither was calibrated against a real
   capture (there are no reference photographs in `ref/`).
4. **`pskit receive --photo` cannot read a *pristine* `P-M1-300` render** (row 1). That
   is a receiver-side fact independent of this channel and it bounds what G2 can
   measure on paper at 0.847 mm: the photo path needs a coarser lattice, or its
   hollow-corner test needs the same `--photo`-vs-plain distinction the profiles have.

## 9. Which preset to wire a gate against

| gate | preset | what it will assert today | what to pin first |
|---|---|---|---|
| **G2** paper 300/600 dpi | `scan300` (P-M1-300), `scan600` (P-M1-600 / P-M2-600 / P-C4-600) | photometry is ratio-neutral (max\|Δρ\| 0.003–0.038) and the 2 mm lattice keeps 8.29σ of level separation at nominal | `ew_mm`, `mtf_mm` — at a 10 px cell even 0.02 mm breaks intra-ECC (§8); `--off geometry` too if the gate uses the plain (non-photo) path, and don't use `--photo` on this pitch at all |
| **G4** phone stress | `phone40` for the survivable tier, `phone-hard` as the bound | `phone40` on the 2 mm lattice: asserted e2 ≥ 1σ passes; `phone-hard` is *reported*, at 0.42σ — that is the measurement of where the tier hurts | `curl_deg` and `motion_px` (these are the two that break the receiver's *marker* stage at nominals, §8 row 10); glare if the gate counts colour |
| plate tiers | `plate-matte` (PL-M1/PL-D2/PL-D3, 3.6 mm), `plate-glossy` for the clipping case | 13.95σ at nominal, 27.96σ on photometry, and a **full `--photo` round trip of a real `PL-G` pack** | nothing for the shape channel; `curl_deg` if the marker stage is in the loop |

## 10. Not covered (deliberately, or honestly not attempted)

* **No spectral physics.** No illuminant SPD, no ink spectral reflectance, no
  metamerism, no paper fluorescence/OBA. Colour is three channel gains and a per-ink
  mixture; a metamerically-matched palette under a different lamp is not modelled and
  cannot be modelled from RGB.
* **No polarisation, and glare is an additive blob, not a reflection.**
  `plate-glossy` gets a clipped specular blob whose angle/position/width are
  parameters; what it does *not* do is depend on the viewing geometry the way a real
  gloss does (there is no BRDF here, so tilting the camera does not move the glare).
* **Depth-of-field is a single per-page σ.** Real defocus varies across a curled
  plate (different rows are at different depths) and around a tilted plane
  (Scheimpflug). Applying a spatially-varying blur needs a depth map the model does
  not have, so `defocus_mm` is uniform and the curl's *focus* consequence is not
  simulated. The curl's *foreshortening* and *shading* are.
* **Motion blur is one straight line segment**, uniform over the frame, with one
  constant velocity. A real phone shot has rotational shake, a rolling shutter, and
  a velocity that changes during the exposure.
* **Substrate scattering / halation** (light travelling *inside* the paper and
  lifting the ink from underneath, and the EWF/NEQ "donut" around small dots) is not
  modelled — the Gaussian MTF is a monotone low-pass, so it cannot produce the
  overshoot ringing a real electrophoto process puts around a small dot. The EW
  advection carries the first-order area effect of dot gain; the halo does not exist.
* **The 3D-print surface is a height field of one sinusoid per parameter** (layer
  stripes at a period, bed texture as fractal noise). No true shell geometry, no
  per-extrusion-segment ridges along the infill path, and no FDM orientation dependence
  on the *direction* of a printed line relative to the raster.
* **No colour management anywhere.** The renderer's contract is explicitly "no gamma"
  (`docs/RENDER-CONTRACT.md`) and the channel works in straight RGB; a real ICC
  profile applied by a printer driver, or a scanner's own colour conversion, is not
  modelled and would swamp several of the smaller factors.
* **The channel reads geometry off a raster, so anything whose true contour is below
  its own sampling cannot be shifted exactly** (see §6.12, and note that the same
  limit is why the 0.847 mm lattice is not assertable in §7).
* **Not a decoder.** `rectify()` exists for tests and uses ground truth the receiver
  does not have. Nothing in this directory can find a fiducial, sync a lattice, or
  read a payload — that stays on the Node side, which is the point: `pskit receive`
  running on this channel's output is the first honest thing in the loop.

## 11. selfcheck.py

```powershell
python sim/selfcheck.py            # smoke: < 2 min, one page per class
python sim/selfcheck.py --full     # every page x preset x mode, all factor pairs
python sim/selfcheck.py --keep     # leave sim/_selfcheck_work/ in place to inspect
```

It imports `channel.py` as a module and calls `CH.process` / `CH.main` directly —
**no subprocesses** (the harness sandbox denies piped-stdio children, and a Python
that spawns Python cannot be trusted to report its own exit status anyway).

Sections: (a) determinism + co-resident independence + manifest verbatim,
(b) seed sensitivity, (c) `identity` byte-identity, (d) every factor alone with the
measurement named, (e) ρ survival as §7, (f) outputs reload through `cv2.imread` and
`PIL.Image.open`, (g) the CLI contract: empty input exits non-zero with a message on
stderr, `--in <file>`, `--pages`, unknown preset, `--only`, `--off`, `--modifier`,
`--param`. Every assertion line prints the number it was decided on. Exit code 1 if
any of them fail.
