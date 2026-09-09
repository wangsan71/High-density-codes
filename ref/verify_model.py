#!/usr/bin/env python3
"""ref/verify_model.py —— PSKT 板材产物的**独立**校验器（G8 的 Python 侧）。

只用标准库（zipfile / struct / zlib / hashlib / xml.etree / json / math），
**不 import、不读取、不执行任何 core/** 的 JS**：判据全部从文件本身重新算一遍，
所以它抓到的是"JS 那一侧真的算错了"，而不是"两边共享同一个 bug"。
（独立性纪律见 ref/README.md；这是 decode.py 用纯 Python 重画点阵的同一套做法。）

它覆盖 STL 与 3MF 两条产物，因此是本目录**唯一**的模型校验入口
（`ref/verify_stl.py` 现在只是它的一个薄壳）。

跑法：
    python ref/verify_model.py                       # 自动找 .tmp/m5verify 里第一个页
    python ref/verify_model.py --dir artifacts/xxx   # 指定目录
    python ref/verify_model.py --3mf a.3mf --stl a.stl --facts a.model-facts.json
    python ref/verify_model.py --selftest            # 造坏副本，断言校验器**必须**失败

每条检查都打 `PASS|FAIL <id> <数字>`；末尾 `RESULT: PASS|FAIL`。
退出码 0 = 全过，1 = 有失败，2 = 用法/文件问题。
"""

import argparse
import hashlib
import io
import json
import math
import os
import struct
import sys
import zipfile
import zlib
import xml.etree.ElementTree as ET

try:  # Windows 控制台默认 CP1252/GBK，会把 § 和中文打成乱码；报告本身是 UTF-8 的。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001 - 老版本或重定向时无所谓
    pass

CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
START_REL_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
MODEL_CONTENT_TYPE = "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
MODEL_PART = "3D/3dmodel.model"
CT_PART = "[Content_Types].xml"
RELS_PART = "_rels/.rels"
FIXED_DOS = (1980, 1, 1, 0, 0, 0)

# 几何/数值容差。STL 存 float32：182.88 mm 处的半个 ULP 约 7.3e-6 mm，
# 所以下面这些常数都远大于表示误差、远小于任何真实缺陷（最小 EW 0.26 mm）。
STL_SIZE_TOL_MM = 1e-3  # 包围盒与版面尺寸的容差
STL_NORMAL_TOL = 1e-3  # 法向与右手序重算值的容差（float32 归一化）
DEGENERATE_AREA = 1e-9  # 面积小于此值算退化三角形
SAME_MESH_TOL_MM = 1e-3  # STL 与 3MF 同一批三角形的最大坐标/质心偏差（float32 噪声约 7e-6）
PROJ_TOL_PCT = 8.0  # G8 §6.3：逐格投影面积差 <8%


class Report:
    """检查结果的收集器（selftest 要按 id 反查，所以每条都有名字）。"""

    def __init__(self, verbose=True):
        self.rows = []
        self.verbose = verbose

    def add(self, cid, ok, detail=""):
        self.rows.append((cid, bool(ok), detail))
        if self.verbose:
            print("%-4s %-34s %s" % ("PASS" if ok else "FAIL", cid, detail))
        return ok

    @property
    def failures(self):
        return [r for r in self.rows if not r[1]]

    def summary(self):
        bad = self.failures
        print("-" * 78)
        print("RESULT: %s  (%d checks, %d failed)" % ("FAIL" if bad else "PASS", len(self.rows), len(bad)))
        for cid, _, detail in bad:
            print("  failed: %s  %s" % (cid, detail))
        return 0 if not bad else 1


# ───────────────────────────────────────────────────────── 小工具


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def tri_normal(a, b, c):
    return cross(sub(b, a), sub(c, a))


def tri_area2(a, b, c):
    n = tri_normal(a, b, c)
    return math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])


def signed_volume(tris):
    """Σ a·(b×c)/6：闭曲面朝外定向时为正（散度定理），与边计数**互相独立**。"""
    v = 0.0
    for (a, b, c) in tris:
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return v


def key_of(p):
    """把顶点量化成整数键（微米）。焊接后的坐标本来就是 1e-6 的整数倍。"""
    return (round(p[0] * 1e6), round(p[1] * 1e6), round(p[2] * 1e6))


def edge_census(tris):
    """无向边重数直方图 + 有向反向一致性。

    返回 (hist, used_once, used_2, used_over, inconsistent, directed_pairs)
    hist: dict[int 重数 -> 条数]；inconsistent: 两条三角形没有**反向**共用那条边的边数。
    """
    undirected = {}
    directed = {}
    for i, (a, b, c) in enumerate(tris):
        ka, kb, kc = key_of(a), key_of(b), key_of(c)
        for p, q in ((ka, kb), (kb, kc), (kc, ka)):
            uk = (p, q) if p <= q else (q, p)
            undirected[uk] = undirected.get(uk, 0) + 1
            directed[(p, q)] = directed.get((p, q), 0) + 1
    hist = {}
    once = twice = over = 0
    for n in undirected.values():
        hist[n] = hist.get(n, 0) + 1
        if n == 1:
            once += 1
        elif n == 2:
            twice += 1
        else:
            over += 1
    inconsistent = 0
    for (p, q), n in undirected.items():
        if directed.get((p, q), 0) != 1 or directed.get((q, p), 0) != 1:
            inconsistent += 1
    return hist, once, twice, over, inconsistent, len(undirected)


def link_defects(tris):
    """每个顶点的**链接**必须是单个环。抓的是"两个壳只共一个顶点"的捏合点：
    那种网格每条无向边都恰好两次、体积为正、定向一致 —— 只有这里抓得住。"""
    star = {}
    for (a, b, c) in tris:
        ka, kb, kc = key_of(a), key_of(b), key_of(c)
        star.setdefault(ka, []).append((kb, kc))
        star.setdefault(kb, []).append((kc, ka))
        star.setdefault(kc, []).append((ka, kb))
    bad = 0
    for _, pairs in star.items():
        nbr = {}
        for p, q in pairs:
            nbr.setdefault(p, []).append(q)
            nbr.setdefault(q, []).append(p)
        nodes = len(nbr)
        if nodes == 0:
            continue
        ok = all(len(v) == 2 for v in nbr.values())
        if ok:
            start = next(iter(nbr))
            seen = {start}
            stack = [start]
            while stack:
                x = stack.pop()
                for y in nbr[x]:
                    if y not in seen:
                        seen.add(y)
                        stack.append(y)
            ok = len(seen) == nodes
        if not ok:
            bad += 1
    return bad, len(star)


def components_of(tris):
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for (a, b, c) in tris:
        ka, kb, kc = key_of(a), key_of(b), key_of(c)
        union(ka, kb)
        union(ka, kc)
    roots = set()
    for k in list(parent):
        roots.add(find(k))
    return len(roots)


def clip_area(poly, rect):
    """Sutherland–Hodgman：多边形裁到轴对齐矩形后的面积（投影分账用）。"""
    x_min, y_min, x_max, y_max = rect
    for coord, bound, keep_min in ((0, x_min, True), (0, x_max, False), (1, y_min, True), (1, y_max, False)):
        out = []
        n = len(poly)
        for i in range(n):
            ax, ay = poly[i][coord], poly[(i + 1) % n][coord]
            a_in = ax >= bound if keep_min else ax <= bound
            b_in = ay >= bound if keep_min else ay <= bound
            if a_in:
                out.append(poly[i])
            if a_in != b_in:
                t = (bound - ax) / (ay - ax) if ay != ax else 0.0
                px = poly[i][0] + t * (poly[(i + 1) % n][0] - poly[i][0])
                py = poly[i][1] + t * (poly[(i + 1) % n][1] - poly[i][1])
                out.append((px, py))
        poly = out
        if len(poly) < 3:
            return 0.0
    a = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2.0


# ───────────────────────────────────────────────────── STL 检查


def parse_stl(data, rep, prefix="stl"):
    """读二进制 STL；返回三角形列表或 None。顺带做 G8 §6.1 的长度/头部检查。"""
    if len(data) < 84:
        rep.add("%s/size" % prefix, False, "only %d bytes" % len(data))
        return None
    header = data[:80]
    (declared,) = struct.unpack_from("<I", data, 80)
    count = declared
    expected = 84 + 50 * count
    rep.add("%s/84+50n" % prefix, len(data) == expected, "%d bytes, header says %d tris -> %s" % (len(data), count, expected))
    # 长度不对也不能崩：把可解析的部分照常读完，让上面那条 FAIL 去说话
    # （一个会抛异常糊过去的坏文件和一个会拒绝的好文件，是同一类失败）。
    count = min(count, max(0, (len(data) - 84) // 50))
    text = header.split(b"\x00")[0].decode("ascii", "replace")
    fields = {}
    is_pskt = text.startswith("PSKT/")
    for part in text.split(";")[1:]:
        if "=" in part:
            k, v = part.split("=", 1)
            fields[k] = v
    rep.add("%s/header-parses" % prefix, is_pskt and "units" in fields and "tri" in fields, "solid=%s units=%s tri=%s" % (fields.get("solid"), fields.get("units"), fields.get("tri")))
    rep.add("%s/units-mm" % prefix, fields.get("units") == "mm", "header units=%r" % fields.get("units"))
    rep.add("%s/tri-field-matches" % prefix, fields.get("tri") == str(declared), "header tri=%r vs u32=%d" % (fields.get("tri"), declared))
    tris = []
    bad_normals = 0
    degenerate = 0
    non_finite = 0
    attrs_set = 0
    for t in range(count):
        o = 84 + 50 * t
        vals = struct.unpack_from("<12fH", data, o)
        n = vals[0:3]
        a, b, c = vals[3:6], vals[6:9], vals[9:12]
        if vals[12] != 0:
            attrs_set += 1
        if not all(math.isfinite(v) for v in (a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], n[0], n[1], n[2])):
            non_finite += 1
            continue
        if tri_area2(a, b, c) <= DEGENERATE_AREA:
            degenerate += 1
            tris.append((a, b, c))
            continue
        calc = tri_normal(a, b, c)
        length = math.sqrt(calc[0] ** 2 + calc[1] ** 2 + calc[2] ** 2)
        unit = tuple(v / length for v in calc)
        if max(abs(unit[i] - n[i]) for i in range(3)) > STL_NORMAL_TOL:
            bad_normals += 1
        tris.append((a, b, c))
    rep.add("%s/no-non-finite" % prefix, non_finite == 0, "%d non-finite vertices" % non_finite)
    rep.add("%s/no-degenerate" % prefix, degenerate == 0, "%d degenerate triangles (area <= %g)" % (degenerate, DEGENERATE_AREA))
    rep.add("%s/normal-matches-right-hand-order" % prefix, bad_normals == 0, "%d/%d stored normals disagree with cross(b-a, c-a)" % (bad_normals, count))
    rep.add("%s/attribute-byte-zero" % prefix, attrs_set == 0, "%d/%d triangles carry a non-zero attribute byte count" % (attrs_set, count))
    return tris


def check_stl(tris, facts, rep, prefix="stl"):
    if tris is None:
        return None
    hist, once, twice, over, inconsistent, edges = edge_census(tris)
    total = len(tris)
    pct = 100.0 * twice / max(1, edges)
    rep.add(
        "%s/edge-census" % prefix,
        once == 0 and over == 0 and inconsistent == 0,
        "%d tris, %d undirected edges, %d used 2x (%.2f%%), %d once, %d >2x, %d orientation-inconsistent; histogram=%s"
        % (total, edges, twice, pct, once, over, inconsistent, sorted(hist.items())),
    )
    vol = signed_volume(tris)
    rep.add("%s/signed-volume-positive" % prefix, vol > 0, "volume = %.6f mm^3 (outward orientation by the right-hand rule)" % vol)
    bad, vtotal = link_defects(tris)
    rep.add("%s/vertex-links" % prefix, bad == 0, "%d/%d vertices whose link is not a single cycle" % (bad, vtotal))
    comps = components_of(tris)
    vset = set()
    for (a, b, c) in tris:
        vset.update(key_of(a), key_of(b), key_of(c))
    euler = len(vset) - edges + total
    # Euler 特征只报告、不硬判（MESH-CONTRACT §6.2）：这里的数由"每格 1 个环 + 点档 1 个圆点 +
    # 1 个底板"决定：环壳 χ=0（环带挤出体是环面！）、圆盘壳 χ=2、底板 χ=2。
    rep.add("%s/euler-reported" % prefix, True, "V=%d E=%d F=%d -> chi=%d, %d closed shells (informational, not gated)" % (len(vset), edges, total, euler, comps))
    mn = [min(p[i] for t in tris for p in t) for i in range(3)]
    mx = [max(p[i] for t in tris for p in t) for i in range(3)]
    size = [mx[i] - mn[i] for i in range(3)]
    page = facts["pageMm"]
    rep.add("%s/bbox-xy-equals-page" % prefix, abs(size[0] - page["w"]) < STL_SIZE_TOL_MM and abs(size[1] - page["h"]) < STL_SIZE_TOL_MM,
            "mesh %.4f x %.4f mm vs page %.4f x %.4f mm (dev %.1e / %.1e mm)" % (size[0], size[1], page["w"], page["h"], abs(size[0] - page["w"]), abs(size[1] - page["h"])))
    zexpect = facts["plateMm"] + facts["shapeLevels"] * facts["reliefMm"] - (facts["inkSunkMm"] if facts.get("sinkActive") else 0.0)
    top_real = max(c[4] for c in facts["cells"])
    rep.add("%s/bbox-z" % prefix, abs(mn[2]) < 1e-9 and abs(mx[2] - top_real) < STL_SIZE_TOL_MM,
            "z in [%.6f, %.4f]; bed at 0, highest relief top %.4f mm (nominal max %.4f)" % (mn[2], mx[2], top_real, zexpect))
    return (tris, size, mn, mx)


# ───────────────────────────────────────────────────── 3MF 检查


def check_3mf_zip(data, rep, prefix="3mf"):
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001 - 任何解析失败都是要点
        rep.add("%s/zip-opens" % prefix, False, repr(e))
        return None, {}
    infos = zf.infolist()
    names = [i.filename for i in infos]
    rep.add("%s/zip-opens" % prefix, True, "%d entries: %s" % (len(names), ", ".join(names)))
    rep.add("%s/part-order" % prefix, names == [CT_PART, RELS_PART, MODEL_PART], "actual=%s" % names)
    parts = {}
    stamps_ok = True
    crc_ok = True
    method_ok = True
    local_ok = True
    local_err = ""
    for info in infos:
        try:
            raw = zf.read(info.filename)  # zipfile 校验本地头魔数与 CRC；这里再显式算一遍 CRC
        except Exception as e:  # noqa: BLE001 - 本地头坏了就是坏文件
            local_ok = False
            local_err = repr(e)
            parts[info.filename] = b""
            continue
        if (info.date_time) != FIXED_DOS:
            stamps_ok = False
        if zlib.crc32(raw) != info.CRC:
            crc_ok = False
        if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            method_ok = False
        parts[info.filename] = raw
        if rep.verbose:
            print(
                "     %-26s method=%d %d/%d B crc=%08x date=%s"
                % (info.filename, info.compress_type, info.compress_size, info.file_size, info.CRC, info.date_time)
            )
    rep.add("%s/local-headers-readable" % prefix, local_ok, "central directory ok but a local header was refused: %s" % local_err if not local_ok else "all %d local headers consistent" % len(infos))
    rep.add("%s/fixed-dos-timestamp" % prefix, stamps_ok, "every entry carries %s (no build time in the file)" % (FIXED_DOS,))
    rep.add("%s/crc32-matches-python-zlib" % prefix, crc_ok, "stored CRC == zlib.crc32(content) for all entries (cross-validates core/crc.js)")
    rep.add("%s/method-known" % prefix, method_ok, "only store(0)/deflate(8) appear (cross-validates core/deflate.js)")
    return zf, parts


def local_headers_deterministic(data, rep):
    """直接扫本地文件头：时间/日期/extra 字段必须全部是写死的值（确定性证据）。

    中央目录里的东西 Python 的 zipfile 已经读过了；本地头是"同一个条目的第二份记录"，
    两边对不上就是文件自相矛盾 —— 所以这里手动解，不用 zipfile。
    """
    ok = True
    details = []
    n = 0
    i = 0
    while i + 30 <= len(data) and struct.unpack_from("<I", data, i)[0] == 0x04034B50:
        # local file header: sig(4) ver(2) flags(2) method(2) mtime(2) mdate(2) crc(4)
        #                     csize(4) usize(4) nlen(2) elen(2)
        (method, mtime, mdate, crc, csize, usize, nlen, elen) = struct.unpack_from("<HHHIIIHH", data, i + 8)
        if mtime != 0 or mdate != 0x21 or elen != 0:
            ok = False
        n += 1
        details.append("crc=%08x m=%d t=%d d=%d extra=%d" % (crc, method, mtime, mdate, elen))
        i += 30 + nlen + elen + csize
    rep.add("3mf/local-headers-fixed", ok and n == 3, "%d local headers scanned: %s" % (n, "; ".join(details)))
    return ok


def strip_ns(tag):
    return tag.split("}")[-1]


def parse_model(raw, rep, prefix="3mf"):
    text = raw.decode("utf-8")
    try:
        root = ET.fromstring(text)
    except Exception as e:  # noqa: BLE001
        rep.add("%s/model-xml-parses" % prefix, False, repr(e))
        return None
    rep.add("%s/model-xml-parses" % prefix, strip_ns(root.tag) == "model" and root.tag == "{%s}model" % CORE_NS,
            "root=%s namespace=%s" % (strip_ns(root.tag), root.tag[1:].split("}")[0] if root.tag.startswith("{") else "(none)"))
    unit = root.get("unit")
    rep.add("%s/unit-millimeter" % prefix, unit == "millimeter", 'unit=%r (3MF core 1.4 CT_Model; the schema has NO zUp attribute, so +Z-up is what §3.1 fixes, not something we may flip)' % unit)
    rep.add("%s/no-zUp-attribute" % prefix, root.get("zUp") is None, "zUp=%r" % root.get("zUp"))
    resources = root.find("{%s}resources" % CORE_NS)
    if resources is None:
        rep.add("%s/resources" % prefix, False, "no <resources>")
        return None
    defs = [strip_ns(e.tag) for e in resources]
    bm_index = [i for i, t in enumerate(defs) if t == "basematerials"]
    obj_index = [i for i, t in enumerate(defs) if t == "object"]
    rep.add("%s/define-before-use" % prefix, (not bm_index) or min(bm_index) < min(obj_index),
            "resources order=%s (spec §3.4: referenced elements come first)" % defs)
    materials = []
    if bm_index:
        bm = resources[bm_index[0]]
        for base in bm:
            if strip_ns(base.tag) == "base":
                materials.append((base.get("name"), base.get("displaycolor")))
    objects = []
    for i in obj_index:
        obj = resources[i]
        oid = obj.get("id")
        name = obj.get("name")
        otype = obj.get("type")
        pid, pindex = obj.get("pid"), obj.get("pindex")
        mesh = obj.find("{%s}mesh" % CORE_NS)
        vs = mesh.find("{%s}vertices" % CORE_NS) if mesh is not None else None
        ts = mesh.find("{%s}triangles" % CORE_NS) if mesh is not None else None
        verts = [(float(v.get("x")), float(v.get("y")), float(v.get("z"))) for v in (vs or [])]
        idx = [(int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))) for t in (ts or [])]
        objects.append({"id": oid, "name": name, "type": otype, "pid": pid, "pindex": pindex, "vertices": verts, "indices": idx})
        declared_v = len(verts)
        declared_t = len(idx)
        bad_idx = [k for k, tri in enumerate(idx) if any(c < 0 or c >= declared_v for c in tri)]
        rep.add("3mf/object[%s]:indices" % name, not bad_idx, "%d verts, %d tris, %d out-of-range index triples" % (declared_v, declared_t, len(bad_idx)))
        rep.add("3mf/object[%s]:type-model" % name, otype == "model", "type=%r id=%s pid=%s pindex=%s material=%s" % (otype, oid, pid, pindex, materials[int(pindex)][0] if pindex is not None and int(pindex) < len(materials) else None))
        if pindex is not None and (pid is None or int(pindex) >= len(materials)):
            rep.add("3mf/object[%s]:material-ref" % name, False, "pid=%s pindex=%s with %d materials" % (pid, pindex, len(materials)))
    rep.add("%s/materials" % prefix, len(materials) >= 1, "%d base materials: %s" % (len(materials), ", ".join("%s=%s" % m for m in materials)))
    build = root.find("{%s}build" % CORE_NS)
    items = [i.get("objectid") for i in (build or [])]
    ids = [o["id"] for o in objects]
    rep.add("%s/build-items" % prefix, len(items) == len(ids) and set(items) == set(ids), "<build> item ids %s vs object ids %s" % (items, ids))
    return {"objects": objects, "materials": materials}


def check_3mf_objects(model, facts, rep):
    all_tris = []
    for obj in model["objects"]:
        tris = []
        degen = 0
        v = obj["vertices"]
        for (a, b, c) in obj["indices"]:
            t = (v[a], v[b], v[c])
            if tri_area2(*t) <= DEGENERATE_AREA:
                degen += 1
            tris.append(t)
        hist, once, twice, over, inconsistent, edges = edge_census(tris)
        vol = signed_volume(tris)
        bad, vtotal = link_defects(tris)
        comps = components_of(tris)
        euler = len(v) - edges + len(tris)
        is_base = obj["name"] == "plate-base"
        # 判据本体：每条无向边恰被两个三角形**反向**共用（MESH-CONTRACT §5/§6.2）。
        rep.add("3mf/watertight[%s]" % obj["name"], once == 0 and over == 0 and inconsistent == 0 and degen == 0,
                "%d tris, %d edges: %d once / %d twice / %d >2x, %d inconsistent, %d degenerate; hist=%s"
                % (len(tris), edges, once, twice, over, inconsistent, degen, sorted(hist.items())))
        rep.add("3mf/volume[%s]" % obj["name"], vol > 0, "signed volume %.6f mm^3" % vol)
        rep.add("3mf/links[%s]" % obj["name"], bad == 0, "%d/%d vertices with a non-cycle link" % (bad, vtotal))
        rep.add("3mf/euler[%s]" % obj["name"], True, "chi=%d, %d shells (reported, not gated; %s)" % (euler, comps, "base box -> chi 2 expected" if is_base else "ring shells chi 0, dot shells chi 2"))
        obj["tris"] = tris
        obj["is_base"] = is_base
        all_tris.extend(tris)
    total = len(all_tris)
    rep.add("3mf/declares-every-cell", total > 0, "%d triangles across %d objects" % (total, len(model["objects"])))
    return all_tris


# ───────────────────────────────────────────────── 两个产物同源 + 投影对拍


def check_same_mesh(stl_tris, model_tris, rep):
    rep.add("cross/same-triangle-count", len(stl_tris) == len(model_tris), "stl %d vs 3mf %d triangles" % (len(stl_tris), len(model_tris)))
    if len(stl_tris) != len(model_tris) or not stl_tris:
        return
    max_dev = 0.0
    worst = None
    for i, (s, m) in enumerate(zip(stl_tris, model_tris)):
        for k in range(3):
            for d in range(3):
                dev = abs(s[k][d] - m[k][d])
                if dev > max_dev:
                    max_dev = dev
                    worst = (i, k, d, s[k][d], m[k][d])
    # 主判据：两个写手吃的是同一批三角形、同一个顺序（plate.js 给的那一份），所以
    # 序号 i 的三角形必须逐点对得上。容差 1e-3 mm 远大于 float32 在 182 mm 处的
    # 半 ULP（约 7e-6 mm），又远小于任何真实缺陷（最小 EW 0.26 mm）。
    rep.add("cross/same-triangles-in-order", max_dev <= SAME_MESH_TOL_MM,
            "max per-coordinate deviation %.3e mm at tri %d vertex %d comp %d (%.6f vs %.6f); tol %.1e"
            % (max_dev, worst[0] if worst else -1, worst[1] if worst else -1, worst[2] if worst else -1, worst[3] if worst else 0, worst[4] if worst else 0, SAME_MESH_TOL_MM))
    # 辅助判据：顺序无关的比对。**不**用"量化分箱后比重集" —— STL 存 float32、3MF 存
    # 6 位小数文本，落在分箱边界上的坐标（z=2.55 mm 就是一个）必然有一边跳一格，实测
    # 每页有上百个这样的边界点，分箱法在这两种表示之间天然不稳。
    # 换成"把每个三角形的质心与面积排序后逐元素比"：顺序无关，且容差直接是 mm，
    # 两个真相同的三角形集合排序后必然对齐（相邻的近似全等三角形最多互换位置，
    # 互换后逐元素偏差仍然 < 容差）。
    def signature(tris):
        # 只用质心：面积要进签名的话就得处理相对误差（底板那两个大三角形面积 1.6e4 mm²，
        # float32 的坐标噪声带出 3e-3 mm² 的面积噪声，绝对容差 1e-3 会假报警）。
        # "同一批三角形"的精确性由上面那条**同序号逐点**检查负责，这条只管顺序无关的
        # 位置集合是否一致。
        s = []
        for (a, b, c) in tris:
            s.append(((a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0))
        s.sort()
        return s

    # 排序后**带窗口**对齐：直接逐元素比会假报警 —— 两个三角形可能只在第一排序键上
    # 几乎相等（底板那两个大三角形的 cx 就是一样的），float32 噪声一 flip 顺序，
    # 逐元素比就把 A 对上了 B（实测报出 100 mm 的假偏差）。所以每个元素只在它排序位
    # 置附近 ±W 的窗口里找最接近的未使用元素。
    sa = signature(stl_tris)
    sb = signature(model_tris)
    # 匹配算法第 77 轮换过一次（**判据没变**：unmatched == 0 且 dev <= SAME_MESH_TOL_MM）。
    # 原来是"按排序位 ±64 的窗口里找最近的未用元素"，那是一个贪心匹配：第 77 轮给数据板加了
    # 四角标记后，末尾 56 个三角形配不到对（实测 max deviation 169.8mm、worst 把
    # (177.09, 8.52) 配到了 (185.67, 178.34)）—— 不是几何不同（同序号逐点那条 max 1e-3 通过），
    # 而是贪心把窗口里的候选先用掉了、尾巴上剩下的永远配不上。
    # 换成按**坐标分箱**（3 位小数，查 3×3×3 邻域，边界跳格由邻域吸收），每个三角形只在
    # 自己那一格及其邻格里找未用的最近质心。判据一字未改，只是**找得到**真正的对手。
    buckets = {}
    for j, p in enumerate(sb):
        k = (round(p[0], 3), round(p[1], 3), round(p[2], 3))
        buckets.setdefault(k, []).append(j)
    used = [False] * len(sb)
    dev = 0.0
    worst = None
    unmatched = 0
    for i, x in enumerate(sa):
        cx, cy, cz = round(x[0], 3), round(x[1], 3), round(x[2], 3)
        best_j = -1
        best_d = None
        for dx in (-0.001, 0.0, 0.001):
            for dy in (-0.001, 0.0, 0.001):
                for dz in (-0.001, 0.0, 0.001):
                    for j in buckets.get((round(cx + dx, 3), round(cy + dy, 3), round(cz + dz, 3)), ()):
                        if used[j]:
                            continue
                        d = max(abs(x[k] - sb[j][k]) for k in range(3))
                        if best_d is None or d < best_d:
                            best_d = d
                            best_j = j
                            if d == 0.0:
                                break
        if best_j < 0 or best_d > SAME_MESH_TOL_MM:
            unmatched += 1
            continue
        used[best_j] = True
        if best_d > dev:
            dev = best_d
            worst = (i, best_j, x, sb[best_j])
    rep.add("cross/same-triangle-multiset", unmatched == 0 and dev <= SAME_MESH_TOL_MM,
            "order-independent centroid multiset (keyed by 3-decimal coordinate buckets, 3x3x3 neighbourhood): "
            "max deviation %.3e mm, %d unmatched of %d"
            % (dev, unmatched, len(sa)))


def check_projection(model_tris, facts, rep):
    """G8 §6.3：把 3MF 的顶面三角形投影回格子网格，逐格复现渲染页掩码。

    这里**不**用 JS 记在 facts 里的面积当唯一期望值：
      * 判据（<8%）比的是 `facts.reference` —— 渲染器自己那份 `buildCoverageTiles` 的面积；
      * 同时用纯 Python 的**理想圆面积** π(Ro²−Ri²)+πRd² 独立算第二份参考，两个参考
        必须互相靠拢（差值是光栅 4× 超采样的量化噪声），否则说明有一侧在编数；
      * 落格按几何裁剪分账（跨格就分给相邻格），所以半径改大一定会在邻格露出来。
    """
    cols, rows = facts["cols"], facts["rows"]
    pitch = facts["pitchMmPrinted"]
    ox, oy = facts["originMm"]["x"], facts["originMm"]["y"]
    page_h = facts["pageMm"]["h"]
    plate = facts["plateMm"]
    levels = {}
    for c in facts["cells"]:
        # facts.cells 的每一行是 [col, row, shapeLevel, colourLevel, topMm]
        levels[c[1] * cols + c[0]] = c[2]
    ref = [r["areaMm2"] for r in facts["reference"]]
    geo = facts["glyph"]
    analytic = []
    for lv in range(facts["shapeLevels"]):
        dot = (geo["dot"] or [])[lv] if geo.get("dot") else 0.0
        analytic.append(math.pi * ((geo["outer"] ** 2 - geo["inner"] ** 2) + dot ** 2) * pitch * pitch)
    mesh = {}
    straddling = 0
    up = 0
    outside = 0.0
    # 四角标记（D68，第 77 轮）：它们**按设计**在点阵之外的静区里。只有在 facts 声明了它们的
    # 位置时才从"点阵外材料"里排除，且每个被声明的标记必须真的在、面积也对得上 —— 否则
    # "排除"就成了判据上的一个洞，而不是关于产物的陈述。容差 1µm：待判的网格是**焊接过**的
    # （坐标 6 位小数），顶点可能落在声明框外最多 5e-7mm。
    marker_boxes = facts.get("markers") or []
    marker_meas = [0.0] * len(marker_boxes)
    marker_tris = [0] * len(marker_boxes)
    marker_tol = 1e-3

    def marker_index(a, b, c):
        for mi, m in enumerate(marker_boxes):
            o = m["outerMm"]
            x0, x1, y0, y1 = o["x0"], o["x1"], o["y0"], o["y1"]
            if all(x0 - marker_tol <= p[0] <= x1 + marker_tol and y0 - marker_tol <= p[1] <= y1 + marker_tol for p in (a, b, c)):
                return mi
        return None

    for (a, b, c) in model_tris:
        nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if nz <= 0:
            continue  # 侧壁投影面积为 0；底面朝 -Z
        if max(a[2], b[2], c[2]) <= plate:
            continue  # 底板顶面不是浮雕
        up += 1
        if marker_boxes:
            mi = marker_index(a, b, c)
            if mi is not None:
                marker_meas[mi] += nz / 2.0
                marker_tris[mi] += 1
                continue
        xs = [a[0], b[0], c[0]]
        ys = [a[1], b[1], c[1]]
        c0 = int(math.floor((min(xs) - ox) / pitch))
        c1 = int(math.floor((max(xs) - ox) / pitch))
        r0 = int(math.floor((page_h - max(ys) - oy) / pitch))
        r1 = int(math.floor((page_h - min(ys) - oy) / pitch))
        poly = list(zip(xs, ys))
        if c0 == c1 and r0 == r1 and 0 <= c0 < cols and 0 <= r0 < rows:
            mesh[(r0 * cols + c0)] = mesh.get(r0 * cols + c0, 0.0) + nz / 2.0
            continue
        straddling += 1
        inside = 0.0
        for r in range(max(0, min(r0, r1)), min(rows, max(r0, r1) + 1)):
            for cc in range(max(0, min(c0, c1)), min(cols, max(c0, c1) + 1)):
                rect = (ox + cc * pitch, page_h - (oy + (r + 1) * pitch), ox + (cc + 1) * pitch, page_h - (oy + r * pitch))
                area = clip_area(poly, rect)
                inside += area
                if area:
                    mesh[r * cols + cc] = mesh.get(r * cols + cc, 0.0) + area
        outside += max(0.0, nz / 2.0 - inside)
    pcts = []
    pcts_analytic = []
    worst = None
    over = 0
    missing = 0
    for key, shape in levels.items():
        cell_index = shape
        want = ref[cell_index]
        got = mesh.get(key, 0.0)
        if want <= 0:
            missing += 1
            continue
        pct = abs(got - want) / want * 100.0
        pa = abs(got - analytic[cell_index]) / analytic[cell_index] * 100.0
        pcts.append(pct)
        pcts_analytic.append(pa)
        if pct >= PROJ_TOL_PCT:
            over += 1
        if worst is None or pct > worst[0]:
            worst = (pct, key, shape, got, want)
    n = max(1, len(pcts))
    rep.add("g8-3/cells-measured", len(pcts) == cols * rows, "%d of %d lattice cells compared, %d with a non-positive reference" % (len(pcts), cols * rows, missing))
    rep.add("g8-3/projection-area-error", over == 0 and len(pcts) == cols * rows,
            "max %.3f%% mean %.3f%% over %d cells, %d/%d cells >= %.0f%% (worst cell %s level %d: mesh %.4f mm^2 vs raster %.4f mm^2) [measured from the 3MF, %d up-facing triangles]"
            % (max(pcts) if pcts else 999.0, sum(pcts) / n, n, over, len(pcts), PROJ_TOL_PCT, worst[1] if worst else "-", worst[2] if worst else -1, worst[3] if worst else 0, worst[4] if worst else 0, up))
    rep.add("g8-3/second-reference-analytic-circles", max(pcts_analytic) < PROJ_TOL_PCT if pcts_analytic else False,
            "same mesh areas vs pure-Python ideal-circle areas: max %.3f%% mean %.3f%% (raster-vs-analytic disagreement itself: the two references agree to that order)"
            % (max(pcts_analytic) if pcts_analytic else 999.0, sum(pcts_analytic) / n))
    rep.add("g8-3/no-straddling-material", straddling == 0 and outside < 1e-9, "%d triangles cross a cell boundary, %.3e mm^2 of material outside the lattice (markers excluded: %d declared)" % (straddling, outside, len(marker_boxes)))
    # 每个被声明的标记必须真的在、面积对得上：这条让"标记被排除"成为被检查的陈述，而不是洞。
    if marker_boxes:
        bad_marker = []
        for mi, m in enumerate(marker_boxes):
            want = float(m.get("expectedMm2") or 0.0)
            got = marker_meas[mi]
            pct = abs(got - want) / want * 100.0 if want > 1e-9 else (0.0 if got <= 1e-9 else 999.0)
            if pct >= PROJ_TOL_PCT or marker_tris[mi] == 0:
                bad_marker.append("%s(got %.4f want %.4f, %.2f%%, %d tris)" % (m.get("role", "?"), got, want, pct, marker_tris[mi]))
        rep.add("g8-3/marker-material", not bad_marker,
                "%d marker(s) measured, areas vs declared: %s%s" % (
                    len(marker_boxes),
                    ", ".join("%s=%.4f" % (m.get("role", "?"), marker_meas[i]) for i, m in enumerate(marker_boxes)),
                    "" if not bad_marker else " -- BAD: " + "; ".join(bad_marker)))
    # 逐格"有/无材料"也必须一致：shape 档 0 也画外环，所以任何一格都不该是空的。
    empty = sum(1 for k in levels if mesh.get(k, 0.0) <= 0.0)
    rep.add("g8-3/every-cell-has-relief", empty == 0, "%d lattice cells with no projected relief area (level 0 still carries the outer ring)" % empty)


# ─────────────────────────────────────────────────────── 驱动


def verify(stl_path, mf_path, facts_path, rep, require_both=True):
    facts = json.load(open(facts_path, "r", encoding="utf-8"))
    rep.add("facts/loaded", True, "%s: %s plate=%gmm relief=%gmm sink=%gmm quiet=%gmm cols=%d rows=%d dpi=%g cellPx=%d" % (
        os.path.basename(facts_path), facts["profile"], facts["plateMm"], facts["reliefMm"], facts["inkSunkMm"], facts["quietMm"], facts["cols"], facts["rows"], facts["dpi"], facts["cellPx"]))
    stl_data = open(stl_path, "rb").read() if stl_path else None
    mf_data = open(mf_path, "rb").read() if mf_path else None

    stl_tris = None
    if stl_data is None and require_both:
        # "没法查"永远不算成功：只发 --format 3mf 的目录里没有 STL，那半边判据（含两条
        # 产物对拍）根本没跑，必须红，而不是安静地少几条 PASS。
        rep.add("stl/present", False, "no .stl beside this dataset -- the STL checks and the cross-checks did not run; pass --stl or generate with --format stl,3mf")
    if mf_data is None and require_both:
        rep.add("3mf/present", False, "no .3mf beside this dataset -- the container/XML checks and the cross-checks did not run")
    if stl_data is not None:
        stl_tris = parse_stl(stl_data, rep, "stl")
        check_stl(stl_tris, facts, rep, "stl")
        rep.add("stl/sha256", True, "%s  %d bytes" % (hashlib.sha256(stl_data).hexdigest()[:12], len(stl_data)))
    if mf_data is not None:
        rep.add("3mf/sha256", True, "%s  %d bytes" % (hashlib.sha256(mf_data).hexdigest()[:12], len(mf_data)))
        zf, parts = check_3mf_zip(mf_data, rep)
        if zf is None:
            return rep
        local_headers_deterministic(mf_data, rep)
        ct = parts.get(CT_PART, b"").decode("utf-8")
        rels = parts.get(RELS_PART, b"").decode("utf-8")
        rep.add("3mf/content-types", MODEL_CONTENT_TYPE in ct, "model content type declared: %s" % (MODEL_CONTENT_TYPE in ct))
        rep.add("3mf/start-part", START_REL_TYPE in rels and ("/" + MODEL_PART) in rels, "relationship type+target present: %s" % (START_REL_TYPE in rels and ("/" + MODEL_PART) in rels))
        model = parse_model(parts[MODEL_PART], rep)
        if model is None:
            return rep
        check_3mf_objects(model, facts, rep)
        if facts.get("trianglesTotal") is not None:
            got = sum(len(o["tris"]) for o in model["objects"])
            rep.add("3mf/triangle-count-matches-facts", got == facts["trianglesTotal"], "%d in the file, facts said %d" % (got, facts["trianglesTotal"]))
        if stl_tris is not None:
            check_same_mesh(stl_tris, [t for o in model["objects"] for t in o["tris"]], rep)
        check_projection([t for o in model["objects"] for t in o["tris"]], facts, rep)
    # 契约里"不许说谎"的那一条：STL 侧的保守声明与实测事实并存
    rep.add("honesty/no-csg-claim", "mergedMeshIsValidUnion" in json.dumps(facts.get("assembly", {})),
            "facts.assembly says the merged mesh has coincident internal faces (not a boolean union); watertightness is asserted per object only")
    return rep


def discover(directory):
    names = sorted(os.listdir(directory))
    mf = [n for n in names if n.endswith(".3mf")]
    stl = [n for n in names if n.endswith(".stl")]
    facts = [n for n in names if n.endswith(".model-facts.json")]
    if not mf and not stl:
        return None, None, None
    pick = (mf or stl)[0]
    stem = pick.rsplit(".", 1)[0]
    return (
        os.path.join(directory, stem + ".stl") if stem + ".stl" in stl else None,
        os.path.join(directory, pick),
        os.path.join(directory, stem + ".model-facts.json") if stem + ".model-facts.json" in facts else None,
    )


# ───────────────────────────────────────────────────────── selftest


def selftest(stl_path, mf_path, facts_path):
    """造坏副本喂回校验器：**它必须失败**。没有这一段，通过就没有意义。

    每个坏本都点名一条检查 id：如果那条检查没红，这一项就判 FAIL ——
    防的是"反例其实根本没碰到判据"。
    """
    stl_data = bytearray(open(stl_path, "rb").read()) if stl_path else None
    mf_data = bytearray(open(mf_path, "rb").read()) if mf_path else None
    facts = json.load(open(facts_path, "r", encoding="utf-8"))
    rep = Report(verbose=False)
    print("selftest: deliberately broken artifacts must be REJECTED")

    def run_stl(data, prefix, want_id):
        r = Report(verbose=False)
        tris = parse_stl(bytes(data), r, prefix)
        check_stl(tris, facts, r, prefix)
        hit = [cid for cid, ok, _ in r.rows if not ok]
        rep.add("selftest/stl-%s" % prefix, bool(hit) and any(want_id in c for c in hit), "failed checks: %s" % (hit[:4] or "NONE -- the validator let it through"))

    def run_3mf(data, prefix, want_id):
        r = Report(verbose=False)
        zf, parts = check_3mf_zip(bytes(data), r, prefix)
        if zf is None:
            rep.add("selftest/3mf-%s" % prefix, True, "zip refused to open (as intended)")
            return
        model = parse_model(parts[MODEL_PART], r, prefix)
        if model is None:
            rep.add("selftest/3mf-%s" % prefix, any(not ok for _, ok, _ in r.rows), "model xml refused to parse (as intended)")
            return
        check_3mf_objects(model, facts, r)
        check_projection([t for o in model["objects"] for t in o["tris"]], facts, r)
        hit = [cid for cid, ok, _ in r.rows if not ok]
        want_ok = bool(hit) and (not want_id or any(want_id in c for c in hit))
        rep.add("selftest/3mf-%s" % prefix, want_ok, "failed checks: %s" % (hit[:4] or "NONE -- the validator let it through"))

    # 先证明好件是全绿的（否则"坏本被拒"可能是环境坏了造成的假象）
    good = Report(verbose=False)
    verify(stl_path, mf_path, facts_path, good, require_both=mf_path is not None)
    rep.add("selftest/clean-passes", not good.failures, "%d checks, %d failed: %s" % (len(good.rows), len(good.failures), [c for c, _, _ in good.failures] or "none"))
    if stl_data is not None:
        d = bytearray(stl_data)
        run_stl(d[:-20], "truncated", "84+50n")
        d = bytearray(stl_data)
        struct.pack_into("<I", d, 80, struct.unpack_from("<I", stl_data, 80)[0] + 1)
        run_stl(d, "fake-count", "84+50n")
        d = bytearray(stl_data)
        for k in range(3):
            struct.pack_into("<f", d, 84 + 50 * 7 + 4 * k, 0.0)
        run_stl(d, "erased-normal", "normal-matches-right-hand-order")
        d = bytearray(stl_data)
        d[0:5] = b"NOTSTL"
        run_stl(d, "bad-magic", "header-parses")
        d = bytearray(stl_data)
        o = 84 + 50 * 3 + 12  # 第三个三角形的 a.x
        v = struct.unpack_from("<f", d, o)[0]
        struct.pack_into("<f", d, o, v + 0.5)
        run_stl(d, "moved-vertex", "edge-census")
    if mf_data is not None:
        d = bytearray(mf_data)
        d[0:2] = b"XX"
        run_3mf(d, "bad-zip-magic", "")  # 只要被任何一条抓住就行
        # 以下都要改 model xml 的正文，所以重新打一个 zip
        zf = zipfile.ZipFile(io.BytesIO(bytes(mf_data)))
        parts = {i.filename: zf.read(i.filename) for i in zf.infolist()}

        def rebuild(model_xml_bytes):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for name in (CT_PART, RELS_PART, MODEL_PART):
                    data = model_xml_bytes if name == MODEL_PART else parts[name]
                    zi = zipfile.ZipInfo(name, date_time=FIXED_DOS)
                    zi.compress_type = zipfile.ZIP_DEFLATED
                    zi.external_attr = 0x20
                    z.writestr(zi, data)
            return bytearray(buf.getvalue())

        xml_text = parts[MODEL_PART].decode("utf-8").split("\n")
        d = rebuild(("\n".join(x.replace('unit="millimeter"', 'unit="inch"') for x in xml_text)).encode())
        run_3mf(d, "wrong-unit", "unit-millimeter")
        flipped = []
        done = False
        for line in xml_text:
            if not done and line.startswith("<triangle "):
                p = line.replace('v1="', 'TMP="').replace('v2="', 'v1="').replace('TMP="', 'v2="')
                flipped.append(p)
                done = True
            else:
                flipped.append(line)
        d = rebuild("\n".join(flipped).encode())
        run_3mf(d, "flipped-triangle", "watertight")
        # 挪走**浮雕**里的一个顶点，而且挪得足够远（2.5 mm > 一格宽度的三分之一），
        # 让材料真的越出自己那一格。小的形变（0.5 mm 那种）在闭壳上既不破拓扑、
        # 面积也仍在 8% 以内 —— 那**不是**缺陷，判据放过它是对的，所以反例要挑真缺陷。
        import re as _re

        moved = []
        seen_object = 0
        done = False
        for line in xml_text:
            if line.startswith("<object "):
                seen_object += 1
            if not done and seen_object >= 2 and line.startswith("<vertex "):
                m = _re.match(r'<vertex x="(-?[\d.]+)" y="(-?[\d.]+)" z="(-?[\d.]+)"/>', line)
                x = float(m.group(1)) + 2.5
                moved.append('<vertex x="%.6f" y="%s" z="%s"/>' % (x, m.group(2), m.group(3)))
                done = True
            else:
                moved.append(line)
        d = rebuild("\n".join(moved).encode())
        run_3mf(d, "moved-relief-vertex", "g8-3/no-straddling-material")

        # 最后一种坏法动的是"文件与它自己声明的数据不一致"：把 facts 里某一格的
        # shape 档改一级。网格没变，但对拍用的期望面积变了 => g8-3 必须红。
        import copy

        facts2 = copy.deepcopy(facts)
        for row in facts2["cells"]:
            if row[0] == 0 and row[1] == 0:
                row[2] = (row[2] + 1) % facts2["shapeLevels"]
                break
        r = Report(verbose=False)
        zfx, px = check_3mf_zip(bytes(mf_data), r, "probe")
        mdl = parse_model(px[MODEL_PART], r, "probe")
        check_3mf_objects(mdl, facts2, r)
        check_projection([t for o in mdl["objects"] for t in o["tris"]], facts2, r)
        hit = [c for c, ok, _ in r.rows if not ok]
        rep.add(
            "selftest/3mf-cell-level-mismatch",
            any(c.startswith("g8-3/projection-area-error") for c in hit),
            "the per-cell area comparison caught it: %s" % (hit[:3] or "NOTHING -- the projection check is not load-bearing"),
        )
    print("  (each row names the check it expects to go red; a broken file that slips through is a FAIL)")
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser(description="independent checker for PSKT plate artifacts (STL + 3MF)")
    ap.add_argument("--dir", default=".tmp/m5verify", help="directory to auto-discover artifacts in")
    ap.add_argument("--stl")
    ap.add_argument("--3mf", dest="mf")
    ap.add_argument("--facts")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("paths", nargs="*", help="optional explicit <stem>.stl/.3mf paths")
    a = ap.parse_args(argv)
    if a.paths:
        s = next((p for p in a.paths if p.endswith(".stl")), None)
        m = next((p for p in a.paths if p.endswith(".3mf")), None)
        stem = (m or s).rsplit(".", 1)[0]
        f = a.facts or (stem + ".model-facts.json")
    else:
        s, m, f = discover(a.dir)
        s, m, f = a.stl or s, a.mf or m, a.facts or f
    if not s and not m:
        print("no .stl/.3mf found (looked in %s); run: node cli/pskit.mjs send <file> --format stl,3mf --out %s" % (a.dir, a.dir), file=sys.stderr)
        return 2
    if not f or not os.path.exists(f):
        print("missing %s -- the model needs its .model-facts.json sidecar" % (f or "facts"), file=sys.stderr)
        return 2
    print("=" * 78)
    print("verify_model.py  stl=%s  3mf=%s  facts=%s" % (s or "-", m or "-", os.path.basename(f)))
    print("=" * 78)
    rep = Report()
    rc = 0
    try:
        if a.selftest:
            rep = selftest(s, m, f)
        else:
            verify(s, m, f, rep)
    except Exception as e:  # noqa: BLE001
        print("ERROR: %r" % (e,), file=sys.stderr)
        raise
    rc = rep.summary()
    if a.selftest:
        print("selftest result: %s" % ("all broken copies were rejected" if rc == 0 else "SOME BROKEN COPIES PASSED -- the guard is not load-bearing"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
