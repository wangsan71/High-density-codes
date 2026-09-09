# 交接文档 · PSKT（第 102 轮末 · 骨架写于第 73 轮末、逐轮更新 · **无 tag**）

> 写给：接手这个仓库的下一个人（或下一个会话里的我），以及要做几个决定的产品负责人。
> 目的：**不要重新发现已经发现过的事**。这里只写"现在什么是真的、怎么验、谁才能推进"，
> 判据原文与逐轮证据仍在 `docs/PLAN.md` / `docs/ACCEPTANCE.md` / `docs/STATUS.md`。
>
> **第 102 轮状态**：`module` 物理编码、多页模拟、硬件验收包与一键扫描检查器均已完成。
> ① 小载荷 16/16；② 100 KB 多页三档逐字节还原；③ 验收包生成三份 pack.pdf；④ `check-module-scans.mjs` 批量核对真扫描；
> ⑤ 默认档仍 `P-M1-300`；⑥ 真平板扫描是最后缺口；⑦ 代码与台账尚未提交（见 §14）。

---

## 0. 一句话现状

**在本机能自动证明的范围内，它是能跑、能用的**：一条命令 `& .\tools\usability.ps1`
就把「文件 → 可打印产物（2D 纸面 + 3D 码牌）→ 模拟打印扫描 → 接收落盘 → 字节逐位相同」跑通
（第 99 轮实测 **289 s、全腿 PASS、exit 0**），其中包含多片传输（split/join）、加密传输（三种收法）、
网页发送端与接收端的真实数据路径、局域网服务与"手机视角"的资源逐字节核对，以及
**扫描仪格式普查**（PNG 的黑白/灰度/彩色/调色板/16-bit + TIFF 的未压缩/LZW/Deflate/PackBits/多页）。

**没被证明的部分集中在四处需要真硬件/真浏览器/真打印机的验收**（G4 手机连拍、G9 真浏览器、
D8 打印缩放、G10 喷嘴矩阵）**加一个只有产品负责人能做的判据决定**（G6 ②）。

**这一轮之前刚修掉的两个用户可见问题**（都在"先用上"的路上）：
- **D78**：写出的 PDF 里 `/Columns` 写成了 `width*3`，任何主流阅读器（Chrome/Edge/PDFium、
  pdf.js、mupdf、poppler、Ghostscript）都会按 3 倍行距取图 ⇒ **整页被剪成平行四边形、下半页角标出纸**
  ⇒ 印出来根本解不了。**这是用户报的「PDF 斜、PNG 直」的真凶，是我们自己的锅**，不是转换工具的锅。
- **D80/D81/D82**：接收端只吃 8-bit RGB PNG，扫描仪默认的"黑白/线稿"（1-bit 灰或调色板 PNG）、
  16-bit 灰度、以及**整个 TIFF 容器**（含多页）此前一律拒绝 ⇒ 现在全部原生解码。

---

## 1. 我是不是卡了 —— 诚实回答，以及现在的位置

**卡点不在代码，在验收权。** 目标的完成判据里有半条是「**用户照 docs 能在电脑与手机上各走通一次**」，
这半条我无法自己完成，也不允许冒充实机证据。**M4 从第 22 轮起就一直在等一台真手机。**

**当前状态（第 98 轮）**：用户已明确说「**继续循环工作**」，本轮按进程内优先级执行并修掉了
唯一 OPEN 的代码缺陷 **D83**。目标仍未完成的原因不变：G4 需要真手机，G9 需要真浏览器，
G8/G10 需要切片软件/真打印机，G6 ② 需要产品负责人定判据。

**要往下推进，只有三条路（按价值）**：
① 你按 §7 跑一次硬件验收（哪怕只跑 G4 的一小部分 / 只打一块板 / 只点一次浏览器），我按门限表如实记账；
② 你明确说「继续找进程内的活儿」，我按 §12 的优先级往下做；
③ 你对 §8 的判据决定给个答复（尤其 G6 ② 与 D70），有些债会因此直接出局。

---

## 2. 目标与硬约束（原文，别改写）

**目标**：把 PSKT 做到**能跑起来并且可以用** —— "可用" = 真实用户不读源码就能走完全流程：
① 电脑端：打开客户端页面 → 选/拖文件 → 生成可打印产物（2D 纸面含套准与裁切标记、浏览器按实际尺寸打印；
3D 码牌 3MF/STL 切片软件可接受）→ 打印或拍扫 → 接收端解码落盘、字节与原文件相同；
② 手机端：同一局域网打开页面 → 摄像头连续取景/自动拍页 → 解码 → 取回文件；
③ 全程气隙、不依赖任何外部 URL，误接受为 0。

**完成判据**：一条命令跑通的端到端 usability 冒烟 + 用户照 docs 在电脑与手机上各走通一次 + 门限表如实记录。

**硬约束（每轮都适用）**：
- 每轮必须**真修**掉阻塞"可用"的东西，不是记账了事；错误写 `docs/DEFECTS.md`。
- **不得为通过而放宽判据**；收窄一条判据的适用范围是**产品负责人的决定**，不是我在门限表里能默默做的。
- 需要真机/真浏览器/真打印机的部分：给用户可直接执行的步骤与清单，并在可自动化范围内先用**进程内等价证据**顶上，**绝不冒充实机证据**。
- **M4 未闭合前不打新 tag。**
- 用户口径（仍然有效）：「其实没必要 600 dpi，只要能够读到就行」⇒ 600 dpi 不是必要路径、G2-600 **无判决**；
  「你不会过度设计吧，刚好就行」⇒ 修根因、最小范围；「其实我想先用上，没必要做过度设计」；
  「暂停所有的动作，编写交接文档，详细的」（第 97 轮，本文件）。

---

## 3. 权威源与阅读顺序

| 文件 | 是什么 | 注意 |
|---|---|---|
| `AGENTS.md` | 本机/沙箱陷阱表 + 硬性约束 | **每轮先读**；陷阱都是实测过的 |
| `docs/PLAN.md` | 已批准的 v3 契约（判据原文、里程碑） | **别改**。它的 CLI 那行是设计草图，列着未实现的 `watch`/`bench`/`printpack`/`platepack` ⇒ 不是现状清单 |
| `docs/ACCEPTANCE.md` | **判决权威**：每个门限的判决 + 实测数字 + 划线保留的历史 | 判决只认这里 |
| `docs/STATUS.md` | 里程碑表 + 门限导航表 + **逐轮块**（新轮次插在最上面） | 只作导航；轮次块逐字保留、不改写 |
| `docs/DEFECTS.md` | 缺陷台账 **D1–D83** | 只增不删；修好划线 + 标注；**OPEN 的只有 D83 与几处待决策项** |
| `docs/USE.md` | 用户手册：§0 构建 · §1 电脑 · §2 手机 · §3 真打印 · §4 一条命令自证 · §5 **硬件验收清单** · §6 出问题 | 用户视角的唯一入口 |
| `docs/RENDER-CONTRACT.md` / `docs/MESH-CONTRACT.md` | 渲染与网格契约 | 改渲染/板材前读 |

---

## 4. 仓库地图（谁负责什么）

- **`core/`** —— 协议与算法，**纯 ESM、Node 与浏览器同一份、禁用 node 内建**、零运行时依赖。
  - `protocol.js`（编解码 + `TransferAssembler`）、`frame.js`（页头，`totalPages` 是 **u8** ⇒ 一次传输 ≤255 页）、
    `profiles.js`（13 个档，其中 `P-MX-300-4/5/6` 是 `physicalEncoding: 'module'`）、
    `naming.js`（下载名策略 D62）、`splitjoin.js`（分片/重组，第 72 轮）。
  - `decode/`：`bootstrap.js`（候选搜索）、`page.js`（快路 + 标记几何路）、`fiducial.js`（标记检测/墨度）、
    `warp.js`（单应矫正）、`ideal.js`（逐格匹配滤波读电平）、`recalibrate.js`（按页实测 ρ 重读，D51）、
    `echo.js`（回显条）、**`module-read.js`（模块阵 timing 校准 + 局部自适应阈值 + 低置信擦除）**、
    `advice.js`（**每个 reason 必须有 advice，机器强制**）、
    **`png-read.js`（PNG：位深 1/2/4/8/16、调色板、灰度/RGB/带 alpha，第 95 轮）**、
    **`tiff-read.js`（TIFF 基线：II/MM、多页、条带、1/4/8/16 位、光度 0/1/2/3、自写 LZW 与 PackBits、FillOrder、Predictor 2，第 96 轮）**。
  - 自研底层：`hash.js`、`chacha20.js`、`deflate.js`（含 `inflateRaw`）、`crc.js`。
  - `render/`：`layout.js`、`raster.js`、`png.js`、`tiff.js`、**`pdf.js`（D78 后图像流为裸 RGB 行、无 predictor 参数）**、`stl.js`、`threeMF.js`、`sheet.js`、`glyphs.js`、**`modules.js`（模块 timing 图案）**。
  - `calibrate/`：`mtfplate.js`（板规格 + 外观光栅）、`readmtf.js`（读者 + 推荐）。
  - `mesh/`：`solids.js`、`stl.js`、`rectilinear.js`、`mtfplate.js`、`plate.js`。
- **`cli/pskit.mjs`** —— 只做 IO 与参数：`send` / `receive` / `split` / `join` / `calibrate` / `status` /
  `verify --gate` / `roundtrip`。**没有测试钩子**（沙箱禁管道 stdio ⇒ 测试里不能 spawn 它）⇒ CLI 行为只能靠
  `tools/usability.ps1` 的腿或手工命令证明。
- **`web/`** —— `index.html`（接收页，含最下面「手机连拍」节）、`app.js`（桌面接收）、`capture.js`（连拍取舍，
  **纯收集器 + DOM 半边**，Node 可加载）、`send.html` + `sender.js`（发送页）、`selftest*.js`、`sw.js`。
- **`tools/`** —— `build-web.mjs`、`check-dist.mjs`（13 项，含气隙/外部 URL 断言与 id 契约）、
  `check-serve.mjs` / `check-lan.mjs`、`smoke-sender.mjs` / `smoke-capture.mjs`、`soak.mjs`（= `verify --gate G6`）、
  `usability.ps1`（**一条命令的端到端冒烟**，含 4g 扫描仪 PNG 变体腿与 4h TIFF 变体腿）、
  `acceptance-kit.ps1` + `acceptance-readme.txt`（用户硬件验收包，**含 P-MX-300-4/5/6 纸面腿**）、
  **`check-module-scans.mjs`（三档真扫描目录的一键摘要核对）**、
  **`mtf-matrix.mjs`（照片目录 → 喷嘴矩阵读数，第 92 轮）**、`mtf-probe.ps1`（仿真打印机探针）、
  `g4-probe.ps1`、`check-3mf.mjs`、`level-diff.mjs`、`g6-perf-probe.mjs`、`rho-report.mjs`、`check-docs-tables.mjs`。
- **`sim/channel.py`** —— 确定性"打印+扫描/拍照"替身（Python + numpy + cv2）；**宿主 shell 跑得通**。
- **`ref/`** —— 独立参考实现 `decode.py`（G0）+ vendored 权威规范（如 `3mf-core-1.4.0.xsd`）⇒ **先查这里再上网**。
- **`tests/unit/*.test.mjs`** —— 单测（**条数以 runner 自己打印的汇总为准**；第 96 轮实测 365/365）；
  `tests/conformance.json` 是跨实现对拍向量。
- **`.tmp/`** —— gitignored：一次性探针、语料、日志。**台账不得指向不入库的文件**（要有永久等价物）。
- **`web/dist`** —— 构建产物，**不进 git**（CI 从源码重建）。

---

## 5. 从零复现（新克隆，按顺序）

```powershell
node tools/build-web.mjs                                  # 期望 exit 0；打印 precache 条数与单文件体积
node tools/check-dist.mjs                                 # 期望 13 pass / 0 fail + "G9 CHECK: all 13 assertions pass"
node tools/smoke-sender.mjs                               # 期望 "SENDER SMOKE: all assertions pass"、exit 0
node tools/smoke-capture.mjs                              # 期望 "CAPTURE SMOKE: all assertions pass"、exit 0
node --test --test-isolation=none "tests/unit/**/*.test.mjs"   # 期望 exit 0（第 96 轮实测 365/365，≈155 s）
& .\tools\usability.ps1                                   # 期望全腿 PASS、exit 0（第 96 轮实测 231 s）
& .\tools\mtf-probe.ps1                                   # 期望 0 FAIL（仿真打印机 + Python 信道，≈26 s）
node tools/mtf-matrix.mjs --selftest                      # 期望 "MTF MATRIX SELFTEST: pass"、exit 0（≈1 s）
& .\tools\acceptance-kit.ps1                              # 生成用户的硬件验收包（exit 0；≈90 s）
node cli/pskit.mjs verify --gate all                      # G0 G1 G3 G5 G7 G8 进程内；会打印本次未评估哪些
node tools/check-docs-tables.mjs                          # 期望 "clean -- N rows in M tables"
```

**别背数字**（单测条数、precache 条数、dist 文件数、页面体积都会随内容变）：以工具**自己打印的汇总**与
**exit code** 为准。长任务注意工具的 `timeoutMs` 被执行器**封顶 600 s** ⇒ G2 语料（1200+ s）与 soak（30/60 min）
必须用 `run_in_background` 分批。

**G2 语料怎么造**（300 dpi 侧已达标的那一档，200 份）：
```powershell
python sim/channel.py --in .tmp/g2src --out .tmp/sc-scan300-N --seed N --preset scan300 --modifier nocrop   # 每份 ~15 s / 26 MB
node cli/pskit.mjs verify --gate G2 --root .tmp --match 'sc-scan300-*'
```

---

## 6. 门限现状（第 97 轮末，与 `docs/ACCEPTANCE.md` 对齐）

| Gate | 判决 | 差什么 |
|---|---|---|
| G0 规格可独立实现 | ✅ | — （`python ref/decode.py` → PASS） |
| G1 渲染—读回零误读 | ✅ | — （7 档 × 3 次 = 725,913 格 0 误读） |
| G2 纸面 200 seed | 🟡 | **300 dpi ✅ `PASS 200/200`**（交付形状：整张 A4、含裁切/套准标记；第 63 轮修法后重跑 1245.4 s、exit 0）。**600 dpi 无最终判决**：第 58 轮曾判 ✗ 162/200；第 63 轮修法（D51 的 RS 仲裁重读）落地后重跑到 52/200 被用户中止；**第 94 轮又启动一次完整重跑**（日志 `.tmp/d49-600-r94.log`），**第 97 轮按用户"暂停"指令中止**：已处理 **150 份 = 149 OK + 1 FAIL**（`sc-scan600-105` = `no-page-header`），页级失败行 103 条，分类 **42 × readout/echo-bad-magic · 31 × markers/no-hollow-corner · 14 × readout/echo-no-contrast · 9 × readout/echo-header-crc · 7 × assemble/intra-fail** ⇒ **这不是判决**（判据要 200/200），但它是"修法之后 600 dpi 侧好转"的第一批数据 |
| G3 缺页/乱序/重复 | ✅ | — |
| G4 手机压力 ≥99% | ⬜ | **500 页 × 8 轮仍未跑**（需真手机）。已有部分证据（`tools/g4-probe.ps1`）：手机端**整页入画**时纸面档 0/8、**板材 `PL-G@0.4` 8/8 逐字节还原** ⇒ 手机那一端要用**粗档**（实测，不是建议）；主导失败是**拍摄前提**（四角标必须在画面内）而非解码器 ⇒ D70 是判据里的前提缺口 |
| G5 误接受 0 | ✅ | — （10000 次试验 + 2000 次接缝试验：0 误接受） |
| G6 性能 + soak | 🟡 | ① 编码 ✅ ≤5 s；② 解码 **300 dpi ✅ 1373 ms**、**600 dpi ✗ 地板 6192 ms**（判据 ≤2 s/页 ⇒ §8a）；③ soak ✅ 30 min 与 60 min 双过（误接受 0、RSS +3.16% ≤10%），但"无泄漏"**不主张** |
| G7 单色兜底 100% | ✅ | — |
| G8 3MF/STL 独立解析 | 🟡 | 进程内等价全绿（STL + 3MF XSD 子集校验器 + 与 vendored 权威 XSD 自动对拍）；**差切片软件真人打开一次** |
| G9 Web 扫描端 | 🟡 | 产物级全绿（13 项 + `G9 CHECK` 13 断言、零第三方加载点、CSP、SW 清单哈希对上磁盘、bundle 盲解磁盘页摘要相符）；**差真浏览器点一次**。**D43 的 https 半边第 90 轮已闭**（站点见 §14） |
| G10 喷嘴 × 参数矩阵 | 🟡 | 产物齐：MTF 板（含 3MF/STL 与四角标记）+ 数据板网格角标（D68 闭）+ 验收包；**第 92 轮起有矩阵读数器**（`tools/mtf-matrix.mjs`：四张照片 → 逐张"建议喷嘴 + 判决"，`--selftest` 四条正例 + 两条对照）。**仍差真打印机印一次**（判决不变） |

**总账（不主张完成）**：✅ 5（G0 G1 G3 G5 G7）· 🟡 5（G2 G6 G8 G9 G10）· ⬜ 1（G4）
⇒ **"通过 G0–G10" 不成立**。`verify --gate all` 打印的 `ALL GATES PASS` **每次都会列出本次未评估的门限**
⇒ **不得引用成"全部门限通过"**。

---

## 7. 只有用户能做的验收（照 `docs/USE.md` §5 跑，那里有逐步操作）

**⓿ 先做这一件（第 97 轮新增，很重要）**：**重新导出你的产物**。
`scans/pack.pdf` 与那三张 `pack_pages-to-jpg-000*.png` 都是**第 91 轮修 D78 之前**的 writer 写出来的
（PDF 里的图被阅读器剪成平行四边形），**请重新跑一遍**：

```powershell
node cli/pskit.mjs send 你的文件 --profile P-M1-300 --format png,pdf --out 输出目录
```

然后按 **100% 缩放**打印。PNG 路径一直是好的。

| 项 | 一句话 | 现状 |
|---|---|---|
| **G4 手机连拍 500×8** | `node tools/serve.mjs` → 手机同 Wi-Fi 打开它打印的局域网地址 → 页面**最下面**「手机连拍（自动挑帧）」→ 开始连拍（**不是**第 1 节那个一次一页的手动快门）→ 每轮收齐后在「存成什么名字」填回带扩展名的原名 → **确认文件真的落盘、扩展名对**（第 73 轮换成 `Blob`+`createObjectURL`，两种机制都没在真浏览器验过）→ 加密批要**先填口令再开始** | **从未跑过** |
| **G9 浏览器** | Chrome / Edge / Safari 各开发送页与接收页各一次（`file://` 单文件版 + http 瘦版各一次）；接收页加 `?selftest=1` 看自检 | 未跑 |
| **D8 打印缩放** | 打一页，量实际尺寸与 PDF 标称是否一致；被缩放就手动改 100% 再量 | 未量化（第 85 轮已量到：**均匀/非均匀仿射缩放照样逐字节还原** ⇒ 风险比原以为的小） |
| **G10 喷嘴矩阵** | 同一块 MTF 板**用 0.2/0.4/0.6/0.8 各打一次** → 四张照片放一个目录、按 `n02/n04/n06/n08.png` 命名 → `node tools/mtf-matrix.mjs --dir 目录 --spec mtf\mtf-plate.json --provenance real-print`；另外各打一块**码牌**拍/扫后 `receive --photo` | **进程内半边已就绪**，真打印机未跑 |
| **G8 收尾** | 把 `.3mf` 用切片软件（Bambu Studio / Orca / PrusaSlicer）真打开一次 | 未做 |
| **D43 https 半边** | 第 90 轮已闭（站点上线）；剩下的"浏览器里点一次安装"归 G9 | 已解 |

做完把结果（截图、量的尺寸、失败页号、接收页点名的缺页号）发回来，**判据不会为了好看而放宽**。

---

## 8. 待产品负责人决定（我不替它决定，也不替它记绿）

**(a) G6 ② 的 600 dpi 怎么办** —— 判据是 **≤2 s/页**，第 72 轮量到地板（同一张 37.6 MP 真实信道页，
soak 口径 = `decodePNG` + `bootstrapDecode`）：

| 跑法 | 合计 | 尝试 |
|---|---|---|
| 无提示 | 24743 ms | 6（5 次整页白读 = 18.5 s） |
| 几何已知 | 13520 ms | 3 |
| **恰好 1 个候选（地板）** | **6192 ms** | 1（第一次就赢） |
| 300 dpi 同纸页（对照） | **1373 ms** | 1（加提示 1367 ms ⇒ 提示买不到东西） |

⇒ **完美排序也只到判据的 3.1 倍**，而光 `decodePNG` 就 1547 ms = **预算的 77%**。
三条路只有你能走：① 把 ② 限定在 300 dpi（`USE.md` 指给用户的正是这一档，实测 ✅，也与你"没必要 600 dpi"一致）；
② 为 600 dpi 放宽 2 s 预算；③ 投资一种**根本上更便宜的 600 dpi 读法**（未做、也不主张一定可行）。

**(b) 要不要继续自动循环**（见 §1）。

**(c) D49**（600 dpi 页级直读率低）OPEN 非阻塞；若 (a) 选 ①，它随之出局。第 94–97 轮的重跑数据见 §6。

**(d) D70**：G4 的判据没有写明「四个角标必须都在画面内」这个前提。实测（`phone-hard`）：缺角标时**任何**
解码器都只能拒绝（3 个点解不出 8 自由度单应）。两条路：① 给 G4 判据补上前提；② 要求缺角标也能工作（物理上不可能）。

**(e) D83（第 97 轮新增，第 98 轮已闭）**：见 §9 第一条；不再需要决定。

---

## 9. 已知债 / 仍未做（别当成新问题重新发现）

1. **D83（CLOSED，第 98 轮）**：纯白/空白扫描图不再因默认 INK2 的纸色底色被误判成 `no-square-candidates`。
   `findMarkers` 现在在阈值阶梯前用 `inkRangeRatio()` 的 p1/p99 动态范围与峰值尾部比例判 `blank-image`。
   阳性对照（D69 仍 `no-contrast`、正常页仍可读、默认 INK2 与 PAPER1 都报 blank）已入单测与 CLI 实跑。
2. **`P-MX-300-4/5/6` 真机待验**：三档小载荷 16/16，且 100 KB 多页模拟逐字节还原；
   `acceptance-kit.ps1` 与 `check-module-scans.mjs` 已把真扫描流程降到一条命令，但真实平板扫描仍未执行。
3. **两处第 97 轮还原的 CLI 改进**（已验证可用，但**没有**单测/腿/门限 ⇒ 未提交）：
   - `send <目录>` 现在会抛裸 Node 错误 `EISDIR: illegal operation on a directory, read`。改法：`statSync(file).isDirectory()` 时抛一句人话（"一次传输只装一个文件；先把目录打包成一个文件再发"）。
   - `receive` 一次失败的批量只逐张打印原因（40 张照片 = 120 行）。改法：按 `stage/reason` 计数，末尾打一行
     `note: N image/page(s) failed: 30 x markers/no-contrast, ...` 并附**主导类**的一句 `do`。
   两处都应配 usability 腿（`send <dir>` 的具名拒绝；空白目录的汇总行）。
4. `cli/pskit.mjs` **无测试钩子** ⇒ CLI 行为只能靠 usability 腿或手工命令证明（结构性债）。
5. 网页端**没有浏览器内的分片 UI**：`split`/`join` 在 CLI；网页/手机收到的分片要在「存成什么名字」里填 `part-NNN.bin`。
6. 桌面接收页 `#outname` 的 `input` 监听器注册在 `run()` 内 ⇒ 每跑一次多挂一个（`applyName` 幂等 ⇒ **属泄漏、不属错误**）。
7. `app.js` / `capture.js` 的 DOM 分支**进程内跑不到**（Node 一 import 就在取日志元素的表达式上炸）⇒ 真浏览器那一次归 G9。
8. RSS 长跑：60 min 内 Q1..Q4 中位数**未收敛**；判据在 30 与 60 min 都过，**3 h 跑故意没做**（过度设计）。
9. 255 页上限本身没动（协议字段宽度，改它要动帧格式与**已经印出去的纸**）。
10. **第 94 轮启动的 600 dpi G2 重跑被"暂停"中止**（150/200 已处理，数据见 §6）；要判决就重跑：
   `node cli/pskit.mjs verify --gate G2 --root .tmp --match 'sc-scan600-*'`（后台，约 1–2 h）。
11. **第 99 轮模块档尚需真机判定**（见 §7）。

---

## 10. 环境陷阱（本机 + DSH 沙箱，全部实测过；细节见 `AGENTS.md`）

- pwsh 工具实际是 **Windows PowerShell 5.1**：分隔用 `;`（`&&` 报错）；传给原生程序的**内嵌双引号会被嚼碎**；
  含 `$` 的内联 JS 会被 PS 先插值 ⇒ **复杂脚本落地成 `.mjs` 再跑**；调用 `.ps1` 用 `& .\x.ps1`。
- 工具的 `timeoutMs` **封顶 600 s** ⇒ 长任务用 `run_in_background`（后台任务**无超时**）。
- **`Select-Object -First N` 会提前终止上游原生进程** ⇒ `$LASTEXITCODE` 变成 **`-1`**（看起来像崩了，其实是被杀）。
  要判 exit code 就别截断，或先 `*> $null` 再单独读 `$LASTEXITCODE`。
- PS 的 `>` 重定向写 **UTF-16LE** ⇒ 跨工具取文本用 `node -e`/`.mjs` 直读。
- Node 24 重定向输出时用 **spec 报告器**（汇总行以 `ℹ` 开头）⇒ **判"跑没跑"只看 exit code**。
- 包装脚本结尾的 `exit 0` 会**掩盖内层失败** ⇒ 一律看打印出来的 `*_EXIT=` 与 job 的 exit code。
- `spawn EPERM`：**node 进程内**禁管道 stdio ⇒ 测试必须 `node --test --test-isolation=none "tests/unit/**/*.test.mjs"`；
  **宿主 shell 跑 `python` / `git` / `node` 是通的**（第 40 轮把这行读窄过一次 = D42）。测试里需要 python 时用
  `spawnSync(..., { stdio: 'inherit' })` 并按 `status === 2`（缺 pillow）**明确 skip**（`render-writers.test.mjs` 的范式）。
- **`git push` 需要一次 `danger-full-access`**：MSYS 传输助手要建 signal pipe，受限沙箱拒（`Win32 error 5`）。
  第 97 轮那次**授权提示在 10 分钟里没等到答复** ⇒ 推送仍待办（§14）。同理 Chrome 无头也跑不起来（同名错误）。
- 本会话的受限 shell **`python` / `py` 都不在 PATH**，且直接跑 `C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe`
  会 `存取被拒`；先对完整路径请求一次 escalation，再把该目录 prepend 到 PATH，`usability.ps1` 即可正常跑（第 98 轮实测）。
- `Get-CimInstance` / WMI 被沙箱拒 ⇒ 探内存用 `Get-Process`；判内存看 **RSS + arrayBuffers**，不看 JS heap。
- `edit` 工具需要**本会话内先 read**，且**文件被别的命令改过之后必须重读**（第 95 轮 `check-docs-tables --write` 改过 DEFECTS 后，我直接 edit 被拒）。
- 改文件只用 `edit`/`write`（PS 的 `Get-Content`+`Set-Content` 走 CP1252 往返会把注释变成 U+FFFD）。
- 表格单元格里**不得有裸竖线**（GFM 会把代码跨度里的也算列分隔）⇒ 提交前跑 `node tools/check-docs-tables.mjs`；
  `tests/unit/defects-ledger.test.mjs` 还会断言"每行四列" ⇒ **改完台账必须跑一遍单测**（第 95 轮我踩过）。
- **在 `run_code` 里生成代码要小心转义**：外层用 `String.raw` 模板时，被生成的代码里的**反引号与美元花括号插值**会打断它
  （第 96 轮写 `tiff-read.js` 时踩过 ⇒ 改成字符串拼接）；JS 字符串里给管道符号加的反斜杠会被吞掉 ⇒ 要写双反斜杠。
- PIL 11.1.0 可用（造扫描仪格式的夹具）；numpy/cv2/scipy 可用；**没有** pytest/img2pdf/pymupdf/pdftoppm。

---

## 11. 台账纪律（破坏它比留一个 bug 更糟）

1. **判决权威是 `docs/ACCEPTANCE.md`**；`STATUS.md` 的门限表只作导航；轮次块**逐字保留**；撤回**划线 + 标注**，不改写。
2. **结果出来之前不写判决**；不把推断当测量（第 72 轮差点把 600 dpi 的赢家成本写成减法）。
3. **每个新检查必须有阳性对照**：`4096 B` 必须安静、300 dpi 加提示必须买不到东西、`join` 的每个拒绝用例都先跑未篡改输入、
   第 91/95 轮的 D78/D80 修复都配了"旧格式必须仍然失败"的对照。
4. **估算只能警告，不能拒绝；只有事实能拒绝**（压缩比无上界 ⇒ 任何"按文件字节数提前拒绝"的阈值都会误拒）。
5. **不删 bootstrap 候选来躲失败**；**不夹读断电平**（夹 = 被明令禁止的"看起来成功但是错"）。
6. 用户可见文案赋的是 `textContent` ⇒ **文案里不许有 markdown**。
7. 策略要从 DOM 守卫里**抽成导出的纯函数**才验得到；但**不要为措辞造假纯函数** —— 措辞由 usability 的腿端到端判。
8. 一次性探针放 `.tmp/`，但**台账不得指向不入库的文件**（要有永久等价物，如 `tools/level-diff.mjs`）。
9. **不要留未提交的工作**：要么补完（腿 + 门限 + 台账 + 提交），要么还原并在 §9 记清楚（第 97 轮就是这么处理那两处 CLI 改进的）。
10. 每轮收尾：跑门限 → 更新 `STATUS.md`（+ `DEFECTS.md` 如有）→ `git commit`；**M4 未闭不打 tag**。

---

## 12. 如果要继续，优先级建议

**用户侧（价值最高，只有你能做）**：⓿ **先重新导出产物**（§7 开头，D78 的修复只有重导才用得上）；
① `& .\tools\acceptance-kit.ps1` 一次生成纸面页、每个喷嘴的码牌、MTF 板与 `README.txt` ⇒
G4 手机 500×8（闭合 M4 的唯一动作）→ G9 三浏览器 × 两源 → D8 打印缩放 → G10 四喷嘴 → G8 切片软件打开一次。

**进程内（若你不能跑硬件，按价值排序）**：
1. **真平板扫描验证 `P-MX-300-6/5/4`**：小载荷与 100 KB 模拟均已完成；`acceptance-kit.ps1` 已打包，`check-module-scans.mjs` 可批量核对，先打 6px 一页。
2. **补回 §9 第 3 条那两处 CLI 改进**（`send <目录>` 的具名拒绝 + `receive` 的失败分类汇总行），各配一条 usability 腿；
3. **G10 的照片侧读数**已经就绪（`tools/mtf-matrix.mjs`）；若想再往前，可写 **G4 的照片侧同款读数脚本**
   （把一批手机照片按"缺墨/缺角/太远"自动分类成一张表）；
4. **G6 ② 的可行性探针**（降采样/分块粗定位能不能把 600 dpi 定位成本压到 ~1 s 量级）—— **只在产品负责人选了 §8(a)③ 时做**，不承诺成功；
5. 网页端分片 UI（价值中、成本高）；`#outname` 监听器泄漏（价值低、本机验不了）；
6. **不建议做**：为 600 dpi 再优化候选排序（已量到地板）；3 h 长跑（判据只要求 30–60 min）；任何"为了让门限表好看"的判据收窄。

---

## 13. 最近几轮的落点（便于对账；完整的逐轮记录在 `docs/STATUS.md`）

| 提交 | 轮次 | 做了什么 |
|---|---|---|
| `a0003de` | 102 | **一键真扫描检查器**：`tools/check-module-scans.mjs` 逐档读 PNG/TIFF、走同一条解码路径并重算摘要 |
| `c298499` | 101 | **100 KB 多页模拟**：`P-MX-300-6/5/4` 分别 8/6/5 页，逐字节还原 |
| `d44f98e` | 100 | **硬件验收包接入模块档**：`acceptance-kit.ps1` 生成 P-MX-300-6/5/4 三份 pack.pdf 与真平板扫描命令；README 第 1b 步给逐档 receive/hash 对比 |
| `79c401b` | 99 | **module 物理编码**：`P-MX-300-4/5/6` 二进制实心模块阵；timing 行校准与局部自适应阈值；三档模拟扫描 16/16；旧 `P-M1-300` 默认与旧 profile code 不变 |
| `8224646` | 98 | **D83**：纯白空白页在默认 INK2 纸色下不再被判成「擦镜头」，改由图内 inkness 动态范围与峰值尾部比例判 `blank-image`；三条阳性对照与 CLI 实跑入库 |
| `d69d709` | 96 | **D82**：零依赖基线 TIFF 读取器（II/MM、多页、1/4/8/16 位、灰度/二值/调色板/RGB、自写 LZW 与 PackBits、Adobe Deflate 的 zlib 包裹、FillOrder 2、Predictor 2）；十种真文件变体 + 多页文件全部逐字节还原 |
| `869abf4` | 95 | **D80/D81**：PNG 支持 1/2/4/8/16 位与调色板（扫描仪"黑白/线稿"默认档）；pHYs 单位字节被当 4 字节读 ⇒ dpi 恒 null、快路守卫空过 |
| `7f4e556` | 94 | **台账收口**：D51 第 63 轮就修好了、状态列却仍写"未修" ⇒ 用它自己点名的命令复验（首读仍塌陷=设计、整条传输被救回且逐字节相同）；并启动 600 dpi 的 G2 重跑 |
| `9e68db5` | 93 | **D79**：「扫描成 PDF」这条最常见的路被说成 `no pages found` ⇒ 现在点名 PDF + 给出导出路径；错误前缀不再重复 |
| `f3117c5` | 92 | **G10 进程内半边**：`tools/mtf-matrix.mjs`（照片目录 → 喷嘴矩阵读数，四种判决 + `--selftest` 四正例两对照） |
| `fe22372` | 91 | **D78**：PDF 图像流的 `/Columns` 写成 `width*3` ⇒ 每个主流阅读器按 3 倍行距取图、整页剪成平行四边形（用户报的「PDF 斜」）；改成裸 RGB 行、不再带 predictor 参数 |
| `53c33dd` | 90 | 部署到 GitHub Pages（D43 https 半边闭合）；修 D77（`receive` 的 `skippedTiff` 崩溃） |
| `a811673` | 89 | 页数上限 hint 补上"每片多大" + 可照抄的 `split --max-bytes` |
| `cc119e1` | 88 | `receive` 点名被页间 RS 重建的页 + usability 4e 腿 |
| `15883d7` | 87 | **D76**：「拍近一点」是**把人指向更坏结果**的建议（角标在纸四角）⇒ 三处文案改正 |

---

## 14. 本次会话（第 90–102 轮）：改了什么、怎么复验、怎么推上去

**9 个提交未推送**（`git status -sb` 会显示 `ahead 9`；含模块代码、模拟证据、验收包、一键检查器、AGENTS 重写与交接同步）：

| 提交 | 一句话 |
|---|---|
| `a0003de` | 一键真扫描检查器 |
| `c298499` | 100 KB 多页模块模拟证据 |
| `d44f98e` | 硬件验收包生成三个模块纸面 leg |
| `79c401b` | 高密度二进制模块档 P-MX-300-4/5/6 |
| `8224646` | D83：空白页诊断不再依赖底色假设 |
| `d69d709` | TIFF 读取器（D82） |
| `869abf4` | PNG 位深/调色板 + pHYs dpi（D80/D81） |
| `7f4e556` | D51 台账收口 + 启动 600 dpi 重跑 |
| `9e68db5` | 扫描成 PDF 的诊断（D79） |
| `f3117c5` | G10 矩阵读数器 |
| `fe22372` | PDF `/Columns` 剪切页（D78） |
| `53c33dd` | Pages 部署（D43 https 半边） |

**推送**：`git push origin master`（需要一次 `danger-full-access` 授权；批了之后 Pages 会自动重建，
站点 `https://wangsan71.github.io/High-density-codes/`）。**在此之前，线上站点仍是修前版本**
（`web/dist` 不入库、由 CI 从源码构建）。

**这次会话新增/改动的可复验入口**：

```powershell
node tools/mtf-matrix.mjs --selftest                 # 矩阵读数器自证（四喷嘴点名 + 两条对照）
& .\tools\usability.ps1                              # 含 4g（PNG 变体）与 4h（TIFF 变体）两条新腿
& .\tools\acceptance-kit.ps1                         # 含 P-MX-300-6/5/4 三个真平板扫描 leg
node tools/check-module-scans.mjs --kit 验收包目录 --scans 扫描父目录   # 三档一次核对
node --test --test-isolation=none "tests/unit/module-matrix.test.mjs"       # P-MX 三档的渲染/读回/组装/bootstrap
node --test --test-isolation=none "tests/unit/fiducial-corner-damage.test.mjs"   # D83 + D69 + 正常页对照
node --test --test-isolation=none "tests/unit/png-read-depths.test.mjs"   # 8 例
node --test --test-isolation=none "tests/unit/tiff-read.test.mjs"         # 9 例
node --test --test-isolation=none "tests/unit/render-pdf.test.mjs"        # 14 例（含 D78 阳性对照）
```

**一句话给接手人**：代码这一侧现在"用户拿什么格式的扫描件都读得回来"（PNG 全变体 + TIFF 含多页）、
"打出来的 PDF 不再被阅读器剪歪"，且空白扫描页不会再被指向"擦镜头"；**新模块档在模拟信道里通过，但真平板扫描仍待验**，
进程内下一项是两条被还原的 CLI 小改进（§9）。
