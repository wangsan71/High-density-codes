# 交接文档 · PSKT（第 75 轮末 · 骨架写于第 73 轮末、第 75 轮更新 · **无 tag**）

> 写给：接手这个仓库的下一个人（或下一个会话里的我），以及要做几个决定的产品负责人。
> 目的：**不要重新发现已经发现过的事**。这里只写"现在什么是真的、怎么验、谁才能推进"，
> 判据原文与逐轮证据仍在 `docs/PLAN.md` / `docs/ACCEPTANCE.md` / `docs/STATUS.md`。

---

## 0. 一句话现状

在**本机能自动证明的范围内，它是能跑、能用的**：一条命令
`& .\tools\usability.ps1` 就把「文件 → 可打印产物（2D 纸面 + 3D 码牌）→ 模拟打印扫描 →
接收落盘 → 字节逐位相同」跑通，第 73 轮实测 **27 PASS / 0 FAIL / 222 s、exit 0**，
其中包含多片传输（split/join）、加密传输（三种收法）、网页发送端与接收端的真实数据路径、
局域网服务与"手机视角"的资源逐字节核对。

**没被证明的部分全部集中在四处需要真硬件/真浏览器的验收**（G4 手机连拍、G9 真浏览器、
D8 打印缩放、G10 喷嘴矩阵）**加一个只有产品负责人能做的判据决定**（G6 ②）。

---

## 1. 我是不是卡了 —— 诚实回答

**是，但卡点不在代码。** 目标的完成判据里有半条是"**用户照 docs 能在电脑与手机上各走通一次**"，
而这半条我无法自己完成，也不允许冒充实机证据。自动循环继续下去，每轮能找到的进程内缺陷
越来越小（第 71 轮：一句没有数字的拒绝语；第 72 轮：split/join 工具；第 73 轮：一句错诊断 +
一个缺失的输入框），而 **M4 从第 22 轮起就一直在等一台真手机**。

⇒ **循环已暂停**（用户指示；`get_goal` 实测 `phase=paused`、`activation=disarmed`、已跑 **65 / 80** 轮 ⇒ 不会再有自动续跑）。恢复方式三种，按价值排序：
① 你按 §7 跑一次硬件验收（哪怕只跑 G4 的一小部分），我按门限表如实记账；
② 你明确说"继续找进程内的活儿"，我按 §12 的优先级往下做；
③ 你对 §8 的判据决定给个答复（尤其 G6 ②），有些债会因此直接出局。

**恢复的技术动作**（给接手的会话）：人说"继续"时用 `update_goal action=resume` 重新武装 —— 会话被 resume 或 fork 之后，
活动目标本来就是 disarmed 的，**必须由人开口**才能 rearm；先 `get_goal` 取准确的 `id` 与 `revision` 再更新。

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
  「你不会过度设计吧，刚好就行」⇒ 修根因、最小范围；「继续，gogogo」。

---

## 3. 权威源与阅读顺序

| 文件 | 是什么 | 注意 |
|---|---|---|
| `AGENTS.md` | 本机/沙箱陷阱表 + 硬性约束 | **每轮先读**；陷阱都是实测过的 |
| `docs/PLAN.md` | 已批准的 v3 契约（判据原文、里程碑） | **别改**。它的 CLI 那行是设计草图，列着未实现的 `watch`/`bench`/`printpack`/`platepack` ⇒ 不是现状清单 |
| `docs/ACCEPTANCE.md` | **判决权威**：每个门限的判决 + 实测数字 + 划线保留的历史 | 判决只认这里 |
| `docs/STATUS.md` | 里程碑表 + 门限导航表 + **逐轮块**（新轮次插在最上面） | 只作导航；轮次块逐字保留、不改写 |
| `docs/DEFECTS.md` | 缺陷台账 D1–D66 | 只增不删，修好划线 + 标注 |
| `docs/USE.md` | 用户手册：§0 构建 · §1 电脑 · §2 手机 · §3 真打印 · §4 一条命令自证 · §5 **硬件验收清单** · §6 出问题 | 用户视角的唯一入口 |
| `docs/RENDER-CONTRACT.md` / `docs/MESH-CONTRACT.md` | 渲染与网格契约 | 改渲染/板材前读 |

---

## 4. 仓库地图（谁负责什么）

- **`core/`** —— 协议与算法，**纯 ESM、Node 与浏览器同一份、禁用 `node:` 内建**、零运行时依赖。
  `protocol.js`（编解码 + `TransferAssembler`）、`frame.js`（页头，`totalPages` 是 **u8** ⇒ 一次传输 ≤255 页）、
  `profiles.js`（10 个档）、`decode/bootstrap.js`（候选搜索）、`decode/recalibrate.js`（按页实测 ρ 重读，D51）、
  `decode/advice.js`（每个 reason 必须有 advice，机器强制）、`hash.js`/`chacha20.js`/`deflate.js`（自研）、
  `naming.js`（下载名策略，D62）、`splitjoin.js`（分片/重组，第 72 轮）、`render/`（版面/PNG/TIFF/PDF/STL/3MF）。
- **`cli/pskit.mjs`** —— 只做 IO 与参数：`send` / `receive` / `split` / `join` / `calibrate` / `status` /
  `verify --gate` / `roundtrip`。**没有测试钩子**（沙箱禁管道 stdio ⇒ 测试里不能 spawn 它）⇒ CLI 行为只能靠
  `tools/usability.ps1` 的腿或手工命令证明。
- **`web/`** —— `index.html`（接收页，含最下面「手机连拍」节）、`app.js`（桌面接收）、`capture.js`（连拍取舍，
  **纯收集器 + DOM 半边**，Node 可加载）、`send.html` + `sender.js`（发送页）、`selftest*.js`、`sw.js`。
- **`tools/`** —— 门限与检查器：`build-web.mjs`、`check-dist.mjs`（13 项，含气隙/外部 URL 断言与 id 契约）、
  `check-serve.mjs` / `check-lan.mjs`（手机视角）、`smoke-sender.mjs`（13 项）/ `smoke-capture.mjs`、
  `soak.mjs`（= `verify --gate G6`）、`usability.ps1`（**一条命令的端到端冒烟**）、`check-3mf.mjs`（G8）、
  `g6-perf-probe.mjs`（解码耗时分解，带 `--profile/--dpi/--palette/--only-hints`）、`check-docs-tables.mjs`。
- **`sim/channel.py`** —— 确定性"打印+扫描/拍照"替身（Python + numpy + cv2）；**宿主 shell 跑得通**。
- **`ref/`** —— 独立参考实现 `decode.py`（G0）+ vendored 权威规范（如 `3mf-core-1.4.0.xsd`）⇒ **先查这里再上网**。
- **`tests/unit/*.test.mjs`** —— 321 个用例；`tests/conformance.json` 是跨实现对拍向量。
- **`.tmp/`** —— gitignored：一次性探针、语料、提交信息草稿。**台账不得指向不入库的文件**（要有永久等价物）。
- **`web/dist`** —— 构建产物，不进 git。

---

## 5. 从零复现（新克隆，按顺序）

```powershell
node tools/build-web.mjs                                  # 期望 exit 0；打印 precache 条数与单文件体积
node tools/check-dist.mjs                                 # 期望 13 pass / 0 fail + "G9 CHECK: all 13 assertions pass"
node tools/smoke-sender.mjs                               # 期望 13 PASS / 0 FAIL + "all assertions pass"
node tools/smoke-capture.mjs                              # 期望 exit 0 + "CAPTURE SMOKE: all assertions pass"
node --test --test-isolation=none "tests/unit/**/*.test.mjs"   # 期望 321/321（≈138 s）
& .\tools\usability.ps1                                   # 期望 27 PASS / 0 FAIL（≈222 s）
& .\tools\mtf-probe.ps1                                   # 期望 0 FAIL / "all assertions pass"（≈26 s）
node cli/pskit.mjs verify --gate all                      # G0 G1 G2 G3 G5 G7 G8 进程内
node tools/check-docs-tables.mjs                          # 期望 "clean -- N rows in M tables"
```

**别背数字**（单测条数、precache 条数、dist 文件数、页面体积都会随内容变）：以工具**自己打印的汇总**与
**exit code** 为准。长任务注意工具的 `timeoutMs` 被执行器**封顶 600 s** ⇒ G2 语料（1200+ s）与 soak（30/60 min）
必须用 `run_in_background` 分批。

---

## 6. 门限现状（第 73 轮末，与 `docs/ACCEPTANCE.md` 对齐）

| Gate | 判决 | 差什么 |
|---|---|---|
| G0 规格可独立实现 | ✅ | — （`python ref/decode.py` → PASS，309 检查） |
| G1 渲染—读回零误读 | ✅ | — （7 档 × 3 次 = 725,913 格 0 误读） |
| G2 纸面 200 seed | 🟡 | **300 dpi ✅ `PASS 200/200`**（交付形状：整张 A4、含裁切/套准标记）；**600 dpi 无判决**（第 58 轮曾判 ✗ 162/200，第 63 轮修法落地后重跑到 52/200 由用户中止 ⇒ 用户判 600 dpi 非必要，但**判据没分档** ⇒ 不记绿也不记红） |
| G3 缺页/乱序/重复 | ✅ | — |
| G4 手机压力 ≥99% | ⬜ | **500 页 × 8 轮一次未跑 ⇒ 零证据**；失败分类侧 `advice.js` 已就绪。**M4 唯一阻塞** |
| G5 误接受 0 | ✅ | — （10000 次试验：9200 纠正 / 800 拒 / **0 误接受**，含两项变异检验） |
| G6 性能 + soak | 🟡 | ① 编码 ✅ 199.4 ms（判据 ≤5 s）；② 解码 **300 dpi ✅ 1373 ms**、**600 dpi ✗ 地板 6192 ms**（判据 ≤2 s/页 ⇒ 见 §8）；③ soak ✅ 30 min 与 60 min 双过（60.02 min、281 cycles、2782 页、误接受 0、RSS +3.16% ≤10%），但**"无泄漏"不主张**（Q1..Q4 未收敛） |
| G7 单色兜底 100% | ✅ | — |
| G8 3MF/STL 独立解析 | 🟡 | 进程内等价全绿（STL 13/13 + 承重反例、3MF XSD 子集校验器 + 与 vendored 权威 XSD 自动对拍）；**差切片软件真人打开一次**（本机无 XSD 引擎） |
| G9 Web 扫描端 | 🟡 | 产物级全绿（13 项 + `G9 CHECK` 13 断言、零第三方加载点、CSP、SW 清单哈希对上磁盘、bundle 盲解磁盘页摘要相符）；**差真浏览器点一次** + **https 托管（D43）** |
| G10 喷嘴 × 参数矩阵 | 🟡 | 只测到矩阵里一个真实边界点（`PL-G` 在 0.6/0.8 被正确拒绝）；需真打印机 |

**总账（不主张完成）**：✅ 5（G0 G1 G3 G5 G7）· 🟡 5（G2 G6 G8 G9 G10）· ⬜ 1（G4）
⇒ **"通过 G0–G10" 不成立**。`verify --gate all` 打印的 `ALL GATES PASS` **每次都会列出本次未评估的门限**
⇒ **不得引用成"全部门限通过"**。

---

## 7. 只有用户能做的验收（照 `docs/USE.md` §5 跑，那里有逐步操作）

| 项 | 一句话 | 现状 |
|---|---|---|
| **G4 手机连拍 500×8** | `node tools/serve.mjs` → 手机同 Wi-Fi 打开它打印的局域网地址 → 页面**最下面**「手机连拍（自动挑帧）」→ 开始连拍（**不是**第 1 节那个一次一页的手动快门）→ 每轮收齐后在「存成什么名字」填回带扩展名的原名 → **确认文件真的落盘、扩展名对**（第 73 轮换成了 `Blob`+`createObjectURL`，两种机制都没在真浏览器验过 ⇒ 你这一步就是验证）→ 加密批要**先填口令再开始** | **从未跑过** |
| **G9 浏览器** | Chrome / Edge / Safari 各开发送页与接收页各一次（`file://` 单文件版 + http 瘦版各一次）；接收页加 `?selftest=1` 看自检 | 未跑 |
| **D8 打印缩放** | 打一页，量实际尺寸与 PDF 标称是否一致；被缩放就手动改 100% 再量 | 未量化 |
| **G10 喷嘴矩阵** | 0.2 / 0.4 / 0.6 / 0.8 各打一块码牌，拍/扫后还原 | 需打印机 |
| **G8 收尾** | 把 `.3mf` 用切片软件（Bambu Studio / Orca / PrusaSlicer）真打开一次 | 未做 |
| **D43 https 半边** | 给我仓库 URL + 交互凭据 + 允许写 `.github/workflows/pages.yml` ⇒ 才能真装 PWA | 只有你能解 |

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

⇒ **完美排序也只到判据的 3.1 倍**，而光 `decodePNG` 就 1547 ms = **预算的 77%**（像素数是 300 dpi 的 4 倍）。
所以"再造一个廉价的候选排序信号"救不了这一档（最多把 24.7 s 买到 ~6.2 s）⇒ **第 72 轮决定不造它**。三条路只有你能走：
① 把 ② 限定在 300 dpi（`USE.md` 指给用户的正是这一档，实测 ✅，也与你"没必要 600 dpi"的口径一致）；
② 为 600 dpi 放宽 2 s 预算；③ 投资一种**根本上更便宜的 600 dpi 读法**（先降采样/分块粗定位再精读 —— 唯一可能
接近 2 s 的路线，未做、也不主张一定可行）。

**(b) 要不要继续自动循环**（见 §1）。

**(c) D49**（600 dpi 页级直读率低）现在 OPEN 非阻塞；若 (a) 选 ①，它随之出局。

---

## 9. 已知债 / 仍未做（别当成新问题重新发现）

- `cli/pskit.mjs` **无测试钩子** ⇒ CLI 行为只能靠 usability 腿或手工命令证明（结构性债）。
- ~~**M7 的 MTF 校准板 → 推荐喷嘴/间距那一半未实现**~~（**过期记账，第 75 轮更正**：`core/calibrate/mtfplate.js` + `readmtf.js` + CLI 两个模式 + `tools/mtf-probe.ps1` 第 75 轮已落地，真信道实测四喷嘴里三条点名正确 ✓）⇒ **D67 第 76 轮已闭**（`core/mesh/rectilinear.js` + `core/mesh/mtfplate.js` + CLI `--format 3mf,stl`：每 object 水密、投影对拍 `maxPct 0`、3MF 过 G8 子集）⇒ 板子现在**印得出来**。剩下的同根缺陷是 **D68：数据板（`pskit send --format 3mf`）的网格没有角标** ⇒ 打印出来的码牌照片登记不了 ⇒ G10 的实机那一半仍走不通。`calibrate` 的"只量不改"那半第 61 轮已落地。
- 网页端**没有浏览器内的分片 UI**：`split`/`join` 在 CLI；网页/手机收到的分片要在「存成什么名字」里填 `part-NNN.bin`（`USE.md` 已如实写）。
- 桌面接收页 `#outname` 的 `input` 监听器注册在 `run()` 内 ⇒ 每跑一次多挂一个（`applyName` 幂等 ⇒ **属泄漏、不属错误**）。
- `app.js` / `capture.js` 的 DOM 分支**进程内跑不到**（Node 一 import 就在 `$('log')` 上炸）⇒ 真浏览器那一次归 G9。
- RSS 长跑：60 min 内 Q1..Q4 中位数**未收敛**（+6.32 / +4.21 / +6.44 MB）；判据在 30 与 60 min 都过，**3 h 跑故意没做**（过度设计）。若将来有人报多小时会话内存上涨，从 `ACCEPTANCE.md` ③bis 查起（两个平凡解释已排除）。
- 255 页上限本身没动（协议字段宽度，改它要动帧格式与**已经印出去的纸**）。

---

## 10. 环境陷阱（本机 + DSH 沙箱，全部实测过；细节见 `AGENTS.md`）

- pwsh 工具实际是 **Windows PowerShell 5.1**：分隔用 `;`（`&&` 报错）；传给原生程序的**内嵌双引号会被嚼碎**；
  含 `$` 的内联 JS 会被 PS 先插值 ⇒ **复杂脚本落地成 `.mjs` 再跑**；调用 `.ps1` 用 `& .\x.ps1`（点源会让脚本里的 `exit` 连宿主一起退）。
- 工具的 `timeoutMs` **封顶 600 s** ⇒ 长任务用 `run_in_background`。
- PS 的 `>` 重定向写 **UTF-16LE** ⇒ 跨工具取文本用 `node -e`/`.mjs` 直读，或读回时 `.Replace("\`0",'')`。
- Node 24 重定向输出时用 **spec 报告器**（汇总行以 `ℹ` 开头）⇒ **判"跑没跑"只看 exit code**，要数字就按内容过滤。
- 包装脚本结尾的 `exit 0` 会**掩盖内层失败** ⇒ 一律看打印出来的 `*_EXIT=` 与 job 的 exit code。
- `spawn EPERM`：**node 进程内**禁管道 stdio ⇒ 测试必须 `node --test --test-isolation=none "tests/unit/**/*.test.mjs"`（目录参数会 `ERR_UNSUPPORTED_DIR_IMPORT`）；
  但**宿主 shell 跑 `python` / `git` / `node` 是通的**（第 40 轮把这行读窄过一次，导致门限样本量只有判据的 1/6 = D42）。
- `Get-CimInstance` / WMI 被沙箱拒 ⇒ 探内存用 `Get-Process`；判内存看 **RSS + arrayBuffers**，不看 JS heap（D56：heap 恒 5 MB 的同时留住 1.3 GB 外部内存）。
- `edit` 工具需要**本会话内先 read**；长表格行会被 grep 截断 ⇒ **锚点用短而唯一的前缀**。
- 改文件只用 `edit`/`write`（PS 的 `Get-Content`+`Set-Content` 走 CP1252 往返会把注释变成 U+FFFD）。
- 表格单元格里**不得有裸 `|`**（GFM 会把代码跨度里的也算列分隔 ⇒ 整行错列还"看着像表"）⇒ 提交前跑 `node tools/check-docs-tables.mjs`。

---

## 11. 台账纪律（破坏它比留一个 bug 更糟）

1. **判决权威是 `docs/ACCEPTANCE.md`**；`STATUS.md` 的门限表只作导航；轮次块**逐字保留**；撤回**划线 + 标注**，不改写。
2. **结果出来之前不写判决**；不把推断当测量（第 72 轮我差点把 600 dpi 的赢家成本写成减法 `11974−6900≈5.1 s`，实测是 **4645 ms**）。
3. **每个新检查必须有阳性对照**（一个已知命中的例子，证明这个检查能失败）：`4096 B` 必须安静、300 dpi 加提示必须买不到东西、
   4 MiB 全零必须仍编出 6 页、`join` 的每个拒绝用例都先跑一遍未篡改输入、加密腿的"给对钥匙必须成功"就是前两次拒绝的对照。
4. **估算只能警告，不能拒绝；只有事实能拒绝**（压缩比无上界 ⇒ 任何"按文件字节数提前拒绝"的阈值都会误拒 ⇒ `earlySizePlan()` 只警告，
   拒绝留给 core，因为压缩后的长度才是事实）。
5. **不删 bootstrap 候选来躲失败**（"reorders and never removes"）；**不夹读断电平**（夹 = 被明令禁止的"看起来成功但是错"）。
6. `say()` / `log()` 赋的是 `textContent` ⇒ **用户可见文案里不许有 markdown**（星号会原样显示）。
7. 策略要从 DOM 守卫里**抽成导出的纯函数**才验得到（D61/D63/D64/D65/D66 都是这个套路）；但**不要为措辞造假纯函数** ——
   措辞由 usability 的腿端到端判。
8. 一次性探针放 `.tmp/`，但**台账不得指向不入库的文件**（第 61 轮把 `.tmp/lvl61.mjs` 提升为 `tools/level-diff.mjs` 就是这个理由）。
9. 每轮收尾：跑门限 → 更新 `STATUS.md`（+ `DEFECTS.md` 如有）→ `git commit`；**M4 未闭不打 tag**。

---

## 12. 如果要继续，优先级建议

**用户侧（价值最高，只有你能做）**：① G4 手机 500×8（闭合 M4 的唯一动作）→ ② G9 三浏览器 × 两源
（同一批里顺带处理 `sender.js` 的 `data:`→`blob:` 决定与 `#outname`/`#burstname` 目视检查）→ ③ D8 打印缩放实测（一页 + 尺子）
→ ④ G10 四喷嘴（需打印机）→ ⑤ G8 用切片软件真打开一次 → ⑥ D43 的 https 半边。

**进程内（若你不能跑硬件，按价值排序）**：
1. ~~M7 的 MTF 校准板~~（第 75 轮测量半边 + 第 76 轮可打印半边）⇒ 下一条是 **D68：给数据板网格补角标**（同一根因；改它要同时动 `MESH-CONTRACT.md` §2/§3、`ref/verify_model.py` 与 `check-3mf`，规则照 MTF 板那条：角标几何从 `layout.fiducials` 像素换算、环宽 = 1 个 cell），做完**用户才可能真跑 G10**；
2. G6 ② 若产品负责人选 ③，先做**可行性探针**（降采样/分块粗定位能不能把 600 dpi 的定位成本压到 ~1 s 量级）——不承诺成功；
3. 网页端分片 UI（价值中、成本高：要多文件写入与跨会话重组，`File System Access API` 还不通用）；
4. `#outname` 监听器泄漏（价值低，且改 DOM 生命周期在本机无法验证）；
5. **不建议做**：为 600 dpi 再优化候选排序（已量到地板，救不了）；3 h 长跑（判据只要求 30–60 min）；
   任何"为了让门限表好看"的判据收窄。

---

## 13. 最近三轮的落点（便于对账）

| 提交 | 轮次 | 做了什么 |
|---|---|---|
| `34cb5cb` | 75 | **M7 缺的那一半**：`core/calibrate/mtfplate.js`（喷嘴无关的板：5 档阶梯格 + 8 档孤立孔 + 色样 + 纹理样 + 标尺 + 四角标记）+ `core/calibrate/readmtf.js`（登记/覆盖率/颜色全走解码器自己的代码，判据是物理陈述）+ CLI `calibrate --make-mtf` / `--mtf` + `tools/mtf-probe.ps1`（真信道探针：四喷嘴点名 + 两对照，0 FAIL / 26s）+ 7 个单测 ⇒ 见 STATUS 第 75 轮块；**D67 OPEN**（板的网格没写） |
| `b292a74` | 74 | 写 `docs/HANDOVER.md` + 更正两处过期记账（USE §5 的 G6 soak 行、STATUS 的总账计数）；**代码零改动**、无 tag |
| `04a6413` | 73 | **D66**：core 一行（`error='need-passphrase'`）+ 三个接收端各一句可执行诊断 + 手机连拍新增 `#burstpass` + 连拍落盘统一到 `Blob` + usability 4c 腿（三种收法，含措辞判定与阳性对照）+ `USE.md` 首次写清口令（并更正我第 72 轮"要手工改名"的错话） |
| `8c87f71` | 72 | **D65 尾部闭合**：`core/splitjoin.js` + `pskit split`/`join`（缺/短/错一律 exit 1 且不落盘）+ usability 4b 腿（3 次独立传输 + 阴性对照）+ 6 个单测；**G6 ② 地板实测**（6192 ms）⇒ `ACCEPTANCE` 划线 + ②bis；M9 过期记账更正 |
| `a0ba8ea` | 71 | **D65**：发送页把"一次最多 255 页 ≈1.52 MB"用数字讲清（`transferBudget`/`pageLimitHint`/`earlySizePlan`，只警告不拒绝），删掉不可能触发的 600 页闸门与那句假的"CLI 页数不限" |

**当前**：树干净、`docs/HANDOVER.md` 为本文件、**无 tag**（M4 开在 G4）。
**目标状态**：同一会话的持久目标**已暂停**（`get_goal` 实测 `phase=paused`、`activation=disarmed`、`roundsStarted 65 / maxGoalRounds 80`）⇒ **不是完成** —— 完成判据里的"用户在电脑与手机上各走通一次"尚未发生。
