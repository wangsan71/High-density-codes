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
| ~~D7~~ | ~~手机摄像头连拍取页未接线~~ → 第 24 轮接线、第 25 轮结案，见下方"闭掉的"；实机部分另立 D18 | `node tools/smoke-capture.mjs` ⇒ 12/12 ✓ | CLOSED |

### 第 24 轮新增

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| ~~D17~~ | **连拍的跨会话守卫未按预期触发**：构造"另一会话的页"时收集器返回 `kind page` 而非 `other-session`（`have 1/3`）⇒ 要么 `locate()` 读到的 sessionId 与我假设的形状不同，要么夹具仍错，二者之一，**尚未定论** | `node tools/smoke-capture.mjs --bytes 1024` ⇒ `CAPTURE SMOKE: 1 FAILED` | **只降级提示语，不降级安全**：混批在下游由 `TransferAssembler` 的 `other-session` 拒绝兜住（G0/G5 已测 ✓ 10000 次篡改 0 误接受 ✓）。禁止用"删掉这条断言"变绿 |
| D18 | 连拍的**实机部分本机无法验证**：`getUserMedia` 授权、`facingMode/continuous` 对焦、`getImageData` 帧率、iOS Safari 的 canvas  tainted 行为 | 需真机 https 访问 | 与 D9 同类：浏览器内未验证，G9 维持 🟡 的核心理由 |
| ~~D19~~ | `build-web` 的闭包写循环未跳过 `web/capture.js` ⇒ precache 清单里 `./capture.js` 出现两次 | 第 24 轮内即修（与 selftest/sender 同处加跳过 ✓ `node tools/build-web.mjs && node tools/check-dist.mjs` 仍 8/8） | CLOSED |
| ~~D20~~ | `web/dist` 里 `capture.js` 的 DOM 半边引用的 id（`burst`/`video`/`burst-log`/`burstprog`/`burststop`）来自本轮新加的 section，**没有判据保证二者不脱钩**（改 HTML 忘改 JS ⇒ 静默失效，因入口是 `getElementById('burst')` 的守卫） | 删掉 section 后 `node tools/check-dist.mjs` 仍全绿 | 需要一个"页面引用的 id 必须存在于对应脚本守卫里"的检查，或至少 selftest 里加一条 DOM 契约 |

### 第 29 轮（D26 收窄到"角簇/尝试的选择环节" ✓ 并撤回我自己的第二个猜想）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D27 | `tools/probe-marker-scale.mjs --explain` 需要读 `cropMask`/`components` 的真实形状才能写 ✓ 我第一次把 `cropMask` 的返回当 bin 传（它返回**裸 `Uint8Array`** ✓ 还副作用写 `region.cropInset` ✓）⇒ `TypeError: Cannot read properties of undefined (reading 'length')` ✓ **第 13 次"引用未证实的名字"** ✓ 由执行当场抓获 | `node tools/probe-marker-scale.mjs --explain --scales 0.5` | 探针侧 ✓ 未影响产物 ✓ 模式仍未断根（见 D23 ✓） |

**D26 的诊断进展（不改行为 ✓）**：`findMarkers` 自带 `clustersTried`（`fiducial.js:390/406` ✓ 每个角簇假设一条记录 ✓）⇒ 150dpi 失败时它**只试了一个簇**：`cluster 15px -> no-hollow-corner hollow=0` ✓ 而在**同一尺度、同一份裁剪后掩模**上手工走它自己的判据：15×15 且 `area=200 < 225` 的那个 blob（即带孔的那个 ✓）**中心 5×5 窗口着墨率 = 0.00** ✓ 远低于空心判据 0.35 ✓ ⇒ **空心角标明明在候选集里** ✓ 结论：丢失发生在**角簇/尝试的选择环节**（`fiducial.js` L360–400 一带 ✓ 聚簇只产出一个假设、且它取自孔被填掉的那次阈值尝试）✓ **不是二值化本身 ✓ 也不是格点几何 ✓**

**撤回我的第二个猜想** ✗ 本轮我先假设"探针半径 `round(min(w,h)*0.12)` 随尺寸跳档 ⇒ 5×5 把环墨也量进去 ⇒ 空心被判成实心" ✓ 上面那张 r1/r2/r3 表把它否证了：150dpi 处 `probe=2`（5×5 ✓）而 5×5 的着墨率是 **0.00** ✓ 孔完好 ✓ 该解释不成立 ✓ 记下来防止我以后又拿它当结论 ✓（同一轮里它还顺带否证了"角标像素预算地板"✓ 见 D24 更正 ✓）

**修法暂不下注**：要动的是 `findMarkers` 的角簇枚举/阈值尝试取舍（L360–400 ✓）✓ 那是角标朝向判定的所在地 ⇒ **改完必须重跑 `tests/unit`（含"90 度旋转页仍能解出 ✓ 朝向来自空心角标"这条）+ 全套门限** ✓ 未做 ✓ 下一轮首位 ✓



### 第 28 轮（一次"测量否决了自己的修复" ✓ 并抓出更锋利的 D26）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D26 | **角标检测对尺度不单调**：同一张干净降采样的页（无模糊、无噪声、无 JPEG），**105dpi 与 120dpi 能找到四角 ✓ 150dpi 却找不到** ✓ 90dpi 又失败 ✓ 即"越清晰越认不出"的反复翻转 ✓ 三次翻转 | `node tools/probe-marker-scale.mjs` ⇒ `exit=2` + `NON-MONOTONIC` 三行翻转记录 | **这才是手机端真正的地板问题**（不是我上一轮说的"像素预算"✗ 已撤回 ✓）✓ 失败形态统一是 `hollow=0` 而候选很多（150dpi 时 cand=10 ✓）⇒ 像二值化阈值阶梯/候选选择与该尺度的相互作用 ✓ 定位它才能给出"该靠近还是该重拍"的分类 ✓ |

**本轮撤回我自己的两句话（都是我自己上一轮写的）** ✗
1. **D24 的"角标像素预算是地板"说过头了** ✓ 真凭据是 D26 的非单调：105/120dpi 能解、150dpi 不能 ✓ 若"像素不够"是唯一原因 ⇒ 更高分辨率只会更好 ✓ 数据直接否证 ✓
2. **"用一个像素阈值拆 `no-hollow-corner`"这个修复方案作废** ✓ 因为**现在没有合法信号可用**：我加的读数原本叫 `maxMarkerSide` ✓ 实测在两个失败例里分别读到 **15 与 9**（失败得更"轻"的那个反而更大 ✓）⇒ 它量的是**最大连通块**（很可能是粘连的数据格）✓ **不是角标尺寸** ✓ 拿它定阈值＝给假信号立法 ✓ 该字段已改名 `maxBlobSide` 并在注释里写明它不是什么、不许用它推像素地板 ✓

**D24 后半（拆 reason）因此从"本轮就做"变成"阻塞在 D26"**：先定位非单调的成因 ✓ 有了真信号再拆 ✓ 不硬造分类 ✗

**顺带的事实**：`core/decode/fiducial.js` 只新增失败返回里的诊断字段（`maxBlobSide` / `candidates` ✓ 不改任何判定）✓ 全套单测 **233/233** 通过 ✓ 门限重跑见 `docs/STATUS.md` 第 28 轮 ✓


### 第 27 轮闭掉的（第一次由测量决定特性优先级 ✓）

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D25~~ | 卷曲在页级可造成大面积错读，**传输级未验证** | `node tools/probe-curl-tolerance.mjs --down 1 --rot 0 --bend 0,4,12 --transfer` ⇒ 控制档 `bend=0` **ACCEPTED-CORRECT**（1024 B vs 1024 B ✓ `fed×3` ✓）⇒ 表算数；`bend=4px`（页级曾 47.9% 错读）在传输级被 **`assemble-rejected/intra-fail×3` → REFUSED（`have 0/1`）** ✓✓ 页间/页内 RS + 末端 SHA-256 **精确兜住 ⇒ 零误接受** ✓；`bend=12px` 直接解码拒绝 ✓ | CLOSED：**误接受为 0 的契约在该形变下成立**（合成信道 ✓ 不替代 G4 真实照片档 ✓） |
| ~~D21~~ | PLAN L77 的"四边双频对齐梳 / 亚像素格点相位"无实现 | 同上一条命令（`--transfer` ✓ 传输级只拒不误收 ✓） | CLOSED-为判决、**非闭为已实现**：梳子仍未实现 ✓ 但**不足以成为改动采样路径（G3/G5/G7 全压其上）的理由** ⇒ 降级为"G4 真机数据出来后按实测定去留" ✓ PLAN 里该项仍标未实现 ✓ 不改契约文本 ✓ |

**本轮也撤回我自己写的一句过重的话**：我先在探针注释里写"连拍冒烟的 `feed` 是桩 ⇒ 手机真接线从未执行"✓ 读 `tools/smoke-capture.mjs:49-52` 后确认那里用的**就是真 `TransferAssembler`**（`asm.feed({levels, header: headerBytes, channelMissing})` ✓ 与 `cli/pskit.mjs:448` 同形状 ✓）且 63-64 行断言 `asm.result` 摘要 ✓ 桩只出现在门控子用例（恰当 ✓）⇒ **手机那条链其实已被 12/12 那轮证明** ✓ 注释已改回事实 ✓ 记此一条：**虚假的自我批评同样是台账污染**（与虚高、虚低同一类错 ✓）



### 第 26 轮新增（OPEN）

| # | 缺陷 | 证据 / 复现 | 性质 |
|---|---|---|---|
| D24 | **角标是手机端的分辨率地板，而 reason 会说谎**：同一页降到 1/4 面积（2260×3290 → 1130×1645 ✓ 等效 150dpi ✓ 仍是清晰降采样、无模糊噪声）⇒ **24 个几何候选全部死在 `stage:markers / reason:no-hollow-corner`** ✓ 根本没走到读出。也就是说 `rectifyPage(bitmap, layout, found.quad)` 在原理上是跨尺度的（把实测四角映到 layout 画布 ✓ 我上一轮"几何搜索不跨尺度"的说法**说过头了，撤回 ✗**）✓ 真正卡住手机的是**第四空心角在低分辨率下测不出来** | `node tools/probe-marker-scale.mjs` ⇒ 见 D26 ✓（本行原写的"角标像素预算地板"**已撤回** ✓ 该探针证明失败与尺度非单调 ✓） | 原判断"手机端卡在角标像素预算"**不成立** ✓ 剩下的真问题是 D26 的非单调 + `no-hollow-corner` 语义过载（`ACCEPTANCE.md` 开放缺陷 #3 ✓ 本轮又一次把我引偏 ✓）⇒ 拆 reason 阻塞在 D26 定位 ✓ |
| ~~D25~~ | **卷曲在页级可造成大面积错读，传输级尚未验证**：native dpi 下 `bend=4px`（页中部相对四角 4 像素起伏 ✓ 真实卷纸远大于此）⇒ `bootstrapDecode` 返回 `ok:true` ✓ 而 68904 格里 **33021 格与真值不符（52.08% 一致）**；`bend≥12px` 则干脆拒绝（`no-geometry-matched` ✓ 安全）✓ **这不是误接受**——页级 ok 之上还有页间/页内 RS + 末端 SHA-256 ✓ 误接受与否由那条链定夺（G5：10000 次篡改 0 误接受 ✓）✓ 但**本探针没有替该链说话**：必须把整盘页送进组装/校验路径重测 | `node tools/probe-curl-tolerance.mjs --down 1 --rot 0 --bend 0,4,12,24,48` | **D21（对齐梳）的判决依据**：若传输级也能拒 ⇒ 梳子是鲁棒性收益、不该为此改动采样路径；若传输级**接受**了 ⇒ 属误接受家族 ✓ 优先级立刻高于 G4 ✓ 本轮未做（预算）⇒ 下一轮第一件 |

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
| ~~D21~~ | **PLAN §几何 L77 的"四边双频对齐梳 / 亚像素格点相位"在 `core/` 里没有实现**：fiducial 有（`layout.js:105` 三角实心 + 第四角空心 ⇒ 透视与朝向 ✓ 与 PLAN 等价 ✓），但全仓搜 `comb/梳/gridPhase` 只命中 `ideal.js:159` 的"小范围**整数**对齐搜索"，那不是梳 | `Select-String -Path core\**\*.js -Pattern "comb\|梳\|gridPhase"` ⇒ 无实现点 | **objective 第 (2) 条里唯一没证据的一块**：打印机的缩放/走纸造成的**亚像素格点相位偏移**目前只能靠整数搜索 + ECC 吸收 ⇒ 影响 G4 手机档与纸面鲁棒性，不是性能问题 |
| D22 | **构建自报的文件数与磁盘不符**（曾报 "81 files / 78 precache entries" ✓ 而磁盘只有 49）：`writeDist` 对同一文件写两次（import 闭包与"整份 core"两份清单重叠 ✓ 我第 24 轮为修 D 类问题加的 allCore）就**再记一条账** | 对比 `node tools/build-web.mjs` 与 `Get-ChildItem -Recurse -File web\dist \| Measure-Object` | 已修（去重 + 新增双向紧度判据：清单条目数必须等于磁盘产物数、且不得有重复 url ✓ 修后 49=49 ✓ precache 47 = 49−`sw.js`−`build-manifest.json` ✓）**但我上一轮把"78 条哈希逐字节核对"当成成绩写进了 STATUS ⇒ 那个数字当时是虚的 ✓ 已在 STATUS 更正** |
| D23 | 我这一族的错的**元缺陷**：连续 12 次"引用未证实的东西"，全部由执行抓获、**零次靠阅读发现**；而 D17 更说明**测试写错时我会先怀疑产品** ⇒ 需要一条习惯：断言红时**先打印夹具自身的中间量**（本轮就是加了 `frame1 …` 一行才看清） | 见 `docs/STATUS.md` 第 23–25 轮"我的错"段 | 流程改进，非代码缺陷 |



### 第 24 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D7~~ | 手机连拍取页 | `node tools/smoke-capture.mjs` ⇒ 11/12：真实 3 页**逐页收下并解回原摘要** ✓ 重复页判为 `duplicate` 不算进度 ✓ "角标 6px / 覆盖率 40%" 各出一条可执行提示 ✓ 页数声明冲突拒绝 ✓ **裁掉的页不被接受** ✓ | CLOSED（连拍外壳已接线并验证；实机部分转 D18，跨会话守卫转 D17） |

| D8 | 浏览器打印服从用户的缩放选择；缩放错则几何错（帧头会拒收 ⇒ 不静默出错，但要重扫） | 打印后以 300 dpi 扫描，比较 `cellPx` | 已知限制；UI 与 `pack.pdf` 是正解 |
| ~~D11~~ | **构建失败会在 `web/dist` 留下半套产物**（本轮 PWA 段抛异常时 `sw.js` 缺失、其余文件仍在），Pages 若被配成"推什么发什么"就会发出破损站点 | `node -e "..."` 使 build 中途抛错，再看 `web/dist` 存在但缺 `sw.js` | 原子性：写 `dist.tmp` 再改名换入 |
| D12 | `tests/unit/advice-coverage.test.mjs` 的正则 `/reason:\s*'(...)'/g` **会读注释里的文字**：我为解释"把成功路径的 reason 改名"而在注释里写下那个字面量，测试立刻要求给一条**成功**配建议 | `node --test tests/unit/advice-coverage.test.mjs`（改注释前后各跑一次即见） | 判据扫描器把散文当代码；与我本轮在 build-web 里犯的同一族 ✓ 修法=扫描前剥注释（不改判据强度） |
| D13 | PWA 图标是一张 2260×3290 的**非方形**页图；`sizes` 走的是 `${w}x${h}` 分支，iOS 对非方形/`any` 支持差 ⇒ 主屏图标可能被忽略 | `node tools/build-web.mjs` 打印 `icon 211384 B (2260x3290)` | 需要在构建期裁成方形（自家编码器可重画 ✓ 不引依赖） |
| D14 | `send.html` 上"纸张 A4/Letter"下拉框**是惰性的**：纸面尺寸实际来自 `t.geom.sheetMm`（编码器决定 ✓ 与 CLI 一致），改这个框不影响输出 | 切 A4→Letter 再编码，看日志里 `纸 W×Hmm` 不变 | UI 说了谎：应删除该控件或改为"仅提示" |
| D15 | `sender.js` 里 `parityPages` 用 `header.kind === 'parity'` 判校验页数，`kind` 的**取值域我未证实**（不影响产物 ✓ 只影响那一句计数） | `node -e` 打印 `t.pages[0].header` | 又一个"未证实字段"实例（第 9 次 ✓ 模式未断根） |
| ~~D16~~ | `docs/ACCEPTANCE.md` 的 G9 行仍是旧结论（写"未开始"），本轮 G9 已 8/8 ✓ 台账与判据页不一致 | `Select-String docs/ACCEPTANCE.md -Pattern G9` | 记账欠账，下一轮第一件事（连同 STATUS 现况表 G9 行一起改） |

## 判读提示（避免误读别人的结论）

- `pwsh` 里用 `... | Select-Object -First N` 截断 node 的输出流会让 node 被杀 ⇒ **进程退出码 1**，而门限本身可能全绿。要判绿黑请看**末行**（`ALL GATES PASS`）或不要用 `-First`。本轮我差点把这条当成一次门限失败记进台账 ✓
