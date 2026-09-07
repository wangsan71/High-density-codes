#!/usr/bin/env python3
"""Independent binary-STL verifier for PSKT's mesh output (stdlib only).

Why this file exists separately from the JS side: `core/mesh/stl.js` checks its own
output, which proves nothing about whether a third party can read it. This script is
written against the STL format as it is actually used in the wild, from the byte
layout up, and it never imports or reads any JS. If the two disagree, one of them is
wrong -- that is the point.

It also refuses to claim what PSKT's mesh is not. `prismFromMask` covers a glyph mask
with rectangles, so adjacent prisms share walls: an undirected edge then belongs to
four triangles, not two, and the solid is NOT watertight even though every triangle is
well-formed. That is reported as a measured number, not smoothed over, and not either
asserted away or asserted as a defect -- a slicer does not need manifold shells to
slice a height field, but nobody should be told they are there if they are not.

    python ref/verify_stl.py path/to/page.stl [more.stl ...]
    python ref/verify_stl.py --selftest path/to/page.stl

Exit 0 = every check passed, 1 = something failed (including a check that could not be
run, because "could not check" is never success here).
"""
from __future__ import annotations

import math
import struct
import sys

MAGIC = b"PSKT/binary-stl"
# Coordinates are quantised to this many decimals when matching vertices across
# triangles; weldTriangles uses 6, so 1e-6 is the resolution the topology claims.
QUANT = 1_000_000


def _key(p):
    return tuple(int(round(c * QUANT)) for c in p)


class Report:
    def __init__(self):
        self.rows = []
        self.failed = False

    def check(self, name, cond, detail=""):
        ok = bool(cond)
        if not ok:
            self.failed = True
        self.rows.append(("PASS" if ok else "FAIL", name, detail))
        return ok

    def note(self, name, detail):
        self.rows.append(("NOTE", name, detail))

    def dump(self):
        for state, name, detail in self.rows:
            print(f"[{state}] {name}" + (f": {detail}" if detail else ""))


def parse(raw, rep, name):
    """Return (header_dict, triangles) or None. Every early return is a hard failure."""
    if len(raw) < 84:
        rep.check(f"{name}: long enough for a header + count", False, f"{len(raw)} bytes")
        return None
    header = raw[:80]
    (count,) = struct.unpack_from("<I", raw, 80)
    expected = 84 + 50 * count
    rep.check(
        f"{name}: file length is exactly 84 + 50*n",
        len(raw) == expected,
        f"{len(raw)} vs {expected} for n={count}",
    )
    if len(raw) != expected:
        return None
    if not header.startswith(MAGIC):
        rep.check(f"{name}: header starts with the PSKT magic", False, header[:32].decode("latin1"))
    else:
        rep.check(f"{name}: header starts with the PSKT magic", True)
    # The header advertises its own triangle count. If it disagrees with the u32 the
    # file is lying to anything that reads the header for a quick answer.
    fields = {}
    body = header.rstrip(b"\x00").decode("latin1")
    for part in body.split(";")[1:]:
        if "=" in part:
            k, _, v = part.partition("=")
            fields[k] = v
    rep.check(
        f"{name}: header tri count agrees with the binary count",
        fields.get("tri") == str(count),
        f"header={fields.get('tri')!r} u32={count}",
    )
    rep.check(f"{name}: header declares units=mm", fields.get("units") == "mm", str(fields.get("units")))

    tris = []
    for i in range(count):
        off = 84 + 50 * i
        nx, ny, nz = struct.unpack_from("<3f", raw, off)
        v = struct.unpack_from("<9f", raw, off + 12)
        attrs = struct.unpack_from("<H", raw, off + 48)[0]
        tri = ((v[0], v[1], v[2]), (v[3], v[4], v[5]), (v[6], v[7], v[8]))
        tris.append(((nx, ny, nz), tri, attrs))
    return {"fields": fields, "count": count, "tris": tris}, tris


def check_geometry(name, parsed, rep):
    count = parsed["count"]
    tris = parsed["tris"]
    zero_normal = 0
    winding_mismatch = 0
    degenerate = 0
    attrs_nonzero = 0
    xs, ys, zs = [], [], []
    for (n, (a, b, c), attrs) in tris:
        if attrs:
            attrs_nonzero += 1
        e1 = tuple(b[i] - a[i] for i in range(3))
        e2 = tuple(c[i] - a[i] for i in range(3))
        cross = (
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        )
        clen = math.sqrt(sum(v * v for v in cross))
        area2 = clen
        if area2 == 0.0:
            degenerate += 1
            continue
        nlen = math.sqrt(sum(v * v for v in n))
        if nlen == 0.0:
            zero_normal += 1
            continue
        # Right-hand rule: the stored normal must agree with (b-a) x (c-a). A slicer
        # that trusts the winding and a viewer that trusts the normal would disagree.
        dot = sum(n[i] * cross[i] for i in range(3)) / (nlen * clen)
        if dot < 0.99:
            winding_mismatch += 1
        for p in (a, b, c):
            xs.append(p[0])
            ys.append(p[1])
            zs.append(p[2])

    rep.check(f"{name}: no zero-area triangles", degenerate == 0, f"{degenerate}/{count}")
    rep.check(f"{name}: every stored normal is non-zero", zero_normal == 0, f"{zero_normal}/{count}")
    rep.check(
        f"{name}: stored normals agree with vertex winding (cos > 0.99)",
        winding_mismatch == 0,
        f"{winding_mismatch}/{count} disagree",
    )
    rep.check(f"{name}: attribute byte left at 0", attrs_nonzero == 0, f"{attrs_nonzero} set")
    if not xs:
        rep.check(f"{name}: has finite coordinates", False, "no usable vertices")
        return

    bbox = (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))
    ext = (bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2])
    finite = all(math.isfinite(v) for v in bbox)
    rep.check(f"{name}: bounding box is finite", finite, f"extent {ext[0]:.2f} x {ext[1]:.2f} x {ext[2]:.2f} mm")
    rep.check(f"{name}: bounding box has positive extent in all axes", all(v > 0 for v in ext), str(ext))
    # z should be a thin slab: relief + plate. A 600 dpi page is ~210x297 mm, so a
    # multi-metre extent would mean a unit bug (mm vs px) -- the classic mesh defect.
    rep.check(
        f"{name}: plausible A4-class footprint and sub-10mm height (mm not px)",
        10 < ext[0] < 600 and 10 < ext[1] < 600 and 0 < ext[2] < 10,
        f"x={ext[0]:.1f} y={ext[1]:.1f} z={ext[2]:.2f}",
    )

    # Signed volume by the divergence theorem. Positive means the shells are
    # consistently wound; the value is a real geometric quantity a third party can
    # compare against the plate volume.
    vol = 0.0
    for (n, (a, b, c), attrs) in tris:
        vol += (
            a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6.0
    rep.check(f"{name}: signed volume is positive (consistent winding)", vol > 0, f"{vol:.2f} mm^3")

    # Manifold check, honestly reported. Two triangles per undirected edge == closed
    # shells; more than two means coincident internal walls, which is what rectangle
    # covers produce. Not a failure -- a fact about what was actually built.
    edges = {}
    for (n, (a, b, c), attrs) in tris:
        ka, kb, kc = _key(a), _key(b), _key(c)
        for u, v in ((ka, kb), (kb, kc), (kc, ka)):
            k = (u, v) if u <= v else (v, u)
            edges[k] = edges.get(k, 0) + 1
    hist = {}
    for n in edges.values():
        hist[n] = hist.get(n, 0) + 1
    closed = sum(1 for n in edges.values() if n == 2)
    total = len(edges)
    rep.note(
        f"{name}: undirected-edge multiplicity",
        "edges={} used-2(watertight)={} ({:.1f}%) histogram(top)={}".format(
            total,
            closed,
            100.0 * closed / max(1, total),
            sorted(hist.items(), key=lambda kv: -kv[1])[:4],
        ),
    )
    if closed == total and total:
        rep.note(f"{name}: watertight", "YES -- every undirected edge is used exactly twice")
    else:
        rep.note(
            f"{name}: watertight",
            "NO (expected for prism-from-rectangle-cover meshes: shared walls make "
            "edges appear 4x). No manifold claim is made anywhere in this repo.",
        )


def selftest(path, rep):
    """Prove the checks are load-bearing: break copies in memory and require failure."""
    raw = open(path, "rb").read()
    cases = {
        "truncate one triangle": raw[:-50],
        "flip the u32 triangle count": raw[:80] + struct.pack("<I", 999) + raw[84:],
        "zero a normal": raw[:84] + b"\x00\x00\x00\x00" * 3 + raw[84 + 12:],
        "corrupt the magic": b"XXKT" + raw[4:],
    }
    for name, blob in cases.items():
        r2 = Report()
        parsed = parse(blob, r2, "corrupt")
        if parsed is not None:
            check_geometry("corrupt", parsed[0] if isinstance(parsed, tuple) else parsed, r2)
        caught = r2.failed
        rep.check(f"selftest: '{name}' is caught", caught, "no check failed -- the verifier is decorative" if not caught else "")


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    do_selftest = "--selftest" in argv
    if not args:
        print(__doc__)
        return 2
    rep = Report()
    for path in args:
        name = path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        try:
            raw = open(path, "rb").read()
        except OSError as e:
            rep.check(f"{name}: readable", False, str(e))
            continue
        parsed = parse(raw, rep, name)
        if parsed is None:
            continue
        tris = parsed[1]
        check_geometry(name, {"count": parsed[0]["count"], "tris": tris}, rep)
        print(f"  {name}: {parsed[0]['count']} triangles, {len(raw)} bytes, solid={parsed[0]['fields'].get('solid')}")
    if do_selftest:
        selftest(args[0], rep)
    rep.dump()
    print("STL VERIFY:", "FAIL" if rep.failed else "PASS")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
