# AGENTS.md · 本仓库作业约定

> **谁该读**：每一个在本仓库里动手的 agent（含下一个会话里的我）。
> **什么时候读**：**每轮开工前读一遍**，收尾前对照 §3 逐条打勾。
> **它是什么**：可执行的规矩 —— 硬性约束、每轮流程、本机陷阱、台账纪律。**不是**项目介绍。
> 想了解"现在什么是真的、怎么验、谁才能推进"⇒ 读 `docs/HANDOVER.md`（交接文档）。
> 判据原文 ⇒ `docs/PLAN.md`；判决 ⇒ `docs/ACCEPTANCE.md`；进度 ⇒ `docs/STATUS.md`；缺陷 ⇒ `docs/DEFECTS.md`。

---

## 0. 每轮流程（照抄即可）

1. **读**：本文件 → `docs/DONE.md`（**已完成 / 已否掉 / 只有用户能验证** 三件事集中在一页，每 10 轮更新；用户第 132 目标轮明确要求，用来避免重复执行与压缩丢记忆）→ `docs/HANDOVER.md` → `docs/STATUS.md` 最上面几块（最新轮次在最上面）。
2. **确认状态**：`git log --oneline -1`、`git status --short`（**树必须是干净的**）、`get_goal`（目标是否 active）。
3. **选一件事**：只做**挡在"可用"路上的那一件**（优先级见 `docs/HANDOVER.md` §12）。**不并行铺开**。
4. **先写证据**：改动之前想清楚"哪条命令能证明它"；新检查必须带**阳性对照**（§6.3）。
5. **改代码**：只动必要的文件；`core/` 的约束见 §2。
6. **跑门限**：§3 的清单，**只看 exit code**。
7. **记台账**：`docs/STATUS.md` 加本轮块（插在最上面）+ `docs/DEFECTS.md` 如有新缺陷/闭合；改完台账**必须跑单测**（有台账断言）。
8. **提交**：`git commit`，信息里写"改了什么、怎么证的、还有什么没做"。
9. **报告**：给用户的话要短、要具体、要区分"实测"与"推断"。

---

## 1. 任务契约与权威源

| 文件 | 作用 | 注意 |
|---|---|---|
| `AGENTS.md` | **本文件**：作业约定 | 每轮先读；陷阱都是实测过的 |
| `docs/DONE.md` | **已完成目标台账**（每 10 轮更新）：已做成 / 已否掉 / 只有用户能验证 | **动工前先读**，避免重复执行；与 ACCEPTANCE / STATUS 冲突时以那两份为准 |
| `docs/PLAN.md` | 已批准的 v3 契约（**判据原文**、里程碑） | **别改**。里面的 CLI 那行是设计草图，不是现状 |
| `docs/ACCEPTANCE.md` | **判决权威**：每个门限的判决 + 实测数字 | 判决只认这里；撤回要划线保留 |
| `docs/STATUS.md` | 里程碑表 + 门限导航 + **逐轮块** | 只作导航；轮次块逐字保留、不改写 |
| `docs/DEFECTS.md` | 缺陷台账（D1…） | **只增不删**；修好划线 + 标注复验命令 |
| `docs/HANDOVER.md` | 交接文档（现状 / 复现 / 待你做的 / 已知债） | 每轮更新；接手人从这里开始 |
| `docs/USE.md` | 用户手册（含 §5 硬件验收清单） | 用户视角的唯一入口 |

**任务契约一句话**：把 PSKT 做到"能跑起来并且可以用"—— 真实用户不读源码就能走完全流程（电脑端 + 手机端），
全程气隙、**误接受为 0**。完成判据 = 一条命令的端到端冒烟 + **用户照 docs 在电脑与手机上各走通一次** + 门限表如实记录。

---

## 2. 硬性约束（违反即返工）

| # | 约束 | 为什么 |
|---|---|---|
| 1 | `package.json` 的 `dependencies` **永远是 `{}`**；要加依赖先问用户 | 气隙环境不能装东西 |
| 2 | `core/**` 必须是**纯 ESM JS，Node 与浏览器同一份**，**不得用 `node:` 内建**（Node 侧 IO 只能待在 `cli/`） | 浏览器里也要跑同一份代码 |
| 3 | 不用 `crypto.subtle`（`file://` 不是安全上下文）、不用 `node:zlib`/`CompressionStream` | 跨宿主行为不同步 |
| 4 | 自研编解码：`core/hash.js`、`core/chacha20.js`、`core/deflate.js`、`core/crc.js`、`decode/png-read.js`、`decode/tiff-read.js` | 零依赖 + 行为可控 |
| 5 | **任何情况下不得输出"看起来成功但是错"的数据**：帧 CRC16 + 明文 SHA-256 摘要 + 原子写；**误接受是唯一不可原谅的失败** | 这是产品存在的理由 |
| 6 | **不得为通过而放宽判据**；收窄判据适用范围是**产品负责人的决定** | 台账好看 ≠ 事情做成 |
| 7 | 需要真机/真浏览器/真打印机的部分：给用户可照抄的步骤，进程内只用**等价证据**顶上，**绝不冒充** | 假证据比没有证据更糟 |
| 8 | **M4 未闭合前不打新 tag** | 里程碑口径 |
| 9 | 读不懂的输入**具名拒绝**，不猜（格式、朝向、参数一律点名） | 猜错会静默产错 |

---

## 3. 每轮收尾清单（逐条打勾）

| ☐ | 命令 | 期望 |
|---|---|---|
| ☐ | `node tools/build-web.mjs` | exit 0（改了 `web/` 或 `core/` 才必须跑） |
| ☐ | `node tools/check-dist.mjs` | `13 pass / 0 fail` + `G9 CHECK: all 15 assertions pass`（两个数字不是一回事：13 是顶层 record 数，15 是 G9 块内的断言数） |
| ☐ | `node --test --test-isolation=none "tests/unit/**/*.test.mjs"` | exit 0（**条数以 runner 自己打印的汇总为准**） |
| ☐ | `node cli/pskit.mjs verify --gate all` | `ALL GATES PASS` + 它会列出**本次未评估**的门限（引用时不许省略这半句） |
| ☐ | `& .\tools\usability.ps1` | 全腿 PASS、exit 0（端到端冒烟，含加密/分片/格式腿） |
| ☐ | `node tools/check-docs-tables.mjs` | `clean`（**表格单元格里不得有裸竖线**） |
| ☐ | `docs/STATUS.md` 本轮块 + `docs/DEFECTS.md`（如有） | 写实测数字，不写"应该没问题" |
| ☐ | `git commit` | 树干净；信息含"改了什么 / 怎么证的 / 没做什么" |

**长任务**（G2 语料 1200+ s、soak 30/60 min）：用后台任务跑（§5 的 `timeoutMs` 封顶 600 s），
跑完再记判决；**结果没出来之前不写判决**。

---

## 4. 环境事实（探测过，别再探）

- **Node v24.14.0**；**Python 3.10.9** + numpy 2.2.6 + opencv-python 4.13（有 `cv2.aruco`、无 contrib）+ pillow 11.1.0 + scipy 1.15.1；**没有** pytest / hypothesis / img2pdf / segno / pyzbar / pymupdf / pdftoppm。
- 20 核；D: 盘 2 TB 空闲；**本机无可枚举的 WIA 扫描仪**（只读沙箱拦 COM）；`Get-CimInstance` 被沙箱拒 ⇒ 探内存/CPU 用 `Get-Process`，别试 CIM/WMI。
- **Node 的 `fetch` 能出网；PowerShell 的 `Invoke-WebRequest` 不能。** 但**先查工作区再上网**：`ref/` 里 vendored 了权威规范（如 `ref/3mf-core-1.4.0.xsd`）—— 第 38 轮拿网上的 **schema 变体**当权威，误判自己"违规"（D40 撤回 / D41 已闭）。
- **本 harness 的 pwsh 工具实际是 Windows PowerShell 5.1**（不是 pwsh 7）。
- **工具的 `timeoutMs` 被执行器封顶 600 s**；后台任务（`run_in_background`）**无超时**。
- **浏览器内验证取决于本次会话有没有绑定浏览器插件**（第 301 轮更正这句话）：有绑定就**真跑过**（第 249–280 轮用 `HeadlessChrome/152` 走完真实往返、离线段网、连拍、TIFF 多页）；没绑定（第 301 轮实测 `browser_evaluate` 拿不到）就**只能由用户做** ⇒ **先探一次再决定，别承诺**。自己在本机起 Chrome/Edge 一律不行（命名管道被拒 `Win32 error 5`；Edge 另撞 crashpad `OpenProcess` 0x5）。

---

## 5. 本机陷阱（症状 → 原因 → 做法）

### 5.1 进程与 stdio

| 症状 | 原因 | 做法 |
|---|---|---|
| `spawn EPERM` | 沙箱禁止**管道 stdio** 的子进程 | 测试用 `node --test --test-isolation=none "tests/unit/**/*.test.mjs"`；门限一律进程内跑。**作用域仅限 node 进程内的管道 stdio**：宿主 shell 跑 `python`/`git`/`node` **是通的**（第 40 轮读窄过一次 ⇒ **D42**）。测试里真要 python：`spawnSync(..., { stdio: 'inherit' })`，并按 `status === 2`（缺 pillow）**明确 skip** |
| `ERR_UNSUPPORTED_DIR_IMPORT` | `--test` 不吃目录参数 | 必须给 glob 字符串 |
| `git push` 失败 | **两种症状、两种原因，先分辨**：① `couldn't create signal pipe, Win32 error 5` = MSYS 要建 signal pipe ⇒ 需要**一次** `danger-full-access` 授权（没批下来就如实记"未推送"）② **第 263 轮实测**：`failed to execute prompt script (exit code 66)` + `could not read Username for 'https://github.com'` = **缺凭据**（`credential.helper=manager` 非交互跑不了、无 `~/.git-credentials`）⇒ **只有用户能推**，升级沙箱没用、也不许投机升级 | 推之前先看是哪种 |
| `Select-Object -First N` 之后 `$LASTEXITCODE` 变成 `-1` | PS 提前终止上游原生进程（看起来像崩了） | 要判 exit code 就别截断，或先 `*> $null` 再单独读 `$LASTEXITCODE` |

### 5.2 PowerShell 5.1

| 症状 | 原因 | 做法 |
|---|---|---|
| `&&` 报错 | 这是 PowerShell | 分隔用 `;`；路径写 `C:\...` |
| 自写 `.ps1` 报 `#requires ... 5.1` 整脚本拒跑；或内嵌双引号被吃掉 | 5.1 的行为 | `.ps1` **不要写 `#Requires -Version 7`**；复杂内联 JS **落地成 `.mjs` 再跑**；`$ErrorActionPreference` 用 `'Continue'` 并**只按 exit code 判定**；调用用 `& .\x.ps1`（点源会让脚本里的 `exit` 连宿主一起退） |
| `node -e "...$1m:..."` 报 `Variable reference is not valid` | PS 双引号先插值，`$1` 被当变量 | 含 `$` 的内联脚本**落地成 `.mjs`**；把管道接到 `ForEach-Object { $_.TrimEnd() }` 会在 ErrorRecord 上炸 ⇒ 改成 `{ [string]$_ }` |

### 5.3 重定向、编码、测试输出

| 症状 | 原因 | 做法 |
|---|---|---|
| 重定向再读回"查无此串" | PS 的 `>` 写 **UTF-16LE** | 跨工具取文本用 `node -e`/`.mjs` 直读；要用 shell 落地就显式 `-Encoding utf8NoBOM` |
| 源码注释变成 U+FFFD | `Get-Content`+`Set-Content` 走 CP1252 往返 | **改文件只用 edit/write 工具**；出事跑 `node tools/fix-mojibake.mjs --write` |
| `SUITE_EXIT=0` 但按 `^# ` 过滤一条也不中 | Node 24 在非 TTY 下用 **spec 报告器**（汇总行以 `ℹ` 开头） | **判"跑没跑"只看 exit code**；要数字就按内容过滤或加 `--test-reporter=tap` |
| 包装脚本结尾的 `exit 0` 让失败看起来成功 | 掩盖内层失败 | 看脚本打印的 `*_EXIT=` 与 job 的 exit code |
| `& .\tools\usability.ps1 > log 2>&1` 得到 **0 字节**日志（exit code 仍对） | 脚本以 `exit` 结尾 ⇒ 宿主在重定向目标 flush 前就退了。**只对「结尾 exit 的 .ps1」成立**：`node … > log`（如 `verify`）重定向正常 | 要**逐条腿**的输出就别用 PS 重定向：让 harness 的 job 缓冲区接（不加 `>`），或用 `[IO.File]::ReadAllText` 直读；`> file` 只用来判 exit code（第 246 轮实测） |
| `git` 刷一屏 CRLF warning | 缺 `.gitattributes` | 已有 `* text=auto eol=lf`；**不要**加 `core.autocrlf=true` |
| npm 装不了东西 | 缓存目录不可写 | 本来就不允许依赖（§2.1） |

### 5.4 编辑与生成代码

| 症状 | 原因 | 做法 |
|---|---|---|
| `edit` 报"文件已被改动，请重读" | 别的命令（如 `check-docs-tables --write`）刚改过它 | **先 read 再 edit**；长表格行会被 grep 截断 ⇒ 锚点用短而唯一的前缀 |
| 在 `run_code` 里写文件报语法错 | 外层 `String.raw` 模板被内容里的**反引号**或**美元花括号插值**打断；JS 字符串里给竖线加的反斜杠会被吞掉 | **用占位符先写、再一次性替换**（例如先写一个不会出现在内容里的记号，最后把它换成反引号），或改用字符串拼接；管道符号要写双反斜杠 |
| 用 `String.replace` 往台账里插块 ⇒ 文件被**自我复制**（第 257 轮：STATUS.md 的 125 行导航内容被复制进一张轮次表格里） | 替换串里 `$&`、美元+反引号、`$'`、`$1` 都是**特殊记号** —— 而我的块里正好有 `` `$` ``（一个代码跨度里的美元号）⇒ 展开成了「匹配点之前的全部内容」 | 插块**不要用 replace**：用切片。**锚点要接在题头行之后**：`const hdr = '## 已知风险 / 待办\n\n'; s.slice(0, i + hdr.length) + block + s.slice(i + hdr.length)` —— 只在题头**之前**下刀会把轮次块放到题头上方（第 257 轮就是这么错位的）。非得用 replace 就传**函数**：`replace(anchor, () => block)` |
| 台账表格整行错列、"看着还像表" | GFM 把**代码跨度里的裸竖线**也当列分隔 | 提交前跑 `node tools/check-docs-tables.mjs`；`--write` 只往代码跨度插反斜杠；**改完台账必须跑单测**（`tests/unit/defects-ledger.test.mjs` 断言每行四列） |

### 5.5 比特流 / 二进制格式（第 300 轮 D106 的教训）

| 症状 | 原因 | 做法 |
|---|---|---|
| 改完编码器：**自家解码器与 zlib/独立实现都拒**同一份输出 | 问题在**编码器**侧，不在解码器 | 别先怀疑解码器；写个**独立比特解析器**把头部逐字段读回来跟写入值对比（第 300 轮：写进去的码长 `8`，读回来是 `0`）|
| 值明明写进去了，接收侧却读成 0（或别的值） | **写入器不检查值装不装得下**：`bw.bits(v, n)` 只发低 n 位（RFC 1951 §3.2.7 的码长字段只有 **3 bit** ⇒ 装不下 8 ⇒ 静默截断 ⇒ 表残缺）| 每个写入点**要么把值域限死**（构造时就传上限，如 `huffmanLengths(clFreq, 7)`）、**要么越界即 `throw`**。静默截断正是「看起来成功但是错」|
| 改完压缩器后尺寸没变或变小了，但没人能复核 | 一次性探针不入库 | `node tools/deflate-bench.mjs`（**报尺寸前必须过自家解码器 + zlib + `PSZ1` 容器三重往返**）；与改前比：`git show HEAD:core/deflate.js > .tmp/old-deflate.mjs` 再 `--encoder .tmp/old-deflate.mjs` |
| 改过发射器后单测红在「答案卷对不上」 | `tests/conformance.json` 是给**独立实现**（`ref/decode.py`）当答案的 | `node tools/emit-conformance.mjs` 重发射，**然后必须 `python ref/decode.py` 复判 PASS** —— 别只让 JS 自证 |

---

## 6. 台账纪律（破坏它比留一个 bug 更糟）

1. **判决权威是 `docs/ACCEPTANCE.md`**；`STATUS.md` 只作导航；轮次块**逐字保留**；撤回**划线 + 标注**，不改写历史。
2. **结果出来之前不写判决**；不把推断当测量（估算可以当"警告"，不能当"拒绝"）。
3. **每个新检查必须有阳性对照**：拿一个**已知会失败**的例子证明这个检查能红（否则它可能空跑）。
4. **只有事实能拒绝**：阈值拒绝要基于测量（如压缩后长度），不能基于估算（压缩比无上界 ⇒ 按字节数提前拒绝会误拒）。
5. **不删候选来躲失败**（`bootstrap` 只重排、不删）；**不夹读断电平**（"夹"就是被明令禁止的"看起来成功但是错"）。
6. 用户可见文案赋的是 `textContent` ⇒ **文案里不许有 markdown**（星号会原样显示）。
7. 策略要从 DOM 守卫里**抽成导出的纯函数**才验得到；但**不要为措辞造假纯函数** —— 措辞由 usability 的腿端到端判。
8. 一次性探针放 `.tmp/`，但**台账不得指向不入库的文件**（要有永久等价物，如 `tools/level-diff.mjs`）。
9. **不要留未提交的工作**：要么补完（腿 + 门限 + 台账 + 提交），要么还原并在 `docs/HANDOVER.md` §9 记清楚。
10. 每轮收尾按 §3 打勾；**M4 未闭不打 tag**。
11. **文档里的数字也会过期：引用前先量**（第 300 轮：全仓写了很久的「`ref/decode.py` 309 项检查」其实是 **310** —— 拿 HEAD 版 fixture 对跑**也是 310** ⇒ 那是旧数字、不是当轮改出来的）⇒ 更正时**划线保留**并注明「怎么量的、为什么不是这轮改的」。

---

## 7. 常用命令速查

```powershell
# 构建与产物
node tools/build-web.mjs                 # 重建 web/dist（不进 git，CI 也会重建）
node tools/check-dist.mjs                # 顶层 13 项 + G9 CHECK 15 条（气隙 / CSP / SW 清单 / id 契约）
# 自证
node --test --test-isolation=none "tests/unit/**/*.test.mjs"   # 单测（沙箱内必须这样写）
node cli/pskit.mjs verify --gate all     # 进程内门限；会打印本次未评估哪些
& .\tools\usability.ps1                  # 端到端冒烟（一条命令走完 文件→页→模拟扫→还原）
node tools/check-docs-tables.mjs         # 台账表格自检（提交前必跑）
node tools/deflate-bench.mjs             # 压缩对拍：逐例与 zlib -9 比（--encoder <path> 换实现）
node tools/emit-conformance.mjs          # 重发射答案卷（改过发射器就必须跑，然后 python ref/decode.py 复判）
node tools/mtf-matrix.mjs --selftest     # G10 矩阵读数器自证（四喷嘴 + 两条对照）
node tools/find-dead-exports.mjs         # 死代码复查·导出侧（候选清单，不是判决）
node tools/find-dead-locals.mjs          # 死代码复查·模块级 + 孤儿工具文件（`--selftest` 是阳性对照）
node tools/check-module-scans.mjs --kit 验收包目录 --scans 扫描父目录   # P-MX-300-6/5/4 一键核对
# 真实使用
node cli/pskit.mjs send FILE --profile P-M1-300 --format png,pdf --out DIR
node cli/pskit.mjs receive DIR --photo --out OUT.bin
& .\tools\jpeg-to-png.ps1 -Source DIR -Out DIR-png   # Windows CLI：JPEG 照片转 PNG
& .\tools\acceptance-kit.ps1             # 生成给用户的硬件验收包（含 README.txt）
```

**命令行口径**：不加 `--profile` 时 `send` 默认纸面档 `P-M1-300`；一次传输最多 **255 页**（页头是 u8）；
超过就用 `split`/`join`。**打印一律 100% 缩放。**

**JPEG 责任边界**：`core/` 的图片解码器保持 PNG/TIFF-only，不加入第三方 JPEG codec。
浏览器接收端用 `createImageBitmap` + canvas 解 JPEG；Windows CLI 用户先用 `tools/jpeg-to-png.ps1`
（System.Drawing）转成 PNG，再跑 `receive`。不要为了 CLI 的 JPEG 输入而扩大 `core/` 的依赖或打破纯 ESM 约束。

---

## 8. 反模式（不要做的事）

- ❌ 为了让门限表好看而**收窄判据**、跳过样本、或"只报通过的那一档"。
- ❌ 用**仿真件**冒充真机/真浏览器/真打印机证据；把"进程内等价"写成"已验证"。
- ❌ 为 600 dpi 再优化候选排序（**已量到地板**，救不了）；跑 3 h soak（判据只要 30–60 min）。
- ❌ 猜格式/朝向/参数（读不懂就**具名拒绝**）；把"格式读不了"说成"没有页"。
- ❌ 留未提交的改动、把台账指向 `.tmp/` 里的文件、改写历史轮次块。
- ❌ 在用户可见文案里写 markdown；用"应该没问题"代替实测。

---

## 9. 出问题时

1. 先查 `docs/DEFECTS.md` —— **大概率已经有人（我）踩过**，里面有复现命令与修法。
2. 再查 `docs/HANDOVER.md` §9（已知债）与 §10（环境陷阱）。
3. 还是不行：**把现象、命令、完整输出记进 `docs/DEFECTS.md`**（一条可复现的命令 + 现状 + 性质），
   然后才动手修；修完在同一条上标注**复验命令**并划线闭合。
