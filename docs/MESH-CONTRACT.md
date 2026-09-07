# MESH-CONTRACT · 板材网格产物（STL / 3MF）的约定与 G8 判据

这份文档是 `core/mesh/**`、`cli` 的 `--format stl|3mf`、以及 `ref/verify_model.py`（独立解析侧）
三方之间的**唯一契约**。G8 的判据写在下面第 6 节；任何一侧改了这里的数字而不改本文，视为缺陷。

## 1. 为什么是"浮雕读出"而不是"形状读出"

板材档（`PL-*`）的格子里存的是**挤出高度差**，扫描器/手机看到的是墨色（双色）或阴影（单色）。
所以网格产物必须把"某级形状"表达成**可被光照/接触式扫描读出的高度起伏**，而不是靠颜色。

单色也必须完全可还原：这是 M6/G7 已经用图像层证明过的性质，网格侧不许引入新的依赖色道的信息
（**色道只能决定"要不要在这一格里挖墨盒"，绝不能决定数据位**）。

## 2. 分层与基准面

| 名称 | 值 | 说明 |
|---|---|---|
 板材底板厚 `PLATE_MM` | **2.00 mm** | 整个版面外围 6 mm 边框 + 底板，保证可夹持、可打磨 |
 浮雕高差 `RELIEF_MM` | **0.30 mm** | 一个"级"之间的高度差。低于此值接触式扫描仪分辨不出，高于此值打印时间平方级上升 |
 墨盒下沉 `INK_SUNK_MM` | **0.05 mm** | 双色档中"墨色所在格"下沉，避免打印头刮蹭；**这个下沉不承载任何数据位** |
 静区 `QUIET_MM` | **6.00 mm** | 与纸面静区同源（决策：静区计入版面） |
 角标 | 与纸面同一套双线性格心 + 空心角标 | 检测器不区分介质，只区分 `medium` |

顶面 Z 轴约定：`z = 0` 是**打印床**，材料在 `z > 0` 一侧；所有法向按右手定则朝外。

## 3. 一格的几何来源（不许另写公式）

格子半径/环宽/点径**必须**来自 `core/render/glyphs.js:glyphGeometry(cellEw, shapeLevels)`（决策 6：所有
半径都量化到整挤出宽度 EW 的半步上）。`cellEw = pitchMm / 挤出宽度`（`planPage` **不**返回它，自己算：
`3.6/0.4 = 9`）。

> **单位更正（实测，非文档措辞）**：返回的 `outer`/`inner`/`dot[i]` 是**以格宽为 1 的比例半径**，
> 不是 EW 数——量化后等于「整数 EW 数 ÷ cellEw」。所以 **mm 半径 = `geo.outer * pitchMm`**，
> 而 `cellEw=9, L=2` 给的是 `outer=1/3`(=3 EW)、`inner=2/9`(=2 EW)、`dot=[0,1/9]`。
> 上一版这里写"以 EW 为单位"，会让人把半径再乘一次 pitch 而放大 cellEw 倍。
> 同样更正：`glyphMaskForLevel(dx, dy, level, geo) -> boolean`，`dx/dy` 是以格中心为原点、
> **格边为 1** 的归一化坐标（±0.5）；生成一格掩码要自己在像素中心上采样（测试用 24×24）。

- 纸面档 `cellEw` 为 `null`（无挤出宽度概念）→ **不产出网格**，`--format stl|3mf` 必须明确拒绝并给出
  原因，不许静默按 0.4 mm 猜一个。
- 渲染与网格共用 `glyphMaskForLevel()` 的掩码；**同一级在 PNG 与 3MF 里必须逐像素同形**，
  由 `tests/unit/mesh*.test.mjs` 用 `glyphSignature()` 比对锁定。

## 4. 三角形生成（`core/mesh/solids.js`）

- 原语：`discTriangles`（实心棱柱）、`ringTriangles`（带孔环棱柱）、`prismFromMask`（位图挤出）。
- 位图挤出用**最大矩形覆盖**（贪心：行内合并连续 1，再向下合并同宽相邻行），并要求
  **矩形并集逐像素等于输入掩码**（`rectsCoverMaskExact`）。这条不是优化，是投影正确性的定义：
  覆盖错了 = 印出来的字错了。测试必须包含一个"故意缩小一格 → 比对失败"的反例，证明它承重。
- **不做 CSG 布尔**。重叠实体允许保留内部面；切片器按挤出体外表面处理。文件与本文件都必须
  诚实写出这一点，**禁止**声称 STL 侧水密。
- 顶点焊接 `weldTriangles(triangles, {decimals = 6})`：只为压缩体积与 3MF 的 `<mesh>` 拓扑服务；
  焊接后 `indices.length === triangles.length / 3`（三角形数不变）。

## 5. 两种产物

### STL（`core/mesh/stl.js`）
二进制 STL。80 字节头：`PSKT/` + 版式说明 + 零填充——**不得含时间戳、路径、随机数**（同输入
必须同字节）。法向由顶点顺序算出，退化三角形直接拒绝（`assertNoDegenerate`）。
`stlSelfCheck().watertightHint` 固定 `false` 并说明原因：STL 无共享顶点拓扑，水密性只在 3MF 侧断言。

### 3MF（`core/mesh/threeMF.js`）
手写 OPC 包（零依赖，不引 zip 库）：`[Content_Types].xml`、`_rels/.rels`、`3D/3dmodel.model`。
- `<model unit="millimeter">` 明确单位。**实现注记（第 17 轮·按官方文本更正本契约的笔误 ✓ 判据未变 ✓）**：
  原文写的 `<unit millimeter="millimeter">` 与 `zUp` **都不是合法 3MF**——官方 Core 1.4.0 的 `CT_Model` 只允许 `unit` / `xml:lang` / `requiredextensions` / `recommendedextensions`（外加其他命名空间的任意属性 ✓）**没有 `zUp`** ✓ 且 `ST_Unit` 枚举为 `micron|millimeter|centimeter|inch|foot|meter` ✓ 本仓库的 +Z 向上是**我们自己的 §3.1 约定**、不是格式属性 ✓ 权威文本已 vendor 成 `ref/3mf-core-1.4.0.xsd`（`node tools/fetch-3mf-schema.mjs` 可重取 ✓ 不许手改 ✓）。
- 原文写"`<object type="model">` 一个"**在本判据下做不到** ✓ 若底板与每格浮雕合成单个 `<object>`，各壳之间必然产生共面重叠面 ⇒ 违背"每条无向边恰被两个三角形共用"的水密判据 ✓ 故实现发**多个 `<object>`**（`plate-base` + `relief-ink{k}` ✓ 名称合法：`CT_Object` 允许 `id/type/thumbnail/partnumber/name/pid/pindex` ✓ `id` 必填 ✓），Python 侧**逐 object** 判水密 ✓ **本节的水密判据优先于"一个 object"这句措辞** ✓
- **元素顺序是规范要求的、不是风格**：`CT_Model` 要求 `metadata* → resources → build` ✓ `CT_Resources` 要求 `basematerials`（及任意扩展元素）**全部排在 `object` 之前** ✓ `CT_Vertices` ≥ 3 个 `vertex` ✓ `CT_Triangles` ≥ 1 个 `triangle` ✓ `elementFormDefault="unqualified"` ⇒ 子元素不带前缀、默认命名空间指向 core ✓
- **顶点索引表与 `weldTriangles` 一致**，且 `<mesh>` 的三角形数与 STL 一致（同一次布局的两种产物
  必须给出同一个格子集合，用于对拍）。
- 每个 `<triangle>` 的顶点索引必须指向**已焊接**顶点，从而在 3MF 侧可判定水密：
  **每条无向边恰被两个三角形使用两次**（`verify_model.py` 检查这个条件）。
- 字节确定性：同输入同字节（zip 条目时间戳固定为 1980-01-01）。

## 6. G8 判据（`node cli/pskit.mjs verify --gate G8`）

由 `ref/verify_model.py` **独立**解析（numpy + 手写 STL/zip 读取，不许 import 本仓库 JS）：

1. STL：三角形数 > 0；字节长度 = `84 + 50n`；每条无向边出现次数为偶数（表面闭合的 STL 层近似检查）；
   面积合计 > 0；包围盒与布局的 `plateMm` 一致（±1 µm）。
2. 3MF：zip 可解（`zipfile`）；`<model unit>` 存在；顶点/三角形数与内部断言一致；
   **每条无向边恰出现 2 次（真水密）**；欧拉示性数与"带孔平板"的可数预期一致（报告里给出，不硬判）。
3. **投影对拍（最关键的一条）**：把 3MF 顶面三角形投影到 Z=顶面平面，按 `pitchMm` 网格统计每格
   覆盖面积 → 与 `core/render/` 渲染同一页得到的掩码**逐格比对**（面积差 < 8%）。
   这条把"网格能打开"升级为"网格印出来是同一张码"。
4. 喷嘴矩阵：PL-G × {0.2,0.4,0.6,0.8} 全部产出成功且 1–3 通过（对应 G10 的网格侧子集）。
5. 单色档（`monoSafe`/单通道）产出的 3MF 必须与"色道塌陷后的图像层读回"一致——由 G7 的图像
   断言复用，不重复实现。

**已知未闭合**：第 3 条依赖 `core/render/` 的掩码导出接口稳定；若 M5 期间该接口有变，以
`glyphSignature()` 为准重跑，不许放松 8% 的容差来"过门限"。
