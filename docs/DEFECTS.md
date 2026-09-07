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
| ~~D7~~ | ~~手机摄像头连拍取页未接线~~ → 第 24 轮接线、第 25 轮结案，见下方"闭掉的"；实机部分另立 D18 | — | CLOSED |

### 第 24 轮新增

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D17 | **连拍的跨会话守卫未按预期触发**：构造"另一会话的页"时收集器返回 `kind page` 而非 `other-session`（`have 1/3`）⇒ 要么 `locate()` 读到的 sessionId 与我假设的形状不同，要么夹具仍错，二者之一，**尚未定论** | `node tools/smoke-capture.mjs --bytes 1024` ⇒ `CAPTURE SMOKE: 1 FAILED` | **只降级提示语，不降级安全**：混批在下游由 `TransferAssembler` 的 `other-session` 拒绝兜住（G0/G5 已测 ✓ 10000 次篡改 0 误接受 ✓）。禁止用"删掉这条断言"变绿 |
| D18 | 连拍的**实机部分本机无法验证**：`getUserMedia` 授权、`facingMode/continuous` 对焦、`getImageData` 帧率、iOS Safari 的 canvas  tainted 行为 | 需真机 https 访问 | 与 D9 同类：浏览器内未验证，G9 维持 🟡 的核心理由 |
| ~~D19~~ | `build-web` 的闭包写循环未跳过 `web/capture.js` ⇒ precache 清单里 `./capture.js` 出现两次 | 第 24 轮内即修（与 selftest/sender 同处加跳过 ✓ `node tools/build-web.mjs && node tools/check-dist.mjs` 仍 8/8） | CLOSED |
| D20 | `web/dist` 里 `capture.js` 的 DOM 半边引用的 id（`burst`/`video`/`burst-log`/`burstprog`/`burststop`）来自本轮新加的 section，**没有判据保证二者不脱钩**（改 HTML 忘改 JS ⇒ 静默失效，因入口是 `getElementById('burst')` 的守卫） | 删掉 section 后 `node tools/check-dist.mjs` 仍全绿 | 需要一个"页面引用的 id 必须存在于对应脚本守卫里"的检查，或至少 selftest 里加一条 DOM 契约 |

### 第 26 轮新增（OPEN）

| # | 缺陷 | 证据 / 复现 | 性质 |
|---|---|---|---|
| D24 | **角标是手机端的分辨率地板，而 reason 会说谎**：同一页降到 1/4 面积（2260×3290 → 1130×1645 ✓ 等效 150dpi ✓ 仍是清晰降采样、无模糊噪声）⇒ **24 个几何候选全部死在 `stage:markers / reason:no-hollow-corner`** ✓ 根本没走到读出。也就是说 `rectifyPage(bitmap, layout, found.quad)` 在原理上是跨尺度的（把实测四角映到 layout 画布 ✓ 我上一轮"几何搜索不跨尺度"的说法**说过头了，撤回 ✗**）✓ 真正卡住手机的是**第四空心角在低分辨率下测不出来** | `node tools/probe-curl-tolerance.mjs --down 2 --rot 0 --bend 0` ⇒ 阶段分布 `markers/no-hollow-corner×24` | **objective 第 (1) 条手机端的直接障碍** ✓ 且 `no-hollow-corner` 语义过载（`ACCEPTANCE.md` 开放缺陷 #3 ✓）本轮**又一次把我引向错误的根因** ⇒ 拆 reason 现在是承重项，不再是"以后再说" |
| D25 | **卷曲在页级可造成大面积错读，传输级尚未验证**：native dpi 下 `bend=4px`（页中部相对四角 4 像素起伏 ✓ 真实卷纸远大于此）⇒ `bootstrapDecode` 返回 `ok:true` ✓ 而 68904 格里 **33021 格与真值不符（52.08% 一致）**；`bend≥12px` 则干脆拒绝（`no-geometry-matched` ✓ 安全）✓ **这不是误接受**——页级 ok 之上还有页间/页内 RS + 末端 SHA-256 ✓ 误接受与否由那条链定夺（G5：10000 次篡改 0 误接受 ✓）✓ 但**本探针没有替该链说话**：必须把整盘页送进组装/校验路径重测 | `node tools/probe-curl-tolerance.mjs --down 1 --rot 0 --bend 0,4,12,24,48` | **D21（对齐梳）的判决依据**：若传输级也能拒 ⇒ 梳子是鲁棒性收益、不该为此改动采样路径；若传输级**接受**了 ⇒ 属误接受家族 ✓ 优先级立刻高于 G4 ✓ 本轮未做（预算）⇒ 下一轮第一件 |

### 第 26 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D16~~ | `docs/ACCEPTANCE.md` 的 G9 行仍写"未开始/零证据" | G9 行改为 🟡 并列出 9 条产物级判据与复现命令 ✓ "一句话结论"里对 G9 的**低估**一并更正 ✓ 页头"最后更新"升至第 26 轮 | CLOSED（本轮同时说明：台账虚高与虚低同样是错 ✓） |

### D21 重新定标（第 26 轮 · 由意见改为量测）

原记"对齐梳无实现"✓ 仍然成立 ✓ 但本轮把它从"缺一项 PLAN 特性"改成可判定的命题：**四角单应能表达平移/旋转/均匀与微分缩放/剪切/透视（仿射 6 + 射影 2 自由度）✓ 逐格另有 ±1px 整数搜索 ✓ 所以梳子唯一能补的是单应表达不了的离面形变（卷曲/起伏）** ⇒ 于是要量的不是"要不要忠于 PLAN"而是"**卷曲在什么量级开始造成什么后果**" ✓ 已有页级数据（D25）✓ 待传输级数据 ⇒ 有了它才谈得上"值不值得为此动 G3/G5/G7 压着的那条采样路径" ✓



### 第 25 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D11~~ | 构建中途失败会在 `web/dist` 留半套产物（Pages 可发布出破损站） | 把 `web/send.html` 移走 ⇒ `build exit=1` ✓ 而 `web/dist` 文件数 **49→49**、`sw.js` 仍在 ✓ 恢复后无 `dist.tmp` 残留 | CLOSED（改为 `web/dist.tmp` 写完后换入 ✓） |
| ~~D17~~ | 连拍跨会话守卫"疑似"失效 | `node tools/smoke-capture.mjs` ⇒ **12/12 全通过** | CLOSED — **产品从来没错，是我的测试夹具错**：夹具第一帧喂了 `addFrame({})`（空对象）⇒ 被 `no-header` 拒 ✓ `current` 一直为 null ⇒ 第二帧自成新会话 ✓ 症状全部对上 ✓ 教训记在下方 D23 |
| ~~D19~~ | `./capture.js` 在 precache 清单中重复 | 见 D22（已泛化为通用的清单紧度判据） | CLOSED |
| ~~D20~~ | HTML 的 id 与 JS 的 `getElementById` 无判据保护 | `node tools/check-dist.mjs` ⇒ 新增第 9 条 `every getElementById in built JS exists in some built page`（48 markup ids ✓） | CLOSED |

### 第 25 轮新增（OPEN）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D21 | **PLAN §几何 L77 的"四边双频对齐梳 / 亚像素格点相位"在 `core/` 里没有实现**：fiducial 有（`layout.js:105` 三角实心 + 第四角空心 ⇒ 透视与朝向 ✓ 与 PLAN 等价 ✓），但全仓搜 `comb/梳/gridPhase` 只命中 `ideal.js:159` 的"小范围**整数**对齐搜索"，那不是梳 | `Select-String -Path core\**\*.js -Pattern "comb\|梳\|gridPhase"` ⇒ 无实现点 | **objective 第 (2) 条里唯一没证据的一块**：打印机的缩放/走纸造成的**亚像素格点相位偏移**目前只能靠整数搜索 + ECC 吸收 ⇒ 影响 G4 手机档与纸面鲁棒性，不是性能问题 |
| D22 | **构建自报的文件数与磁盘不符**（曾报 "81 files / 78 precache entries" ✓ 而磁盘只有 49）：`writeDist` 对同一文件写两次（import 闭包与"整份 core"两份清单重叠 ✓ 我第 24 轮为修 D 类问题加的 allCore）就**再记一条账** | 对比 `node tools/build-web.mjs` 与 `Get-ChildItem -Recurse -File web\dist \| Measure-Object` | 已修（去重 + 新增双向紧度判据：清单条目数必须等于磁盘产物数、且不得有重复 url ✓ 修后 49=49 ✓ precache 47 = 49−`sw.js`−`build-manifest.json` ✓）**但我上一轮把"78 条哈希逐字节核对"当成成绩写进了 STATUS ⇒ 那个数字当时是虚的 ✓ 已在 STATUS 更正** |
| D23 | 我这一族的错的**元缺陷**：连续 12 次"引用未证实的东西"，全部由执行抓获、**零次靠阅读发现**；而 D17 更说明**测试写错时我会先怀疑产品** ⇒ 需要一条习惯：断言红时**先打印夹具自身的中间量**（本轮就是加了 `frame1 …` 一行才看清） | 见 `docs/STATUS.md` 第 23–25 轮"我的错"段 | 流程改进，非代码缺陷 |



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
