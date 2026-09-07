#!/usr/bin/env python3
"""ref/verify_stl.py —— 历史名字；判据本体在 `verify_model.py`，这里只是一层壳。

为什么合并：M5 之前 STL 是唯一产物，独立校验器只有 STL 那一份。3MF 落地之后，
"两种产物必须来自同一批三角形"这条判据要求两边**同时**被读进来比，两个各自为政的
STL/3MF 校验器就会各说各话（也违反"一条路径"的决策 10）。所以这里保留原有的调用
形式，检查全部委托给 verify_model.py 的 STL 半边：

    python ref/verify_stl.py path/to/page.stl [more.stl ...]
    python ref/verify_stl.py --selftest path/to/page.stl

它需要页面旁边的 `page.model-facts.json`（`pskit send --format stl` 写的）。没有
sidecar 时不猜版面尺寸，直接报 SPEC GAP 并判失败（独立性纪律见 ref/README.md）。

历史说明：这一版 STL 的实测**边计数是干净的**（例如 PL-G 页：67,698 条无向边，
100.00% 恰被两个三角形反向共用；带底板的合体也一样）。原因不是"做了布尔并"，而是
每格的浮雕是 `ringTriangles`/`discTriangles` 挤出的**各自封闭**壳，彼此由几何留出的
间隙分开，所以根本不存在公共边。早先"`prismFromMask` 相邻矩形共墙 ⇒ 边被用 4 次"
的说法仍然成立 —— 那条路的反例在 `tests/unit/mesh-3mf.test.mjs` 里，判据同一条。
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_model as V  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def check_one(stl_path, rep):
    if not stl_path.endswith(".stl"):
        rep.add("stl/%s" % os.path.basename(stl_path), False, "not a .stl path -- this shell only knows STL")
        return
    facts_path = stl_path[: -len(".stl")] + ".model-facts.json"
    if not os.path.exists(facts_path):
        rep.add(
            "stl/%s" % os.path.basename(stl_path),
            False,
            "SPEC GAP: no %s beside this STL -- bbox/plate facts cannot be checked without the sidecar, and guessing a page size is not what this directory is for" % os.path.basename(facts_path),
        )
        return
    facts = json.load(open(facts_path, encoding="utf-8"))
    with open(stl_path, "rb") as fh:
        data = fh.read()
    tris = V.parse_stl(data, rep, "stl")
    V.check_stl(tris, facts, rep, "stl")


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    do_selftest = "--selftest" in args
    paths = [a for a in args if not a.startswith("--")]
    if not paths:
        print(__doc__)
        print("usage: python ref/verify_stl.py [--selftest] path/to/page.stl [more.stl ...]", file=sys.stderr)
        return 2
    print("verify_stl.py -> thin shell over verify_model.py (STL half of the checks)")
    rep = V.Report()
    for p in paths:
        print("=" * 78)
        print(p)
        check_one(p, rep)
    if do_selftest:
        stl = next((p for p in paths if p.endswith(".stl")), None)
        facts = stl[: -len(".stl")] + ".model-facts.json" if stl else None
        sub = V.selftest(stl, None, facts)
        for cid, ok, detail in sub.rows:
            rep.add(cid, ok, detail)
    return rep.summary()


if __name__ == "__main__":
    sys.exit(main())
