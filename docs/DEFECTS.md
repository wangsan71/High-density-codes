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
| ~~D4~~ | `index.html` 里没有指向 `send.html` 的入口：接收端用户在站内点不到发送端 | 打开 `web/dist/index.html` 目视（只能手输 `/send.html`） | 客户端可用性 |
| ~~D5~~ | 发送端未进 `pskt-file.html` 单文件变体 ⇒ `file://` 下只能"收"不能"发" | `Select-String web/dist/pskt-file.html -Pattern sender` ⇒ 无 | PLAN 只要求接收端 file:// 可用，故列为待办非违约 |
| ~~D7~~ | ~~手机摄像头连拍取页未接线~~ → 第 24 轮接线、第 25 轮结案，见下方"闭掉的"；实机部分另立 D18 | `node tools/smoke-capture.mjs` ⇒ 12/12 ✓ | CLOSED |

### 第 24 轮新增

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| ~~D17~~ | **连拍的跨会话守卫未按预期触发**：构造"另一会话的页"时收集器返回 `kind page` 而非 `other-session`（`have 1/3`）⇒ 要么 `locate()` 读到的 sessionId 与我假设的形状不同，要么夹具仍错，二者之一，**尚未定论** | `node tools/smoke-capture.mjs --bytes 1024` ⇒ `CAPTURE SMOKE: 1 FAILED` | **只降级提示语，不降级安全**：混批在下游由 `TransferAssembler` 的 `other-session` 拒绝兜住（G0/G5 已测 ✓ 10000 次篡改 0 误接受 ✓）。禁止用"删掉这条断言"变绿 |
| D18 | 连拍的**实机部分本机无法验证**：`getUserMedia` 授权、`facingMode/continuous` 对焦、`getImageData` 帧率、iOS Safari 的 canvas  tainted 行为 | 需真机 https 访问 | 与 D9 同类：浏览器内未验证，G9 维持 🟡 的核心理由 |
| ~~D19~~ | `build-web` 的闭包写循环未跳过 `web/capture.js` ⇒ precache 清单里 `./capture.js` 出现两次 | 第 24 轮内即修（与 selftest/sender 同处加跳过 ✓ `node tools/build-web.mjs && node tools/check-dist.mjs` 仍 8/8） | CLOSED |
| ~~D20~~ | `web/dist` 里 `capture.js` 的 DOM 半边引用的 id（`burst`/`video`/`burst-log`/`burstprog`/`burststop`）来自本轮新加的 section，**没有判据保证二者不脱钩**（改 HTML 忘改 JS ⇒ 静默失效，因入口是 `getElementById('burst')` 的守卫） | 删掉 section 后 `node tools/check-dist.mjs` 仍全绿 | 需要一个"页面引用的 id 必须存在于对应脚本守卫里"的检查，或至少 selftest 里加一条 DOM 契约 |

### 第 40 轮新增（OPEN）

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| D42 | **我把"node 里不能 spawn 子进程"错误推广成"语料不能自己造"⇒ 数轮把 G2 按 32/200 记账，并把"200 seeds 需用户带外手跑"写进 `docs/STATUS.md` 与 `docs/ACCEPTANCE.md`** ✗ 实际：**pwsh 工具跑 python 一直是通的**（`AGENTS.md`"环境事实"里的 Python 3.10.9 / numpy / cv2 本来就是这么探测出来的 ✓）⇒ 被禁的只是 **node 进程内的管道 stdio**，不是宿主 shell ⇒ 一个作用域记错，让门限的样本量长期停在判据的 1/6，还让"下一步"里排着一件**根本不需要用户**的事 | 实测（第 40 轮）：`python sim/channel.py --in .tmp/g2src --out .tmp/nc-scan300-17 --seed 17 --preset scan300 --modifier nocrop` ⇒ **15 s / 26.5 MB / 3 页**，`verify --gate G2 --corpus .tmp/nc-scan300-17` ⇒ exit 0、`204800 bytes, digest verified` **字节相同** ✓ 批量 seeds 18–29 ⇒ **12 份 / 174 s** ✓ `nc-scan*` 由 32 → **45** ✓ 再判 `--root .tmp --match 'nc-scan300-*'` ⇒ **exit 0、29/29 byte-exact、134.6 s**（4.6 s/份）⇒ 200 seeds 的代价可算：scan300 侧 ≈ **50 min / 5.3 GB**，600 dpi 侧像素约 4× ⇒ 合计数小时 / ~25 GB（D 盘 2 TB ✓）· 另测得操作事实：判**全 45 份**超工具 **600 s** 上限被杀（`exit 1` = 终止 ✓ 600 dpi 那 16 份占大头）⇒ **按 dpi 分开判**，且 `timeoutMs` 传更大值**无效**（执行器封顶）✗ | **OPEN ✗** 剩余动作：① `docs/ACCEPTANCE.md` 的 G2 段仍写着"需带外手跑"⇒ 改成上面这条已验证命令（本轮上下文耗尽 ✗ 不硬凑）② 把 scan300 补到 **200 seeds**（分批、每批 ≤600 s）、scan600 侧从 `.tmp/sw-scan600-src` 同法补齐，并诊断已知的两类失败（`nc-scan600-3` short 0/1、`nc-scan600-10` no-page-header ⇒ ACCEPTANCE #4）③ 顺带清 D41 行里那句已被取代的旧口径 ④ 把"沙箱禁的是 node 的管道 stdio、不是宿主 shell"写进 `AGENTS.md` 陷阱表（现有那行只写了"门限进程内跑"，正是它被我读窄的 ✗） |

### 第 38 轮新增（D41 ⇒ **第 39 轮已闭** ✓）

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| D41 | **我拿一份从网上取来的 schema 变体当权威，判了自己发射器"违规"——而权威文件 `ref/3mf-core-1.4.0.xsd` 一直在盘上、`docs/STATUS.md` L38 还点名了它** ✗ 后果具体：新写的 `tools/check-3mf.mjs` 第一版把 `object/@name` 判为违规 ⇒ `verify --gate G8` 对我们**每一份** 3MF（含 M5 那轮的历史产物）报 FAIL ⇒ **若我信了它，下一轮就会去"修"一个不存在的缺陷**：删发射器的 `name`、改 `parseModelXml` 的 object 正则（它把 `name` 当必需且在固定位置 ⇒ 删了就一个对象都读不出）、动 mesh 测试、并因 `core/` 改动重建 `web/dist` ⇒ 一次纯粹的自我破坏 ✓ 根因不是"取错文件"，而是**没有先查工作区**（AGENTS.md 与 goal 提示都写着 inspect instead of assuming ✗ 我 grep 了 `*.mjs` 却没看 `ref/`）⇒ **D29 同族（引用未核实/非权威证据）第 3 次** | 权威原文（本地 vendored ✓ 逐条读过）：`ref/3mf-core-1.4.0.xsd` **L84-101** `CT_Object` = `id/type/thumbnail/partnumber/`**`name`**`/pid/pindex` + `xs:anyAttribute namespace="##other"` ⇒ **`name` 合法**；**L211-217** `ST_ObjectType` 有 **5** 个枚举（网上变体只有 2 个）；**L201-208** `ST_ResourceID/Index` = positiveInteger/nonNegativeInteger 且 `maxExclusive 2^31`；**L110-125** `CT_Vertices` minOccurs=3、`CT_Triangles` minOccurs=1；**L221-236** core 元素只有 **16** 个（**无** `colorgroup`/`color`/`texture2d` ⇒ 属扩展 schema ⇒ 我表里那两个是凭记忆多加的 ✗）⇒ 按权威改表后实测：`node cli/pskit.mjs verify --gate G8` **PASS / exit 0** —— 本轮造的 `PL-D2@0.4`（3 objects / 377964 triangles / 4.1 MB）✓ 历史产物 `.tmp/m5det1/page-000.3mf`（426444 tri）✓ `.tmp/m5verify/page-000.3mf`（45132 tri）✓ 且 `tests/unit/threeMF-subset.test.mjs` **25/25**：21 条篡改用例每条按预期原因触发 ✓ 4 组正例含 **"D40 回归守卫"（`name`+`partnumber` 必须一直合法）**、`p:UUID` 这类**带前缀的扩展属性必须合法**、**5 个 `type` 枚举必须合法**、**命名空间用前缀绑定也必须通过**（证明它解析命名空间而非匹配字符串 ✓） | **CLOSED（第 39 轮 ✓）** 修法（按计划做完 ✓）：**加一条"表 ⇄ 权威 XSD 对拍"的测试**——用 `check-3mf.mjs` 自己的 `scanXml` 读 `ref/3mf-core-1.4.0.xsd`，抽出每个 `CT_*` 的属性名集合与 16 个元素名，与 `ELEMENTS` 逐项比对 ⇒ 表再抄错/漂移就红 ✓ 现有保护只有"篡改用例 + 正例"：它防得住**已知规则失效**，防不住**表本身抄错**（本轮正是抄错 ✗）⇒ 另把"先查 `ref/` 再上网"写进 `AGENTS.md` ✓ |

### 第 38 轮**撤回**的（D40 **不是缺陷** ✗ 下面那行保留为历史、**别信它**）

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| D40 | **〔第 38 轮**撤回**：本行结论经权威 XSD 复核为**错** ⇒ `ref/3mf-core-1.4.0.xsd` **L97** 明确声明 `<xs:attribute name="name" type="xs:string"/>` 于 `CT_Object`、且 **L100** 有 `xs:anyAttribute namespace="##other"` ⇒ `object/@name` **合法**；我引的是网上那份旧变体（无 `pid`、`materials`/`materialtype`、只有 2 个 `type` 枚举）✗ 真缺陷是"引非权威来源 + 没先查工作区"⇒ 见上方 **D41** ✓ 本行保留为历史 ✗ 别照着它去改发射器〕** **我们发出的每一份 `.3mf` 都在 `<object>` 上写 `name="…"`，而 3MF Core schema 的 `CT_Object` 没有这个属性、也没有 `xs:anyAttribute` 兜底** ⇒ 严格校验器/部分切片机会拒收 ✗ 证据是**取来的原文、不是我记忆里的**：3MF Consortium 自己的 schema `https://raw.githubusercontent.com/3MFConsortium/3mf-samples/master/verifier/3mf.xsd`（命名空间与我们发射的 `core/2015/02` 一致 ✓）里 `CT_Object` 只声明 `id/type/materialtype/materialid`（该变体）· Core 1.4 官方是 `id/type/pid/pindex/thumbnail` ⇒ **两个来源都没有 `name`** ✓ 且 schema 头写着 `blockDefault="#all"`、`attributeFormDefault="unqualified"` ⇒ 未声明属性即违规 ✓ 影响面：**不是本轮回归，是我们发过的每一份**（历史产物 `.tmp/m5det1/page-000.3mf`、`page-004.3mf` 实测同样命中 ✓）⇒ 而 `selfCheck3MF` 对同一份文件报 `ok` ✗——因为它的解析器"只认自己写出来的那种形状"⇒ **自检在原理上无法发现"这个形状本身不合 schema"** ✓ 本轮写独立校验器的理由被当场兑现 | `node cli/pskit.mjs verify --gate G8`（进程内造 PL-D2@0.4 板材 3MF：3 objects / 377964 triangles / 4.1 MB）⇒ **FAIL / exit 1**，且**唯一**一类问题就是 `attribute "name" is not allowed on <object>`（包结构、部件名、内容类型覆盖、关系与起始部件、unit、id 唯一性与正整数、三角形索引范围、退化三角形、DTD/实体、命名空间**全部通过** ✓）· `--gate G8 --file .tmp/m5det1/page-000.3mf,.tmp/m5det1/page-004.3mf` 对历史产物同样 FAIL ✓ 规则**可失败**由 `tests/unit/threeMF-subset.test.mjs` 保证：**18 个篡改用例（每条规则一个，且断言失败原因匹配）+ 4 个正例**，正例含"命名空间用前缀 `m:` 绑定也必须通过"⇒ 证明它**解析命名空间而不是匹配字符串** ✓ 22/22 绿 ✓ | **OPEN ✗** 修法（**需一整轮**）：把对象名移到 schema 允许的位置（Core 1.4 的 `CT_Object` 允许 `<metadata>` 子元素 ⇒ 写 `<metadata name="pskt:object">`，或只留在包级 metadata）⇒ **牵连**：`core/mesh/threeMF.js` 的发射器 + `parseModelXml` 的 object 正则（它把 `name="…"` 当**必需且在固定位置** ⇒ 删属性会直接读不出对象 ✗）+ `tests/unit/mesh-3mf.test.mjs` 若干断言 + **`core/` 改动 ⇒ 必须重建 `web/dist` 再跑 check-dist** ✓ **不做"把校验规则放宽到允许 name"这种修法** ✗ 那是改判据让红变绿 ✓ |

### 第 37 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D38~~ | **G2 存在一条"假绿"通道**：盘上没有任何东西能区分"干净渲染的语料"与"过了信道的语料" ⇒ 实测 `.tmp/g2src`（干净）与 `.tmp/g2scan`（过信道）**文件清单完全相同**（`manifest.json` + 3 张 PNG + `pskt-received.out`）✗ 也没有信道报告存在页旁 ✗ 而干净渲染**必然逐字节还原** ⇒ 把 `--gate G2` 指向 `.tmp/g2src` 就会打印 `100% byte-exact` 而**什么都没测**（G2 测的是"印出来、扫回来还对不对"✓）⇒ 这正是本仓库唯一不可原谅的输出形态 | 新增 `corpusProvenance(dir)`（`tools/g2-corpus.mjs` 导出 ✓）：**量灰阶数**——我们的渲染器只发少数电平（300dpi 页 **10 阶** = 调色板+抗锯齿），而模糊/噪声/光照把扫描铺满值域（同一页 **249–256 阶**）✓ **在盘上 119 个语料目录上实测分离：干净渲染 10–18 阶 · 过了信道的 192–256 阶 ⇒ 地板取 64，两边各留 10 倍余量 ⇒ 不是调出来的旋钮 ✓** 阳性对照：`node cli/pskit.mjs verify --gate G2 --corpus .tmp/g2src` ⇒ **`FAIL G2: .tmp/g2src looks pristine (10 grey levels in page-000.png, floor 64)` 且 exit 1** ✓ 真语料 `--corpus .tmp/g2scan` ⇒ 正常评估、`PASS ... 1/1 byte-exact` ✓ | CLOSED（**只每语料量第一页**：这一问是"这批页怎么来的"、不是"每页质量如何"✓ 后者本来就是摘要判据的事 ✓） |
| ~~D39~~ | **`cmdVerify` 的 `allOk &&= ok` 会把任何真值当成通过** ⇒ 一个返回对象的 runner（例如"我没法评估"的 `{skipped:...}`）会被算成**绿** ✗ 接 G2 时必然踩到：G2 在没有语料时**不该算通过、也不该让其余门限的绿作废** ⇒ 需要第三种状态，而旧循环只有两种 | 循环现在显式识别 skip ⇒ 汇总行**点名**未评估的门限：`ALL GATES PASS -- 0/1 evaluated, 1 skipped` + 一行给出"要怎么才能评估它"（含生成语料的 python 命令 ✓）⇒ `ALL GATES PASS` 前缀保持可 grep ✓ 但**不能再被引用成"覆盖了比实际更多的门限"** ✓ 复现：`node cli/pskit.mjs verify --gate G2`（不给 `--corpus`）⇒ exit 0 + 点名跳过 ✓ 而 `verify --gate all --seeds 2` ⇒ 仍 `ALL GATES PASS`、G0 `247 passed, 0 failed`、并多出 G2 的跳过说明 ✓ | CLOSED |



### 第 36 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D36~~ | `no-hollow-corner` 语义过载（"第四角没拍进画面"与"角标在但孔读不出"共用一个 reason ✓ 曾连续误导两次根因分析 ✓）· 第 33 轮的拆法被否证 ✓ **但那条否证记录的机制本身也是错的**（见下）✗ | **真机制（实测 ✓ 非推理）**：`clustersTried=[{clusterPx:30,...},{clusterPx:5,...}]` 而最终报告 `maxBlobSide=5` ⇒ 失败是从 **5px 的数据格点簇**报出来的（`progressScore` 平手时 `+candidates` ⇒ 152 成员的格点簇压过 4 成员的角标簇 ✓ 即 **D37**）⇒ 我那个"任意三元组 + 附近有没有 blob"的判别器是**在格点上**算的 ⇒ 格点里任取三个都能拼直角 ⇒ 必然误报 ✗ 而我当时写的"top-14 按面积把真角标挤出去"是**编的**：实测 30px 簇只有 4 个成员、面积 `900/900/900/841`、**我画的方块就在 top-14 里** ✗（我引用的 `cand=159` 是 detectIn 覆写的 `squares.length`、不是枚举池大小 ⇒ **又一次引用未核实的证据 ⇒ D29 同族 ✓**）**sound 拆法**：三个同尺寸方块若构成页尺度直角 ⇒ 它们确定的矩形有第四角 ⇒ **该点是否落在图像内是一次边界检查、没有容差可调** ✓ 越界 ⇒ `fourth-corner-out-of-frame`（新 reason ✓ rank 4 ✓ advice 已配 ✓）· 在界内 ⇒ 仍是 `no-hollow-corner`（"角标读不出/被遮"✓ 建议清污翻面重印 ✓ 语义正确）✓ **几何事实**：轴对齐时第四角必在前三点的包围盒内 ⇒ 该分支**只在旋转/透视下触发**——而那正是手持手机的情形 ✓ **判据**：`tests/unit/fiducial-corner-damage.test.mjs` 5 条全绿 ✓ 含"臂长 609px、隐含角 (1400,920) 越界 ⇒ 必须报 out-of-frame"✓ 与"隐含角 (1000,1000) 在界内 ⇒ 不许甩锅给取景"✓ 与"四点全实心仍走原路径"✓ 与"三点共线 ⇒ `no-rectangular-quad`（分支不能被垃圾触发）"✓ 全套 244/244 ✓ | CLOSED（**并修正记录**：第 33 轮那条否证保留为历史 ✓ 但其机制描述已被本行取代 ✗ 另注：第 33 轮的夹具"在全尺寸图里把角涂白"**根本不是在模拟没拍全** ✓ 那是"角在画面内但读不出"⇒ 夹具本身测错了对象 ✓ 已在新测试的注释里写明 ✓） |
| ~~D37~~ | **`progressScore` 的平手裁决在 detectIn 里选错簇**：`rank*1000 + candidates` 用于"同一幅图的多个尺寸簇"时，**候选数多者胜** ⇒ 152 成员的数据格点簇压过 4 成员的角标簇 ⇒ 用户看到的 `maxBlobSide=5`（一个格点）而角标其实是 30px ✗ 潜在影响更大：**任何在该簇上计算的判别器都是在格点上计算** ⇒ 第 24/26 轮关于"分辨率地板"的两次分析所依据的数字可能一直是格点产物 ✗ | 新增 `reasonRank()` + `betterFailure()`（rank 优先 ⇒ 更深入的失败永远赢 ✓ 平手时**取最大 anchor、再取最少成员**——"四个角就是四个角标"✓）✓ 实测同一夹具：修前 `maxBlobSide=5`、修后 **`blob=30px, cluster=30px`** ✓ 失败返回新增 `clusterPx`/`clusterMembers`/`clustersTried[].members` 便于复核 ✓ **未动 `progressScore` 本身**：它在 findMarkers 的阈值梯子里用"候选更多=更进步"是对的 ✓ 只在簇间比较时换成新裁决 ✓ 簇门槛 `>=4` 放宽为 `>=3`（真·少拍一角时只剩三个角标 ⇒ 原本连诊断都进不去、只会说"没有四个同尺寸的"✗）⇒ **buildQuad 在 3 个成员时永不返回 ok ⇒ 只扩大诊断、不扩大接受面** ✓ 由 G5 误接受门限与 244/244 单测复核 ✓ | CLOSED |



### 第 33 轮新增（OPEN）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| ~~D36~~ | **〔第 36 轮修正：本行写的失败机制经实测为错 ⇒ 真机制与 sound 拆法见上方"第 36 轮闭掉的"表 ✓ 本行保留为历史 ✗〕** `no-hollow-corner` 的**语义过载仍未拆开**（ACCEPTANCE 开放缺陷 #3 ✓ 它曾连续误导两次根因分析 ✓）✓ 本轮做了一个**看起来显然、实则不成立**的拆法并把它否证掉：拿同尺寸的三个方块拼出页尺度直角 L ⇒ 用 L 推出第四角应有位置 ⇒ 看那儿有没有东西 ✗ **159 个方形候选里最大的那些是合并的数据格点** ✓ 而 `buildQuad` 的枚举池是**按面积取前 14** ⇒ 真角标挤不进去 ✓ 于是假 L 推出的 `q` 落在别处 ✓ 一个"角标在、只是孔不可读"的页被报成"没拍全" ✗ 换成全集候选则反向失衡（任意点附近更容易有东西 ⇒ 遮角情形被吞进"糊住"分支 ✓）**两个夹具互相拉扯 ⇒ 不是参数没调好 ✓ 是路子不对 ✓** | `node --test --test-isolation=none "tests/unit/fiducial-corner-damage.test.mjs"` ⇒ 打印 `D36 现状 · 第四角被遮=no-hollow-corner(hollow=0,cand=158) · 角标在而孔不可读=no-hollow-corner(hollow=0,cand=159)` ✓ **两种含义相反的失败 ✓ 同一个字符串 ✓** 且两者都被拒收（**无误接受 ✓**） | 新文件 `tests/unit/fiducial-corner-damage.test.mjs` 把这件事变成**可复现的一行输出**（此前只有散文描述 ✓）✓ **不交付会说谎的 reason** ⇒ 已撤回 ✓ 真正的拆法必须把"第四角该在哪"锚在**剖面自己的几何**上（用 layout 声明的页尺寸预测角位 ✓ 而不是靠任意三元组 ✓）⇒ 需要失败路径能拿到角标簇而不是 top-N ✓ 归 G4 待办 ✓



### 第 32 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D5~~ | 发送端未进单文件变体 ⇒ `file://` 下只能"收"不能"发" ⇒ 气隙场景真正缺的那一半 | 新增产物 **`web/dist/pskt-send-file.html`（306.7 KiB ✓）** ✓ 与接收端单文件同一条流水线派生（内联 CSS ✓ 内联 bundle ✓ **剥掉 `<nav class="tabs">` 回链** ✓ 标题标注单文件版 ✓）✓ 复验：`node tools/build-web.mjs && node tools/check-dist.mjs --pages .tmp/g2src` ⇒ **11/11 PASS** ✓ 其中两条新判据直接压在这件事上（"内联脚本必须能解析 ✓ 2 blocks parsed" ✓ 与"单文件除 `data:` 外不引用任何东西" ✓）✓ 另注：**真正的拦路石不是页面而是三行死代码**（见 D35 ✓） | CLOSED |
| ~~D35~~ | **三行 `export default` 死代码让 `core/render/pdf.js` 永远进不了浏览器 bundle** ⇒ 而发送端的 `pack.pdf` 是真功能（`send.html:12` ✓ 非可选）⇒ D5 一直被它挡住 ✗ 全仓库**没有任何一处** import 这三个 default（唯一的 default-import 是 tools/tests 里的 `node:` 内建 ✓ 逐一查过 ✓） | 删掉 `pdf.js/png.js/tiff.js` 三行 default ✓ 改为注释说明约定 ✓ **并加判据防复发**：新 `tests/unit/export-conventions.test.mjs`（3 条 ✓ 含"目录确实走到了"的防空跑守卫 ✓ 与"core/ 不得 import `node:` 内建"这条 AGENTS.md 早写着、此前**无判据** ✓ 的规则）✓ 负向证明：把 HEAD 版旧内容按真实编码读出来喂给同一正则 ⇒ **命中 true** ✓ 工作版 false ✓ 具名导出仍在 ✓ ⇒ 判据不是空跑 ✓ | CLOSED（两条"有约定无判据"的规则从此有判据 ✓） |

### 第 32 轮新增（OPEN）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| ~~D32~~ | **PowerShell 的 `>` 重定向把 `git show` 的输出写成 UTF-16LE**（首字节 255 = `0xFF` BOM ✓）⇒ 我用 UTF-8 读它 ⇒ `indexOf('export default')` 返回 -1 ⇒ **差点得出"我的判据是空跑的"这个错结论** ✗ 靠**阳性对照**（同一正则测已知含 default 的字符串 ⇒ true ✓）才分清"文件坏了"与"正则坏了" | `node -e "console.log(require('fs').readFileSync('.tmp/oldpdf.js')[0])"` ⇒ `255` | AGENTS.md 已记着同族坑（`Get-Content`+`Set-Content` 走 CP1252 ✓）✓ 这次是**重定向写 UTF-16LE** 的新变体 ⇒ 补进本机陷阱表：**跨工具取文本一律用 `node -e` 直读真文件 ✓ 不要用 `>` 落地后再读 ✓** |
| ~~D33~~ | 交付过一段时间的**单文件页带着 `script-src 'self'` 却内联了 `<script>`** ⇒ 按规范浏览器会拒绝执行自己页面的内联脚本（[GH issue](https://github.com/mshirel/song-history/issues/247) ✓ [SO](https://stackoverflow.com/questions/76347766/content-security-policy-csp-blocking-my-local-script) ✓）✓ 而 `file://` 下 `<meta>` CSP 是否强制执行**本机无浏览器无法验证**（D18 同族 ✓）⇒ 我不声称"它一直是坏的" ✗ 只说：**它把可用性押在一个我在这里验不了的问题上** | `Select-String web\dist\pskt-file.html -Pattern "Content-Security"`（第 31 轮产物：`script-src 'self';` ✓ 同文件里有内联 `<script>` ✓） | 已改为**不依赖那个答案**：两个单文件页的 CSP 都加 `'unsafe-inline'` ✓ 并加构建断言"内联脚本若不被本页 CSP 允许 ⇒ 拒绝出产物"✓ 未选 CSP hash：文件被任何一次重新保存（哪怕只改行尾）就会静默失效 ⇒ **一个下载后不启动的工具比允许自身代码的工具更糟** ✓ 真浏览器里仍需一次人工确认 ✓ 归 D18 |
| ~~D34~~ | `build-web.mjs` 的 `bundle(entry)` 把**自动运行守卫写死成接收端的 id `"files"`** ⇒ 我造第二个 bundle（发送端）时它会在错误的页面上启动错误的入口 ✓ 属于"一个产物能跑只是因为还没有第二个"的潜在缺陷 | `git show HEAD:tools/build-web.mjs` 里 `document.getElementById("files")` 与 `__R("web/app.js")` 均为字面量 | 已参数化 `bundle(entry, autoRunGuardId)` ✓ 接收端 `('web/app.js','files')` ✓ 发送端 `('web/sender.js','sfile')` ✓（`sfile` 这个 id 在 `send.html:16` ✓ 读过的 ✓ 不是猜的 ✓） |

### 第 31 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D24~~ | 手机端"角标分辨率地板"（150dpi 等效 24 个几何候选全灭在 `no-hollow-corner` ✓ 当时据此以为手机必须靠近） | **由第 30 轮的 D26 修复顺带闭掉 ✓ 同一条命令、同一夹具重测**：`node tools/probe-curl-tolerance.mjs --down 2 --rot 0 --bend 0,4,12,24` ⇒ `CONTROL ... decode P-M1-300@300/INK2` ✓ `bend 0px DECODED 符号一致 68904/68904 = 100.00%` ✓ ⇒ **地板不存在** ✓ 那是那 1 个像素的取整 bug ✓ 本行原写的"像素预算"判断（第 28 轮已撤回 ✗）现在彻底没有残余 | CLOSED |
| ~~D4~~ | `index.html` 里没有指向 `send.html` 的入口 ⇒ 接收端用户点不到发送端 | `web/index.html` 加 `<p class="nav"><a href="./send.html">`（链接文字明说"单文件版需从站点打开才有这一页"✓）✓ `node tools/build-web.mjs && node tools/check-dist.mjs` ⇒ **9/9 PASS**（含"每条 markup 引用都落在产物里"✓ 与"单文件版除 `data:` 外不引用任何东西"✓）✓ 实测：`web/dist/pskt-file.html` 里 `send.html` 出现 **0 次** ✓ `web/dist/index.html` 里导航 **1 条** ✓ | CLOSED |
| ~~D14~~ | `send.html` 的"纸张 A4/Letter"下拉框是惰性的 ⇒ UI 说了谎 | **删控件、不接线**：`<select id="ssheet">` 换成只读 `<span id="ssheetinfo">` + 标签写"纸张（由剖面决定）· 编好后显示在下方日志" ✓ 真值本来就在日志里（`sender.js:260` 打印 `纸 W×Hmm` ✓ 取自 `t.geom.sheetMm` ✓ **没有新造数字** ✓）✓ `check-dist` 的 DOM-id 契约断言（48→仍全绿 ✓）证明没有 JS 再去抓那个被删掉的 id | CLOSED（"改成能用的纸张选择器"属于新能力 ⇒ 若要做需连编码器一起改 ✓ 不在本轮范围 ✓） |

### 第 31 轮新增（OPEN）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| ~~D30~~ | 我给 `send.html` 加"回链到接收端"时**没有先看那页已有没有** ⇒ 那里本来就有 `<nav class="tabs"><a href="./index.html">→ 接收端（扫描/解码）</a></nav>` ✓ 我加出了**第二条重复回链** ✗ 由 `check-dist` 的引用计数目视复核抓获（不是我推理出来的 ✓ 是打印产物内容看到的 ✓）⇒ 撤掉我加的那条 ✓ 复验：站点 `send.html` 里 `href="./index.html"` 恰好 **1 条** | `Select-String web\dist\send.html -Pattern "href=.\./index\.html" \| Measure-Object` | 教训与 D4/D5 同源：**改 UI 前先读那页现有的东西** ✓ 本轮 index.html 也犯过一次同类（我把 `<p class="sub">` 那句"不联网、不上传、不需要 URL"**整段替换成了导航链接** ✓ 差点删掉项目最重要的那句承诺 ✗ 立刻补回 ✓）⇒ 两处都属"用 edit 时 old_string 圈大了" ✓ 圈定应只圈要改的那个元素 ✓ |
| ~~D31~~ | 我在 `tools/build-web.mjs` 加的单文件剥离规则是 `/\s*<p class="nav">[\s\S]*?<\/p>/` ✓ 它**按 class 名**匹配 ⇒ 若将来别处也出现 `p.nav`、或站点版那条链接被误删 ✓ 现有判据**全都不会报**（它们只验"剩下的引用都能落到产物上"✓ 从不验"该在的引用还在"）✗ | 补了配对断言后：`node tools/check-dist.mjs` ⇒ 新增一条 `the served index.html keeps its link to the sender` ✓ 它同时断言**站点版必须有、单文件版必须没有** ✓ 去掉任一侧都会红 | CLOSED（同轮补断言 ✓ 没推到下轮：**"一行的事留给下轮"是这个台账里最常见的自欺 ✓**） |

### 第 30 轮闭掉的

| # | 缺陷 | 复验 | 状态 |
|---|---|---|---|
| ~~D26~~ | 角标检测对尺度**不单调**（105/120dpi 能找到四角 ✓ 150dpi 找不到 ✓） | 根因：`hasHole` 用 `round(comp.cx)` 取点 ✓ 而 `components()` 的 `cx = (x0+x1+1)/2` ⇒ 奇数边长时与"向下取整的 bbox 中心"**正好差 1 px** ✓ 15px 角标 + 半径 2 的探针 ⇒ 这 1px 把窗口从孔里推进环墨（**实测 0.36 vs 0.00 ✓ 判据 0.35** ✓）⇒ 旧行为的"随机"其实是**角标奇偶性决定边界落在哪边** ✓ 改为 `floor((x0+x1)/2)` ✓ 复验：`node tools/probe-marker-scale.mjs` ⇒ **300/210/150/120/105/90/75 dpi 全部 FOUND** ✓ `exit=0` ✓ 单测 **233/233**（含"90° 旋转页仍能解出 ✓ 朝向来自空心角标"✓）✓ `node cli/pskit.mjs verify --gate all --seeds 2` ⇒ **`ALL GATES PASS`** ✓ | CLOSED（**不是放松判据** ✓ 实心角标在新取样点处处仍读 1.00 ✓ 只是取样点错了一个像素 ✓） |

### 第 30 轮新增（OPEN）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D28 | **后台验证与我的编辑赛跑**：第一次编辑后启动"gates + build + check-dist + 两条冒烟" ✓ 随后又改了同一个 `core/` 文件（重写注释时 `old_string` 只圈注释块 ✓ 而 `new_string` 又带了一遍 `const cx/cy` ⇒ **重复声明** ✗）✓ 于是同一次运行里**门限跑在好文件上（PASS ✓）而 check-dist 与两条冒烟跑在坏文件上（三条红 ✗）** ⇒ 一半结论作废 ✓ 且差点让我误判"修法错了" | `Select-String .tmp\cd30.txt -Pattern FAIL` ⇒ `Identifier 'cx' has already been declared` | **流程缺陷**：改 `core/` 后启动的后台验证在跑完前**不得再改 `core/`** ✓ 本轮起改为"文档先写完 → 再跑全套 → 最后提交" ✓ 副产品：语法错只在 Node 侧暴露 ⇒ **`check-dist` 那两条执行型判据确实抓住了纯 grep 抓不到的东西** ✓ |
| D29 | 我的 `--explain` 把 `round(comp.cx)` 那一路**标成"质心"** ✓ 而 `cx` 其实是 bbox 中心 ⇒ 这个我自己起的名字生成了一个**假根因**（"质心被环墨拉偏" ✓ 还被我写进代码注释 ✗）✓ 靠真去读 `fiducial.js:150` 才拆穿 | `core/decode/fiducial.js` L150-151 | **第 14 次"引用未证实的东西"** ✓ 且这次是**给别人的字段起名**（比猜字段名更隐蔽 ✓）⇒ 探针输出里每个标签都必须来自被读过的代码 ✓ |

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
| ~~D26~~ | **角标检测对尺度不单调**：同一张干净降采样的页（无模糊、无噪声、无 JPEG），**105dpi 与 120dpi 能找到四角 ✓ 150dpi 却找不到** ✓ 90dpi 又失败 ✓ 即"越清晰越认不出"的反复翻转 ✓ 三次翻转 | `node tools/probe-marker-scale.mjs` ⇒ `exit=2` + `NON-MONOTONIC` 三行翻转记录 | **这才是手机端真正的地板问题**（不是我上一轮说的"像素预算"✗ 已撤回 ✓）✓ 失败形态统一是 `hollow=0` 而候选很多（150dpi 时 cand=10 ✓）⇒ 像二值化阈值阶梯/候选选择与该尺度的相互作用 ✓ 定位它才能给出"该靠近还是该重拍"的分类 ✓ |

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
| ~~D24~~ | **角标是手机端的分辨率地板，而 reason 会说谎**：同一页降到 1/4 面积（2260×3290 → 1130×1645 ✓ 等效 150dpi ✓ 仍是清晰降采样、无模糊噪声）⇒ **24 个几何候选全部死在 `stage:markers / reason:no-hollow-corner`** ✓ 根本没走到读出。也就是说 `rectifyPage(bitmap, layout, found.quad)` 在原理上是跨尺度的（把实测四角映到 layout 画布 ✓ 我上一轮"几何搜索不跨尺度"的说法**说过头了，撤回 ✗**）✓ 真正卡住手机的是**第四空心角在低分辨率下测不出来** | `node tools/probe-marker-scale.mjs` ⇒ 见 D26 ✓（本行原写的"角标像素预算地板"**已撤回** ✓ 该探针证明失败与尺度非单调 ✓） | 原判断"手机端卡在角标像素预算"**不成立** ✓ 剩下的真问题是 D26 的非单调 + `no-hollow-corner` 语义过载（`ACCEPTANCE.md` 开放缺陷 #3 ✓ 本轮又一次把我引偏 ✓）⇒ 拆 reason 阻塞在 D26 定位 ✓ |
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
| ~~D13~~ | PWA 图标是一张 2260×3290 的**非方形**页图；`sizes` 走的是 `${w}x${h}` 分支，iOS 对非方形/`any` 支持差 ⇒ 主屏图标可能被忽略 | `node tools/build-web.mjs` 打印 `icon 211384 B (2260x3290)` | 需要在构建期裁成方形（自家编码器可重画 ✓ 不引依赖） |
| ~~D14~~ | `send.html` 上"纸张 A4/Letter"下拉框**是惰性的**：纸面尺寸实际来自 `t.geom.sheetMm`（编码器决定 ✓ 与 CLI 一致），改这个框不影响输出 | 切 A4→Letter 再编码，看日志里 `纸 W×Hmm` 不变 | UI 说了谎：应删除该控件或改为"仅提示" |
| ~~D15~~ | `sender.js` 里 `parityPages` 用 `header.kind === 'parity'` 判校验页数，`kind` 的**取值域我未证实**（不影响产物 ✓ 只影响那一句计数） | `node -e` 打印 `t.pages[0].header` | 又一个"未证实字段"实例（第 9 次 ✓ 模式未断根） |
| ~~D16~~ | `docs/ACCEPTANCE.md` 的 G9 行仍是旧结论（写"未开始"），本轮 G9 已 8/8 ✓ 台账与判据页不一致 | `Select-String docs/ACCEPTANCE.md -Pattern G9` | 记账欠账，下一轮第一件事（连同 STATUS 现况表 G9 行一起改） |

## 判读提示（避免误读别人的结论）

- `pwsh` 里用 `... | Select-Object -First N` 截断 node 的输出流会让 node 被杀 ⇒ **进程退出码 1**，而门限本身可能全绿。要判绿黑请看**末行**（`ALL GATES PASS`）或不要用 `-First`。本轮我差点把这条当成一次门限失败记进台账 ✓
