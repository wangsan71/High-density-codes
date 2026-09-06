#!/usr/bin/env python3
"""PSKT ref -- independent (pillow) verification of a raster we wrote.

The Node side proves itself with node:zlib and a hand-rolled TIFF parser; this
script proves it with a third-party decoder (Pillow) instead, which is the only
check that catches "our encoder and our test share the same wrong idea".

    python ref/verify_raster.py <file.png|file.tif> [more files...]

For every image, if a sidecar `<file without extension>.raw` sits next to it
(see tools/dump-sample-raster.mjs for the layout), the decoded pixels are
compared byte for byte against the sidecar's RGB reference and the reported dpi
is compared with a +/-1 dpi tolerance.

Output: one `PASS <file>` / `FAIL <reason>` line per file (plus the
size/mode/dpi line).  Exit status: 0 all passed, 1 something failed, 2 usage
or I/O error.

Deps: python 3.10 + pillow only (numpy optional, unused).
"""

from __future__ import annotations

import os
import struct
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("FAIL pillow (PIL) is not installed; pip install pillow", file=sys.stderr)
    sys.exit(2)

SIDECAR_MAGIC = b"PSKTRAW1"
SIDECAR_HEADER = struct.Struct("<8sIII")  # magic, width, height, dpi
DPI_TOLERANCE = 1.0
MAX_IMAGE_PX = 200_000_000  # we generate page rasters on purpose: lift the bomb guard


def load_sidecar(image_path: str):
    """Return (width, height, dpi, rgb bytes) or None when there is no sidecar."""
    base, _ = os.path.splitext(image_path)
    raw_path = base + ".raw"
    if not os.path.exists(raw_path):
        return None
    with open(raw_path, "rb") as fh:
        blob = fh.read()
    if len(blob) < SIDECAR_HEADER.size:
        raise ValueError(f"{os.path.basename(raw_path)}: shorter than the sidecar header")
    magic, width, height, dpi = SIDECAR_HEADER.unpack(blob[: SIDECAR_HEADER.size])
    if magic != SIDECAR_MAGIC:
        raise ValueError(f"{os.path.basename(raw_path)}: bad sidecar magic {magic!r}")
    rgb = blob[SIDECAR_HEADER.size :]
    if len(rgb) != width * height * 3:
        raise ValueError(
            f"{os.path.basename(raw_path)}: sidecar holds {len(rgb)} bytes, "
            f"expected width*height*3 = {width * height * 3}"
        )
    return width, height, dpi, rgb


def first_diff(expected: bytes, actual: bytes) -> int:
    """Index of the first differing byte, or -1. Chunked so a 100 MB reference
    does not turn a failure hunt into a Python-level per-byte loop."""
    if expected == actual:
        return -1
    step = 1 << 20
    for start in range(0, min(len(expected), len(actual)), step):
        a = expected[start : start + step]
        b = actual[start : start + step]
        if a != b:
            for i in range(min(len(a), len(b))):
                if a[i] != b[i]:
                    return start + i
            return start + min(len(a), len(b))  # one side is a truncated prefix
    return min(len(expected), len(actual))


def verify(image_path: str) -> bool:
    if not os.path.exists(image_path):
        print(f"FAIL {image_path}: no such file")
        return False

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PX
    try:
        with Image.open(image_path) as im:
            fmt = im.format
            mode = im.mode
            width, height = im.size
            dpi = im.info.get("dpi")
            im.load()
            rgb = im.convert("RGB").tobytes()
    except Exception as exc:  # a decoder refusal *is* a failure
        print(f"FAIL {image_path}: pillow could not decode it ({exc})")
        return False

    dpi_txt = "none" if dpi is None else f"{float(dpi[0]):.3f}x{float(dpi[1]):.3f}"
    print(f"  {os.path.basename(image_path)}: {fmt} size={width}x{height} mode={mode} dpi={dpi_txt}")

    if len(rgb) != width * height * 3:
        print(f"FAIL {image_path}: decoded {len(rgb)} bytes for {width}x{height} RGB")
        return False

    side = load_sidecar(image_path)
    if side is None:
        print(f"PASS {image_path} (no .raw sidecar: structure/dpi only)")
        return True

    exp_w, exp_h, exp_dpi, exp_rgb = side
    if (exp_w, exp_h) != (width, height):
        print(f"FAIL {image_path}: size {width}x{height} != sidecar {exp_w}x{exp_h}")
        return False
    if mode != "RGB":
        print(f"FAIL {image_path}: decoded mode is {mode}, PSKT rasters must be plain RGB")
        return False
    if dpi is None:
        print(f"FAIL {image_path}: no dpi recorded, sidecar wants {exp_dpi}")
        return False
    for axis, got in enumerate(dpi):
        got = float(got)
        if abs(got - exp_dpi) > DPI_TOLERANCE:
            print(
                f"FAIL {image_path}: dpi axis {axis} is {got:.3f}, "
                f"sidecar says {exp_dpi} (+/-{DPI_TOLERANCE})"
            )
            return False
    bad = first_diff(exp_rgb, rgb)
    if bad >= 0:
        y, x = divmod(bad // 3, width)
        print(
            f"FAIL {image_path}: pixel mismatch at byte {bad} (x={x} y={y}): "
            f"expected {tuple(exp_rgb[bad:bad + 3])} got {tuple(rgb[bad:bad + 3])}"
        )
        return False
    print(f"PASS {image_path} ({width}x{height} {fmt}, dpi~{exp_dpi}, {len(rgb)} bytes == sidecar)")
    return True


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    ok = True
    for one in argv:
        ok = verify(one) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
