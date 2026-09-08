# AGENTS.md · 本仓库作业约定（每轮先读）

## 任务契约

见 `docs/PLAN.md`（已批准的 v3）。台账与"下一步做什么"见 `docs/STATUS.md`。
**每轮收尾必须**：跑门限 → 更新 `docs/STATUS.md` → `git commit` → `git tag -a M<n>`。
台账里的表格另跑 `node tools/check-docs-tables.mjs`（第 53 轮加）：GFM 会把**代码跨度里的裸 `|`** 也当成列分隔 ⇒ 整行错列，而且"看起来仍像一张表" ⇒ 靠眼睛查不住（D47 我自己踩、D44 从第 48 轮就带着、STATUS 门限表也有 ⇒ D48）。`--write` 只往代码跨度里插反斜杠、不改正文一个字；格数与表头不符的那类它只报不修，因为"那一列本来该写什么"只有人知道。

## 硬性约束

- **零运行时依赖**：`package.json` 的 `dependencies` 永远是 `{}`。要加依赖先问用户。
- 核心代码必须是**纯 ESM JS，Node 与浏览器同一份**，不得用 `node:` 内建（`core/**` 里只允许 Node 侧的 CLI/IO 在 `cli/` 下）。
- 不用 `crypto.subtle`（`file://` 不是安全上下文）、不用 `node:zlib`/`CompressionStream`（跨宿主不同步）。自研：`core/hash.js`、`core/chacha20.js`、`core/deflate.js`。
- 正确性优先：**任何情况下不得输出"看起来成功但是错"的数据**（帧 CRC16 + 明文 SHA-256 摘要 + 原子写）。误接受是唯一不可原谅的失败。

## 本机（Windows + DSH 沙箱）陷阱

| 现象 | 原因 | 做法 |
|---|---|---|
| `spawn EPERM` | 沙箱禁止管道 stdio 的子进程 | 测试用 `node --test --test-isolation=none "tests/unit/**/*.test.mjs"`；门限一律**进程内**跑，不要 spawn 子进程。**作用域仅限 node 进程内的管道 stdio**：宿主 shell（pwsh 工具）跑 `python` / `git` / `node` **是通的** ⇒ 第 40 轮我把这行读窄，误判"G2 语料只能由用户带外生成"、让门限样本量停在判据的 1/6（**D42 ✗**）；已验证命令：`python sim/channel.py --in .tmp/g2src --out .tmp/nc-scan300-N --seed N --preset scan300 --modifier nocrop` ⇒ **15 s / 26.5 MB / 份** ✓ 另：**工具的 `timeoutMs` 被执行器封顶 600 s**（传更大值无效 ✗）⇒ 长任务必须分批 |
| `ERR_UNSUPPORTED_DIR_IMPORT` | `--test` 不吃目录参数 | 必须给 glob 字符串 |
| 源码注释变成 U+FFFD / C1 控制字符 | PowerShell `Get-Content`+`Set-Content` 走 CP1252 往返 | **改文件只用 edit/write 工具**；出事跑 `node tools/fix-mojibake.mjs --write` |
| `git` 刷一屏 CRLF warning | 缺 `.gitattributes` | 已有 `* text=auto eol=lf`；不要加 `core.autocrlf=true` |
| npm 装不了东西 | 缓存目录不可写 | 本来就不允许依赖；实在要试用 `--cache ./.npm-cache` 并先问用户 |
| `&&` 报错 | 这是 PowerShell | 命令分隔用 `;`；路径用 `C:\...` 反斜杠形式 |
| `git show ... > f` 再读回，内容"查无此串" | PowerShell 重定向写的是 **UTF-16LE**（首字节 `255 254`）| **跨工具取文本一律 `node -e` 直读真文件**；要用 shell 落地就显式 `-Encoding utf8NoBOM` 并按同编码读回。判"某判据是不是空跑"之前**必做阳性对照**（拿已知命中的字符串测同一个正则）——第 32 轮就是这条差点让我把真判据误判成空跑 |
| `node -e "...$1m:..."` 报 `Variable reference is not valid` | **PowerShell 双引号字符串先插值** ⇒ 内联 JS 里的正则替换 `$1`/`$2` 被当成 PS 变量 | 含 `$` 的内联脚本**落地成 `.mjs` 文件再跑**（本轮就这么绕过的）；另 `2>&1 \| ForEach-Object { $_.TrimEnd() }` 会在 ErrorRecord 上报 `MethodNotFound` ⇒ 改用 `{ [string]$_ }` |
| 自己写的 `.ps1` 报 `#requires ... 5.1` 而整脚本拒跑；或 `node -e "..."` 里的双引号被吃掉变成语法错 | **本 harness 的 pwsh 工具实际跑在 Windows PowerShell 5.1**（第 42 轮实测，不是 pwsh 7）；5.1 还会嚼碎传给原生程序的参数里的内嵌双引号 | `.ps1` **不要写 `#Requires -Version 7`**（不是降级、是整脚本不跑 ✗）；复杂内联 JS **落地成 `.mjs` 文件**再跑；脚本里 `$ErrorActionPreference` 用 `'Continue'` 并**只按 exit code 判定**（`'Stop'` 会让 node/python 的 stderr 把脚本当场打死 ✗）；调用脚本用 `& .\x.ps1`（点源 `. .\x.ps1` 时脚本里的 `exit` 会连宿主一起退 ✗） |
| 重定向测试输出后"取不到汇总数字"（`SUITE_EXIT=0`，但按 `^# ` 过滤一条也不中） | Node 24 的 test runner 在**非 TTY**（输出被重定向）时用 **spec** 报告器 ⇒ 汇总行以 `ℹ` 开头、**不是** TAP 的 `# `；而 `ℹ` 经 UTF-16LE → 剥 NUL 会变成 `9!` 这类残留 | 判"跑没跑"**只看 exit code**；要取数字就按内容过滤（`(tests\|pass\|fail\|duration_ms)\s+\d+`）或显式加 `--test-reporter=tap`（第 59 轮实测 `tests 297 · pass 297 · fail 0 · 136 s`） |

## 环境事实（探测过，别再探）

- Node v24.14.0；Python 3.10.9 + numpy 2.2.6 + opencv-python 4.13（**有 `cv2.aruco`，无 contrib**）+ pillow 11.1 + scipy 1.15.1；**没有** pytest/hypothesis/img2pdf/segno/pyzbar。
- 20 核，D: 盘 2TB 空闲；本机无可枚举 WIA 扫描仪（只读沙箱里 COM 被拦）。`Get-CimInstance` 也被沙箱拒（`拒绝访问`，第 54 轮实测）⇒ 探内存/CPU 别再试 CIM/WMI，数进程用 `Get-Process` 就够。
- Node 的 `fetch` 能出网；PowerShell 的 `Invoke-WebRequest` 不能。**但先查工作区再上网**：`ref/` 里已 vendored 权威规范文件（如 `ref/3mf-core-1.4.0.xsd`）⇒ 第 38 轮我按记忆写表、又拿网上取来的 schema **变体**当权威，判自己发射器"违规"（D40 已撤回 / D41 **第 39 轮已闭** ✓ 修法 = `tests/unit/threeMF-xsd-parity.test.mjs`：表 ⇄ 权威 XSD 自动对拍，并做过阳性对照）。

## 门限（G0–G10）

判据写在 `docs/PLAN.md`。STATUS 里的"门限状态"表记实测结果。G5（误接受）与 G6（soak）是长任务，跑之前先确认 `--gate` 参数。
