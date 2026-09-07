# 缺陷台账（按用户指示：错误先记录、后修复；本文件只增不删，修好才划掉）

> 规则：每条必须能被一条命令复现。**不写"应该没问题"**。性能问题一律不修（用户明示先不管）。
> 状态标记：`OPEN` 待修 · `CLOSED` 已修并复验 · `NOTABUG` 记录用，非缺陷。

## 第 23 轮闭掉的

| # | 缺陷 | 复验命令 | 状态 |
|---|---|---|---|
| ~~D1~~ | 发送端未进 dist 拷贝清单（G9 绿 ≠ 手机那页真的发布） | `node tools/build-web.mjs && node tools/check-dist.mjs` ⇒ 80 文件、78 条 precache 全对字节 | CLOSED |
| ~~D2~~ | `encodeTransfer` 选项形状与 `sheetMm` 类型未经执行验证（我曾传布尔 ✓ 真 bug） | `node tools/smoke-sender.mjs --bytes 2048` ⇒ 纸面 3 页 / 盘面 8 页全部**编好→自识几何→解回原摘要** | CLOSED |
| ~~D3~~ | 单测红：新登记的 bootstrap reason 破了 advice 契约 | `node --test --test-isolation=none "tests/unit/**/*.test.mjs"` ⇒ 231/231 | CLOSED（修法是把成功路径的字段改名，见 D12 ✓ 未动判据） |
| ~~D6~~ | PWA 清单与图标缺失 ⇒ 手机"添加到主屏幕"不完整 | `Test-Path web/dist/manifest.webmanifest, web/dist/icon-page.png` ⇒ True True（图标由 `core/render/png.js` 真渲染一页生成 ✓ 零新依赖） | CLOSED（遗留见 D13） |

## OPEN

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D4 | `index.html` 里没有指向 `send.html` 的入口：接收端用户在站内点不到发送端 | 打开 `web/dist/index.html` 目视（只能手输 `/send.html`） | 客户端可用性 |
| D5 | 发送端未进 `pskt-file.html` 单文件变体 ⇒ `file://` 下只能"收"不能"发" | `Select-String web/dist/pskt-file.html -Pattern sender` ⇒ 无 | PLAN 只要求接收端 file:// 可用，故列为待办非违约 |
| D7 | **手机摄像头连拍取页未接线**：`core/decode/fiducial.js`（角标定位）+ `warp.js`（`rectifyPage`/`estimateSubstrate`）已就绪，web 端仍是"一次一张" | 手机打开站点按"摄像头"：每页需手动确认一次 | 手机端核心缺口，下一轮第一优先 |

### 第 24 轮新增

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D17 | **连拍的跨会话守卫未按预期触发**：构造"另一会话的页"时收集器返回 `kind page` 而非 `other-session`（`have 1/3`）⇒ 要么 `locate()` 读到的 sessionId 与我假设的形状不同，要么夹具仍错，二者之一，**尚未定论** | `node tools/smoke-capture.mjs --bytes 1024` ⇒ `CAPTURE SMOKE: 1 FAILED` | **只降级提示语，不降级安全**：混批在下游由 `TransferAssembler` 的 `other-session` 拒绝兜住（G0/G5 已测 ✓ 10000 次篡改 0 误接受 ✓）。禁止用"删掉这条断言"变绿 |
| D18 | 连拍的**实机部分本机无法验证**：`getUserMedia` 授权、`facingMode/continuous` 对焦、`getImageData` 帧率、iOS Safari 的 canvas  tainted 行为 | 需真机 https 访问 | 与 D9 同类：浏览器内未验证，G9 维持 🟡 的核心理由 |
| ~~D19~~ | `build-web` 的闭包写循环未跳过 `web/capture.js` ⇒ precache 清单里 `./capture.js` 出现两次 | 第 24 轮内即修（与 selftest/sender 同处加跳过 ✓ `node tools/build-web.mjs && node tools/check-dist.mjs` 仍 8/8） | CLOSED |
| D20 | `web/dist` 里 `capture.js` 的 DOM 半边引用的 id（`burst`/`video`/`burst-log`/`burstprog`/`burststop`）来自本轮新加的 section，**没有判据保证二者不脱钩**（改 HTML 忘改 JS ⇒ 静默失效，因入口是 `getElementById('burst')` 的守卫） | 删掉 section 后 `node tools/check-dist.mjs` 仍全绿 | 需要一个"页面引用的 id 必须存在于对应脚本守卫里"的检查，或至少 selftest 里加一条 DOM 契约 |

### 第 24 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D7~~ | 手机连拍取页 | `node tools/smoke-capture.mjs` ⇒ 11/12：真实 3 页**逐页收下并解回原摘要** ✓ 重复页判为 `duplicate` 不算进度 ✓ "角标 6px / 覆盖率 40%" 各出一条可执行提示 ✓ 页数声明冲突拒绝 ✓ **裁掉的页不被接受** ✓ | CLOSED（连拍外壳已接线并验证；实机部分转 D18，跨会话守卫转 D17） |

| D8 | 浏览器打印服从用户的缩放选择；缩放错则几何错（帧头会拒收 ⇒ 不静默出错，但要重扫） | 打印后以 300 dpi 扫描，比较 `cellPx` | 已知限制；UI 与 `pack.pdf` 是正解 |
| D11 | **构建失败会在 `web/dist` 留下半套产物**（本轮 PWA 段抛异常时 `sw.js` 缺失、其余文件仍在），Pages 若被配成"推什么发什么"就会发出破损站点 | `node -e "..."` 使 build 中途抛错，再看 `web/dist` 存在但缺 `sw.js` | 原子性：写 `dist.tmp` 再改名换入 |
| D12 | `tests/unit/advice-coverage.test.mjs` 的正则 `/reason:\s*'(...)'/g` **会读注释里的文字**：我为解释"把成功路径的 reason 改名"而在注释里写下那个字面量，测试立刻要求给一条**成功**配建议 | `node --test tests/unit/advice-coverage.test.mjs`（改注释前后各跑一次即见） | 判据扫描器把散文当代码；与我本轮在 build-web 里犯的同一族 ✓ 修法=扫描前剥注释（不改判据强度） |
| D13 | PWA 图标是一张 2260×3290 的**非方形**页图；`sizes` 走的是 `${w}x${h}` 分支，iOS 对非方形/`any` 支持差 ⇒ 主屏图标可能被忽略 | `node tools/build-web.mjs` 打印 `icon 211384 B (2260x3290)` | 需要在构建期裁成方形（自家编码器可重画 ✓ 不引依赖） |
| D14 | `send.html` 上"纸张 A4/Letter"下拉框**是惰性的**：纸面尺寸实际来自 `t.geom.sheetMm`（编码器决定 ✓ 与 CLI 一致），改这个框不影响输出 | 切 A4→Letter 再编码，看日志里 `纸 W×Hmm` 不变 | UI 说了谎：应删除该控件或改为"仅提示" |
| D15 | `sender.js` 里 `parityPages` 用 `header.kind === 'parity'` 判校验页数，`kind` 的**取值域我未证实**（不影响产物 ✓ 只影响那一句计数） | `node -e` 打印 `t.pages[0].header` | 又一个"未证实字段"实例（第 9 次 ✓ 模式未断根） |
| D16 | `docs/ACCEPTANCE.md` 的 G9 行仍是旧结论（写"未开始"），本轮 G9 已 8/8 ✓ 台账与判据页不一致 | `Select-String docs/ACCEPTANCE.md -Pattern G9` | 记账欠账，下一轮第一件事（连同 STATUS 现况表 G9 行一起改） |

## 判读提示（避免误读别人的结论）

- `pwsh` 里用 `... | Select-Object -First N` 截断 node 的输出流会让 node 被杀 ⇒ **进程退出码 1**，而门限本身可能全绿。要判绿黑请看**末行**（`ALL GATES PASS`）或不要用 `-First`。本轮我差点把这条当成一次门限失败记进台账 ✓
