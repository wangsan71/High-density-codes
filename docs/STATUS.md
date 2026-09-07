# STATUS · PSKT 里程碑台账（跨轮续跑入口）

> **续跑规则**：新轮次先读本文件 → 找到第一个未完成里程碑 → 跑它的前置门限确认未回归 → 开工 → 跑门限 → 更新本表 + git tag。
> 门限跑法：`node cli/pskit.mjs verify --gate <G0|G1|G7|all>`；单元：
> `node --test --test-isolation=none "tests/unit/**/*.test.mjs"`
> （沙箱禁止带管道 stdio 的子进程，缺 `--test-isolation=none` 会 `spawn EPERM`；目录参数会 `ERR_UNSUPPORTED_DIR_IMPORT`。）

## 里程碑

| ID | 内容 | 门限 | 状态 | 实测（最后一次） | tag |
|---|---|---|---|---|---|
| M0 | 骨架 / git / ESM 约定 / CLI 壳 | — | **完成** | 仓库+package.json+docs 就位 | — |
| M1 | 编码核心 gf256/rs/hash/chacha20/crc/pack/deflate/frame/profiles/nozzles/protocol | G0 | **完成** | 105/105 单元绿 | `M1` |
| M2 | 版面渲染 + PNG/TIFF（读写）+ 回显带 + CLI send/receive | G1 | **完成** | 136/136；G1 7档×6次 0 误读；磁盘文件→PNG→文件 sha256 相同 | `M2` |
| M3 | 解码全链路（标记检测→单应→透视矫正→读格） | G1,G2 | **完成（合成图像层）**；真实相机照片待 M4 信道 | 156/156；`warp.test.mjs` 6/6：倾斜+模糊+噪声照片角标误差 <2.5px、90° 旋转页靠空心角纠正、空白/乱码图干净拒绝、PL-G@0.8 79 页照片往返复原 | — |
| M4 | Python 仿真信道 + verify 套件 | G2,G3,G4,G5 | **进行中**：解码入口/advice/G3/G5/交叉校验向量已完成；`sim/channel.py`+`selfcheck.py` 与 `ref/decode.py` 由子代理在写 | `--gate G3` `--gate G5` 绿；`conformance.test.mjs` 11 例活断言 | — |
| M5 | STL + 3MF 双色产物 | G8 | 未开始 | — | — |
| M6 | 双色优先·单色兜底 | G7 | **完成（图像层）** | `--gate G7`：PL-D2@0.2/0.4 单色渲染判死色道 → 完整复原；PL-D3(off) 干净拒绝 | — |
| M7 | 喷嘴矩阵 + PL-G + calibrate | G10 | 未开始 | ρ 自标定已在理想层跑通；喷嘴地板已改为 EW 量化（见决策 6） | — |
| M8 | Web 扫描端 PWA + Pages | G9 | 未开始 | — | — |
| M9 | soak/性能/文档 | G6 + 复跑全部 | 未开始 | — | — |
| M10 | 可选 `REL` 光影档 / `P-C4` 纸面4色 | — | 未开始 | — | — |

## 门限状态

| Gate | 判据摘要 | 状态 |
|---|---|---|
| G0 | RS/ChaCha20/SHA/CRC/帧/压缩 单元+属性全绿 | **通过**（174 例；GF(2⁸) 全域穷举、RS (t,e) 穷举 200/200、ChaCha20/SHA-256/PBKDF2 对拍 node:crypto 与 RFC 向量、deflate 双向对拍 node:zlib；本环新增 advice 映射覆盖 3 例、conformance 活复算 11 例、PDF 多页 4 例） |
| G1 | 理想往返 0 符号错 | **图像层通过**：`verify --gate G1` 7 档 × 3 次 = 725,913 格 0 误读（含 600dpi 纸面 620,136 格），全部还原；STL 往返部分待 M5 |
| G2 | 纸面 300/600dpi 200 seed 100% | **仍未通过，但结论变了：不是信道鲁棒性问题，是几何读出路在纸面上从未能用**。对照实验（同一页、过信道 vs 没过信道）两边**都**报 `markers/no-hollow-corner`——连**从没被打印/扫描过的原始渲染**都读不出 ✓✓ 此前 G1 的"269 万格"与"字节穿越照片"分别走快路和板材档，纸面 + 几何路**一次都没被门限覆盖过**（决策 10 要求"干净画布才允许走快路"，但没要求任何门限真的走慢路 ⇒ 门限表的空洞）。已排除的假设（都带实测数据）：① Otsu/二值化正常（阈值 141 vs 最大 248、判墨 10% ≫ 32）；② inkness 横轴被离群值拉伸（换成 p99/p99.9/p99.99 定标阈值一模一样）；③ 布局没问题（四角标都在画布内，`br` 中心实测 0.00 墨=真空心，另三个 1.00=实）；④ `keepCandidateSquares` 没筛掉它们（四个 30×30 全保留，`br` fill=0.89）；⑤ 簇没被网格抢走（全图只有两个簇：`30:4`=正是四个角标、`5:27213` ⇒ **角标簇确实被选中**）。**剩下的唯一分歧点**：`hasHole` 在 `buildQuad` 里对这同一批候选返回假，而我在外面用同一段代码、同一份掩码复现返回真 ⇒ 分歧只能在传进去的 `bin`（`page = {...bin, mask: cropMask(...)}` 的裁剪坐标/步长）上。下一轮**第一件事**就是量 `cropMask` 后的 `width` 与分量 `cx/cy` 是否同一坐标系。附带已改进：`findMarkers` 不再返回"最后一次重试"（旧代码把 2.1× 阈值算出 296 > 最大值 248 ⇒ 墨点 0 ⇒ 用 `blank-image` 覆盖真实原因，让用户去重拍其实没问题的照片，违反决策 11），改为跳过会饿死的尝试 + 返回**走得最远**的那次；`tools/diag-page.mjs` 落地（直方图/阈值/`--markers` 角标解剖）。192/192 绿。 |
| G2-第7轮 | 同上（**取代上一行的判定**） | **第一层根因找到并已修复**：`cropMask` 的内缩按页尺寸算（`0.008×min(w,h)` ⇒ 300 dpi 纸面 18 px、600 dpi 36 px），而角标包围盒离纸边只有 **10 px**（心在 `fidHalf+cellPx=25`、bbox 从 10 px 起）⇒ 角标外圈被抹平 ⇒ 环的洞与外界连通 ⇒ **零个**空心候选 ⇒ 每一页都判 `no-hollow-corner`。该带宽本意只是"重采样后残留两三像素暗边"，封顶为 2–4 px 才名副其实。**修完的硬证据**：原始纸面页经真实几何路（不给尺寸、不给 dpi）读出 `received 204800 bytes`，与发送文件 **`IDENTICAL=true`** 且 SHA-256 与 manifest 一致 ✓✓ 此能力此前根本不存在。**下一道关卡已定界**（因子消融）：关 `geometry` ⇒ 三页全越过角标、失败点后移到 `echo-bad-magic`/`intra-fail`；关 `illumination` 或 `jpeg` ⇒ 仍 `no-hollow-corner` ⇒ 凶手是**旋转重采样**糊掉角标中心，不是反光也不是压缩。G2 记**未通过**，但性质已从"几何路整条是死的"变成"旋转下空心判据不稳"。仪器：`tools/diag-page.mjs`（直方图/阈值/`--markers` 解剖）。 |
| 决策 11 落实 | 每个 reason 必须有 advice | 此前只是约定、无人强制 ⇒ 实测 **11 条** reason 无 advice：`intra-fail`/`bad-magic`/`header-crc`/`short-header`/`other-session`（来自 frame/protocol，CLI 当场印 `unmapped failure (assemble: intra-fail)` 并叫用户重拍其实没问题的整批），我第一轮只扫 5 个文件、又漏了 6 条 `short`/`long`/`erasure-oob`/`too-many-erasures`/`beyond-limit`/`chien` ⇒ 改成**扫整个 `core/`** 的 `tests/unit/advice-coverage.test.mjs`，并给测试自身加反退化断言（匹配到的 reason 数 <20 直接判失败，防"什么都没匹配上"的假绿）。**反向检查故意不做**（有 advice 却没发射点）：`echo-*` 是 `'echo-' + reason` 动态拼的，字面量扫描会造 5 条假红——这已是第三次踩"新守卫比被测代码更严"。 |
| G8 | 3MF/STL 独立解析 | **M5 地基落地**：`core/mesh/solids.js`(550) + `core/mesh/stl.js`(290) + 12 条测试全绿，`prismFromMask` 的最大矩形覆盖**逐像素等于掩码**且矩形互不重叠（手算 8/4/4 三个反例都判 false ⇒ 断言承重），STL 头无时间戳且两次编码逐字节相同，`watertightHint` 恒 false 不谎报水密。代理还实测纠正了我 `docs/MESH-CONTRACT.md` 的两处签名错误（`outer/inner/dot` 是**格宽比例**不是 EW 数；`glyphMaskForLevel(dx,dy,level,geo)`），已按真实行为改文档。剩余：3MF 路径、`--format stl|3mf` 接线、`ref/verify_model.py` 与投影对拍。 |
| G3 | 缺页/乱序/重复 ≤parity 100%，超出干净拒绝 | **协议层通过**（`verify --gate G3`，3 档 × 丢 0..parity 页 + 乱序喂入全部精确还原；丢 parity+1 → `result=null` 且不写文件；每页喂两次 → 计入 duplicate 且字节不变；异会话页 → `other-session` 拒绝）。图像层丢页（真的删掉 PNG 文件）待 `sim/channel.py` 落地后跑 |
| G4 | 手机压力档 ≥99% + 失败分类 | 未开始（信道在写）。失败分类侧已就绪：`core/decode/advice.js` 20 个成因→重拍指令 + 防腐测试 |
| G5 | 误接受实测 0（1 万次篡改全拒）+ 变异测试 | **通过**：`verify --gate G5 --trials 10000` → 9200 次被 ECC 纠正回原值、800 次拒绝（全部由明文 SHA-256 闸拦下）、**0 误接受**；7 种损坏模式混合（位翻、整格擦除、丢页、头 CRC 破、头字段伪造后重算 CRC、异会话整页替换、>40% 重损）。变异检验两项：① 试验组合必须真的触发帧 CRC/magic 闸（否则混合太弱）；② **摘要是承重的**——伪造页带正确 sessionId + 新鲜合法 CRC + 合法码字，所有结构闸全部放行，只有摘要拦住它；若删掉摘要检查仍出字节，这条就红（第一版此测试因"一页就装完全部数据"而假通过，已修成先短一页再塞伪造页） |
| G6 | 性能 + 30–60min soak 无泄漏 | 部分：SHA-256 269 MB/s、deflate 1.1MB/35ms、600dpi 整页 (4530×6590px) 渲染 192ms + 读回 430ms、PNG 617ms/TIFF 181ms、**单应矫正 362ms（2236×2236 画布）**、50 次连跑 heap Δ 0.0MiB |
| G7 | 色道塌陷下单色兜底 100% | **图像层通过**（单色渲染图被判 `colourAlive=false` → 整道擦除复原；`monoSafe:'off'` 档 → 拒绝而非猜） |
| G8 | 3MF/STL 被 Python 独立解析且水密/schema 正确 | 未开始（PNG/TIFF 已过 pillow 校验；PDF 编码器支持 N 页打包 `pack.pdf`，3 页板材包 548 KB/161ms） |
| G9 | Web 产物零外部 origin + 离线 + selftest | 未开始 |
| G10 | 喷嘴×参数×拍摄矩阵（PL-G 全 100%） | 未开始 |

**验收机制本身的自检**：`runUnitFiles` 带两道护栏——观察到的测试数为 0 判失败、"有结果的测试文件数 < 发现的文件数"判失败。这条是被真的踩出来的：`isolation:'none'` 下事件词表是 `test:pass/test:fail/test:complete`（叶子 `nesting` 恒为 0），早期计数器按旧词表数事件 → **空跑被报成 ALL GATES PASS**。已用故意失败的 canary 测试证明门限确会变红（`136 passed, 2 failed / GATE FAILURE`）。

## 决策（新增，勿回退）

1. **静区从单元格里扣**（`QUIET_CELLS=5`，`core/render/constants.js` 叶子模块）。之前只按点阵 fit 版面，页面实际超出板材。`constants.js` 必须独立成文件，否则 `profiles → render/layout → frame → profiles` 成环，`frame.PROFILE_CODES` 会踩 TDZ。
2. **ρ 阈值自标定**：`shapeThresholds(levels,{targets})` + `measureTargets(cellPx,levels,glyph)`。有限像素下小点积分出的 ρ 系统性偏低，解码端就用"渲染器自己画出来的实测值"当目标，不把偏置当余量吃掉。`pskit calibrate` 对真实扫描做同一件事。
3. **mono 不搬道**：单色渲染 = 色道信息**消失**（变成擦除），不是把色道位并进形状档位。
4. **色道存活判据只看"出现过几种墨"**（`distinct>1`）。宁可保守：浪费容量但绝不丢数据。
5. `monoSafe` 三档、明文摘要、分块塞满、`sessionId=sha256(明文)[0..8]`、`PL-D3='off'` 等 M1/M2 决策不变；旧条目里的容量数字一律以本文件下面的实测表为准。
6. **形状字母必须按整条挤出宽度 EW 量化**（`glyphGeometry(cellEw, shapeLevels)`，`core/render/glyphs.js`）。外环/内环/点半径全取整数 EW，并强制：每侧 ≥1 EW 净间隙、环厚 ≥1 EW、点—环间隙 ≥1 EW、最小可印点半径 ≥√(L−1) EW、L 个半径互不相同、且 ρ_hi ≤0.95（参考环必须仍是主反射体，否则 ρ>1 会被"这格是墨 blob"判据杀掉）。**结果：2 档形状 ≥8 EW/格，4 档 ≥~27 EW/格。**
   起因：1.8mm 节距 @0.4 喷嘴只有 ~4 EW/格，环间隙 ≈0.11mm，仿真里 **1px 模糊就把整张点阵桥接成一个 1664×2273 的连通域**，角标被吞、检测直接 `no-square-candidates`。这不是测试噪声，是原设计的物理错误。
   代价如实记录在容量表：`PL-D2@0.4` 1098→**220 B/页**（掉 5×）。纸面不受影响（一格 ≈ 数百打印点，走 `cellEw≥24` 的理想圆环分支）。`planPage` 会自动抬节距（`pitchRaisedFrom` 记下原值），抬完仍放不下就**点名拒绝**，绝不产出读不出来的版。
7. **回显带随格子变粗而变细，画布为它让位**：`echoPx` 从 cellPx/2 逐级试 /3 /4 …/12，下限是 1 EW；画布宽度取 `max(点阵, 回显带)` 并把点阵居中（粗喷嘴下 56 bit 头比点阵还宽），回显带左对齐到静区而不是跟着点阵走，否则会压到右侧角标。
8. **空心角标的环厚 = 1 数据格**（≥1 EW）。旧写法 `half/4` 在抬节距后只有 0.82 EW：印不出来，且 fill 掉到 0.42 与数据环同域，检测无法区分。现在环 1 格、孔 1 格，`fill≈0.89` 与实心块同档，靠 `hasHole`（探针半径 0.12 短边，必须落在孔内）区分。
9. **检测器的四条硬规则**（M8 网页端必须原样复用，别再发明一遍）：
   - 页面外接框只内缩 `0.8%`（上限 24px）：只为吃掉重采样在纸边留下的 ~2px 暗晕；缩多了会啃掉角标并让质心偏移，进而把整个单应带偏。
   - 候选过滤是**结构性**的：>8% 页面面积、或单边跨 35% 页面、或贴边且 >1% 的块一律不要（暗背景楔形与桥接网格都在这里被剔除）。角标小而居中。
   - 四边形枚举必须同时满足：4 条边同向凸（两两叉积会放过自交蝴蝶形——鞋带面积≈0 曾把正确的四角判成"框不住页面"）；**转向为正**（镜像的走法同样凸、同样满足"br 空心"，会把角色旋转 90°，所以镜像只能单独报 `mirrored-image` 提示"纸放反了"）；**空心判据进入枚举**而不是事后校验（矩形度对 4 种循环标注同分，事后校验会挑中一个实心在 br 的标注然后报 `hollow-corner-missing`）。
   - **底色取自矫正后画布静默区的亮部上四分位**（`quietZoneSubstrate`），绝不取照片边框：深色桌垫会让底色估成 (40,40,45)，于是纸被判成墨、整页反相，误读率 76%（≈三值字母整体平移一格的特征签名）。
   - 二值化带多阈值重试（Otsu ×1/×1.35/×1.7/×2.1）。干净图必须一次命中——`warp.test.mjs` 断言 `thresholdFactor===1`，把"依赖重试"变成可测的回归。
10. **只有一条解码路**：`core/decode/page.js:decodePage` 是"图像→页数据"的唯一入口（角标检测→单应→回显带头→读格）。CLI 现在调它，M8 网页端必须调同一份，不允许出现"CLI 一套、浏览器一套"的两条读出路——那样门限测的已经不是交付的东西了。干净画布（尺寸+dpi 都对得上）才允许走快路省掉重采样，**且快路读不出来时必须退回几何路**：一张恰好同尺寸的扫描不是画布。
11. **每个失败原因都必须有对用户的说法**：`core/decode/advice.js` 把 reason 映射到"物理成因 + 重拍指令"（G4 判据）。映射表会被遗忘，所以 `tests/unit/advice.test.mjs` 直接扫 `core/decode/*.js` 源码里的 `reason:` 字面量——新增一个没映射的原因就红（已用注入 `zz-not-mapped` 证实它真的会红）。没映射的原因仍要给出通用指令，并且**自称未映射**，不许借用别人的成因。
12. **交叉校验的独立性靠"看不到"来保证**：`tests/conformance.json`（78 条向量，196 KB，发射器带 400 KB 预算闸）是答案卷；`ref/decode.py` 的编写纪律是**禁止阅读 `core/*.js`**，只准依据 JSON 里的 `meta`（GF(2⁸) 参数、CRC 参数、位序、交织规则、56 字节头表、KDF、容器格式）独立实现。规则写进 `meta` 而不是靠读码，是这套对拍有意义的前提；信息不足时必须报 `SPEC GAP` 而不是猜。同时 `tests/unit/conformance.test.mjs` 在 JS 侧**逐类复算**每条向量（含"重新发射必须逐字节相同"），所以这道对拍不会静默腐烂，也不依赖 Python 是否在跑。

13. **给了口令就是要求加密**：`encodeTransfer(x, {passphrase})` 不必再补 `cipher:true`；`passphrase` 本身就是加密请求，页头必须置 `CIPHER`。旧语义要求两个旗标同时出现，漏一个就**静默印明文**——CLI 恰好两个都传所以躲过了，是我的 conformance 发射器（只传口令）踩中的，而独立解码器报"页上没有任何东西告诉我要解密"才把它照出来。反向纪律：接收方看到 `CIPHER` 却没拿到口令时，只能 `needPassphrase` 问用户，绝不吐字节。

14. **对拍的独立性在"协议逻辑"，不在重造 FIPS 原语**：`ref/decode.py` 的 GF(2⁸)/RS、交织置换、色道打包、PSZ1 容器、56 字节头——这些必须只看 `meta` 自己写，才算另一个实现；SHA-256/CRC-32/PBKDF2 改用 hashlib/zlib 反而**更强**：我的 `core/hash.js`、`core/crc.js` 在 G0 已各自钉在 node:crypto/node:zlib 上，参考端再自搓一份只会把"两个都错得一样"的风险换成"参考端自己有 bug"（本轮实测就是：它自写的 SHA-256 消息根本没进压缩函数，空串摘要都对不上）。ChaCha20 保留它自己那份（stdlib 没有，且它 8/8 全过——这是真独立的证据）。换原语的理由与证据写在 `ref/decode.py:sha256_bytes` 的 docstring 里，不留"看起来像偷懒"的空白。

15. **规格必须能被"只看它的人"读对，形容词不算说清**：本轮两条实证。① `meta.cellPacking` 写着"主通道占高位、次通道占低位，逐字节 MSB-first"——一个认真按它实现的解码器仍然把**次通道读成了主通道**（每个通道都用 `bitsPerCell - 本通道宽度` 算 shift），症状是"content 全对、parity 全错"；现在 meta 里多了一组可验算的数字（PL-D2@0.4：`content[0]=0xB4, parity[0]=0x1D → levels[0..7]=2,0,2,3,1,3,0,1`）与 `shift = bitsPerCell - 前面通道位数之和` 这一条式子。② 头字段 `payload length` 只写这四个字，参考实现按"文件明文大小"理解，于是要么解错长度要么判定溢出——真实语义是**压缩/加密之后、且含最后一页分块填充**的长度（有意义字节数 = payloadLen − blockPad，装配区长度 = dataPages×D），已连式子一起写进 `meta.headerLayout` 那一行。判据很简单：**M8 网页端也将只依据这份文字实现**，它能读对才算写清了；任何"实现者读错"都先当作规格的失败，而不是对方的错。

## 容量实测表（`node cli/pskit.mjs status` 复算，勿手改）

| 档 | 喷嘴 | 节距 mm | 网格 | 净字节/页 | 码率 |
|---|---|---|---|---|---|
| P-M1-300 | — | 0.847 | 216×319 | 7514 | 0.874 |
| P-M1-600 | — | 0.423 | 443×649 | 31302 | 0.874 |
| P-M2-600 | — | 0.423 | 443×649 | 62604 | 0.874 |
| P-C4-600 | — | 0.423 | 443×649 | 35658 | 0.5 (full) |
| PL-D3 | 0.2 | 2.08 | 80×80 | 2090 | 0.875 (off) |
| PL-D3 | 0.4 | 3.60 | 42×42 | 576 | 0.873 (off) |
| PL-D2 | 0.2 | 2.08 | 80×80 | 798 | 0.5 (full) |
| PL-D2 | 0.4 | 3.60 | 42×42 | 220 | 0.5 (full) |
| PL-D2 | 0.8 | 7.60 | 14×14 | 24 | 0.5 (full) |
| PL-M1 | 0.2 | 2.08 | 80×80 | 696 | 0.874 |
| PL-M1 | 0.4 | 3.60 | 42×42 | 192 | 0.873 |
| PL-D3S | 0.2 | 6.24 | 20×20 | 100 | 0.667 (partial) |
| PL-D3S | 0.4 | 10.8 | 7×7 | 12 | 0.667 (partial) |
| PL-D3S | 0.6 / 0.8 | — | — | — | **拒绝**（4 档形状放不下，见决策 6） |
| PL-G | 0.4 | 3.60 | 42×42 | 110 | 0.5 |
| PL-G | 0.8 | 7.60 | 14×14 | 12 | 0.5 |

结论性事实，必须如实对用户讲：**FDM 板材不是高密度通道**。200mm 方版在 0.4 喷嘴上，双色 `PL-D2` 只有 ~220 B/页、四色 `PL-D3` ~576 B/页；传 1MB 要 4~5 张版且不允许任何色道塌陷。要密度就走**纸面**（600dpi 单色 31KB/页、四色 36KB/页，1MB 载荷 37~41 页）。板材的价值在于"没有纸和打印机也能做 + 双面/耐磨/可夹在零件里"，不是带宽。

1MB 载荷纸面页数：600dpi 单色 **34+7=41 页**；600dpi 四色 **30+7=37 页**。板材超 255 页会被拒（页间 RS 上限）。

## 已知风险 / 待办

- **真实相机/扫描仪照片尚未验证**（M3 只到合成照片）。仿真里 1px 模糊就能桥接点阵 → 真实光学 MTF 更差，`PL-G` 之外的粗档可能不够。M4 信道 `sim/channel.py`（子代理在写，含 scan300/scan600/phone40/phone-hard/plate-matte/plate-glossy/identity 预设）落地后立刻把 G2/G3/G4 打在真实退化上；若 `PL-G` 也撑不住，就再抬 EW 地板（数字会变，结论不变）。
- **`--gate G4` 依赖照片路解码的吞吐**：单页矫正 ~360-460ms，500 seed × 7 档 = 数十分钟。要么并行，要么在门限里降采样（`warp.test.mjs` 那组 68s 同理）。
- `pskit receive` 只吃 PNG；TIFF 读回会点名跳过（不静默丢文件）。PDF 输出已接（`--format pdf|all`，超出 380 MB 组装预算时明确拒绝并让用户改打 PNG）。
- 合成照片里"字节穿越照片"那组测试要 68s（3 档 × 多页 × 全分辨率矫正）。M9 soak 前需要降采样或减少页数，否则门限跑不动。
- `densityReport` 对单通道档的 `monoSafe` 标 `n/a`（语义正确但易被读成"没保护"）。
- **交叉校验：绿了**（PLAN §9 闭合）。`python ref/decode.py` → `conformance.json: PASS with 4 spec gap(s)`，309 项检查两套独立实现全数一致，19 组里 18 组 `n/n`。本轮消掉的两类根因与"谁错了"的判定过程记在 `ref/README.md` 的表里（擦除定位子形式 → `rs-erase 4/4`；页间装配被转置 → `transfer 51/51`+`transfer-loss 3/3`）。剩 4 个 `geometry-*` SPEC GAP 是**有意接受**的：那需要把决策 6 的 EW 量化搜索整段搬进规格，代价高且易与实现脱节，板材几何的端到端证据归 G8/G10，不许拿它代替。`ref/README.md` 已写（那个崩溃的子代理从没写它）。**G2/G4 从此可以引用"另一个实现也同意"这一半证据了**——但这两个门限本身仍待接信道（下一条）。
- `sim/channel.py` **已交付可用**（README 23 KB + `--preset identity|scan300|scan600|phone40|phone-hard|plate-matte|plate-glossy`，输出同名 PNG + 原样复制 manifest，`pskit receive` 可直接吃 ✓ 一条 `--report` JSON 把每个物理量都记下来了 ✓）。G2/G4 现在缺的不是信道而是**我自己的几何路能用**（见 G2 行）。`selfcheck.py` 65 KB 待压成 ≤2 min 冒烟 + `--full` 可选。
- M5（STL/3MF）**两次委托都失败**：子代理各烧完一个上下文窗口后 `core/mesh/` 里一个字节都没有。下一轮拆成"先写文件再解释"的小块自己做，或按单文件分别委托。

## 变更日志

- M1：编码核心完成，105 单元全绿；修 RS 擦除定位子、BM 的 m 计数、deflate LZ77 重叠拷贝、native 档校验字节重复计入、填充字节混入摘要；新增 `monoSafe` 三档与分块塞满；`tools/fix-mojibake.mjs`。
- **M2**：渲染层完成——`core/render/{units,glyphs,layout,raster}.js` + `core/palette.js` + `core/decode/{ideal,echo,png-read}.js` + `core/render/{png,tiff}.js`（pillow+node:zlib 双向验证）+ `cli/pskit.mjs`（send/receive/status/verify/roundtrip）。G1 图像层 269 万格 0 误读；G7 通过；磁盘文件→PNG→文件 sha256 相同。修：静区计入版面、ρ 阈值自标定、mono 搬道、色道存活判据反了、门限空跑护栏。测试 105→136。
- **M3**：解码链路完成到"合成照片可往返"。新增 `core/decode/{transform,fiducial,warp}.js`（4 点 DLT 单应 + 残差自校验 + 双线性格心采样；连通域角标检测 + 页面定位 + 结构过滤；矫正到规范画布后直接复用 `readPageIdeal`/`readEcho`）、`core/render/pdf.js`（DeviceRGB + FlateDecode Predictor 15，字节确定性，`%%EOF` 结尾）、`tests/unit/{transform,warp}.test.mjs`。测试 136→156，全绿；门限 `all --seeds 3` 全通过。**本轮最大的东西不是代码而是决策 6**：形状字母按 EW 量化，板材容量掉 5×（1098→220 B/页），纸面不变；同时把检测器的四条硬规则钉死（决策 9），每条都对应一个已复现的假成功路径。
- **M4（上半）**：解码收口成一条路 + 两个门限 + 交叉校验答案卷。新增 `core/decode/page.js`（`decodePage`：角标→单应→回显头→读格唯一入口；干净画布才走快路，快路读不出来必须退回几何路）、`core/decode/advice.js`（20 个 reason → 物理成因 + 重拍指令）、`tools/emit-conformance.mjs` + `tests/conformance.json`（78 向量/196 KB/400 KB 预算闸）+ `tests/unit/conformance.test.mjs`（11 例**活复算**：CRC/SHA/deflate/ChaCha20/PBKDF2/RS/交织/头/页解包/页解码/版面几何，外加"重新发射逐字节相同"）、`tests/unit/{advice,render-glyphs}.test.mjs`。CLI `receive` 现在能吃照片：逐图分类失败而不是第一张坏图就整体中止、统计重复页、**原子写**（`out.part`→rename；摘要不符删文件并 exit 1）。门限：`G3` 协议层（丢 0..parity 全复原、丢 parity+1 干净拒绝且不写文件、每页喂两次仅计重复、异会话页拒绝）、`G5` 正式 **10000 次篡改 0 误接受**（800 次由明文摘要拦下）+ 两项变异检验。`core/render/pdf.js` 支持 N 页 `pack.pdf`（单页输出保持逐字节不变），`send --format` 改列表并有拼写护栏。
  本轮修掉三个"自己骗自己"：**①** G5 的摘要承重测试第一版是假通过——PL-M1@0.4 一页就装下全部数据，伪造页根本没参与判定；改成先短一页再塞伪造页后，`feed: accept` 但结果为空，摘要才被证明是最后一道闸。**②** 交织：`unpackLevels` 要的是**去交织后**的 levels，直接喂印刷顺序会得到"看着合法的垃圾页"，page-decode 三条向量因此全 fail。**③** `rsEncode(data,nsym)` 返回完整码字而非校验字节，我自己把 data 拼了两遍——`tools/inspect-conformance.mjs` 复算时才撞出来。另外 `neededCellEw` 原来是解析式估算（10 EW，实际 8 就够，会让人白印粗一档），改为复用渲染器同一条量化搜索、且搜索域用半 EW 步长（真实 cellEw 几乎都是分数：10.4 能排 4 级字母，10 和 11 都不能）；`cellEw` 对纸面从 `Infinity` 改成 `null`（`Infinity` 一进 JSON 就静默变 `null`，这就是它泄漏进答案卷的方式）。测试 156→179，全绿；`--gate all --seeds 3` 全通过，容量表数字未变。
- **M4（下半·交叉校验首跑）**：PLAN §9 的对拍真的接通了——`ref/decode.py`（1.5k 行，只依据答案卷 `meta` 独立实现，不读 `core/*.js`）现在跑完 78 条向量并打印 `301 checks / 58 FAIL / 7 SPEC GAP`。**它立刻咬出我这边四个真缺陷（均已修）**：**①** `encodeTransfer(x,{passphrase})` 少传 `cipher:true` 会**静默印明文**——答案卷里那条"加密"向量其实是明文，独立解码器的报法是"页面上没有任何东西告诉我要解密"（决策 13 + 回归测试；反向性质也钉住：看到 `CIPHER` 而无口令只能 `needPassphrase`，绝不吐字节）；**②** 我给 `meta.compression.container` 写的格式是**错的**（"u32be 原始长度"）——真实 `PSZ1` 是 10 字节头、offset 6 **小端** u32、offset 5 保留字节；我的 `core/deflate.js` 文档一直是对的，错的是答案卷，独立实现照答案卷读必然对不上；**③** 逐向量 `note` 让读者去 inflate 一个 method 0（stored）容器；**④** 我把 `headerCrc` 区间改成半开后，`decode.py` 仍按闭端切片 → 多哈希一字节且字段读错位（"改一端不改另一端"的区间约定是本轮我自己造的 bug）。`Report.check` 也顺手改成能识别"把真判据当 detail 传"的调用点（那种写法会永远记 pass）。答案卷重发射为 201 KB / 78 向量；测试 179→180。剩下 54 个 FAIL 是参考侧自己手搓原语的 bug，见"已知风险"。
- **M4（下半之二·把对拍修到只剩一处真分歧）**：`58 FAIL → 12 FAIL`。参考侧 RS 的**未知错误纠正**原本全灭，`ref/probe_rs.py` 逐步打出中间量后定位到一个纯取向问题：它的 PGZ 方程组解出的 Λ 系数是**倒序**的（`[1]+lam` 的根在 X_j 而不是教科书升序形式的 X_j⁻¹），Chien 搜索代 X_j⁻¹ 于是永远找不到根、直接落到"无解"分支——失败方向是安全的所以不会崩，看起来就像解码器能力不够，只有一直等到对拍才现形。修完 `rs-error 4/4`、`transfer 33→42/48`。原语按决策 14 换成 stdlib 第三方见证（`crc 11/11`、`sha256 25/25`、`pbkdf2 6/6`），它自己那份坏掉的 SHA-256 降级为 `_sha256_handrolled` 并把证据写在 docstring 里（所有输入的输出尾部四个字恒定 = 消息根本没进压缩函数；空串得 `8461857676cf5d0a…` 而非 `e3b0c442…`）。**顺带修掉我自己上一轮造的护栏**：`Report.check` 用"第二个参数是不是字符串"来区分 `(ok, detail)` 与 `(expected, actual)`，于是把两个字符串的正常比较误判成"真判据被当 detail 传了"，凭空报出 3 条 pbkdf2 假失败——判定改成看**第一个**参数的类型。教训：护栏本身也要有反例测试，否则它只是把假绿换成假红。新增 `ref/probe_rs.py`（RS 分解诊断，5 组断言，2 条 FAIL 即擦除路径的最小复现）。
- **M4（下半之三·对拍只剩一处行为分歧）**：`rs-erase` 从 0/4 到 4/4，根因是**擦除定位子的形式**——它用 `le = Π(1 + X_j z)`，而本协议的伴随式约定（`S_k = Σ Y_m X_m^k`，`X_m = α^(n-1-j)`）要求 `Π(1 + X_j⁻¹ z)`，否则修正伴随式 `M_k = Σ le_i S_{k+i}` 根本不会归零（直接验算：3 擦除 nsym=10 时前者给 `M=[42 e7 0d 3b…]`、后者全零 ✓）。M 不归零 → `nu=0` 的残差检验失败 → 每个"整页丢失"的案例都报无解；这正是 `transfer-loss` 全灭的原因（丢页是**擦除**不是错误）。`probe_rs.py` 6 条断言全过。次级通道位移 bug 见决策 15①：修完 `page-unpack 21/21`（**我的 JS 是对的**，它被 G1 的 269 万格真实渲染读回物理验证过）。另外我把上一轮自己重写严了的 `container_split` 收回一处错误判据——`len(body) < rawLength` 对 method 1 天然成立（rawLength 是**解压后**长度），照它判就把每个真实压缩容器都拒了 ✓ `deflate 10/10`。**本轮再次确认：新写的"更严格"检查必须有反例，否则它只是新的假红来源**（上一轮是 `Report.check`，这一轮是 container）。`python ref/decode.py` 现余 12 FAIL，全部集中在"干净页端到端重组从 offset 1 起差一字节"这一类；已逐行比对排除 intra 块排布差异（两边都是 `block b = content[b·k:(b+1)k] + parity[b·nsym:(b+1)nsym]` ✓）。JS 侧 180/180 不变。
- **M4（下半之四·§9 闭合）**：`python ref/decode.py` 首次 **PASS**（309 项检查全一致，4 个有意接受的 geometry GAP）。两处根因：① 上一轮的擦除修复带出 `transfer-loss`；② `transfer 43→51/51` 的关键是它的页间装配把"按列看页"的纠错视角用到了数据拼接上——**列优先 vs 页优先**的症状恰好是"byte0 相同、byte1 起不同"（两种顺序的第一个字节都是 page0[0] ✓），这个对应关系一旦对上就没有第二种解释。剩下 2 项 `header` KeyError 揭出一个我的答案卷缺陷：`fields` 里没给 `magic`/`version`，于是"重编码并比对字节"对独立实现**不可判定**——现在每个 `headerLayout` 点名的字段都在。**同时改掉了两处我自己的表述病**：`meta` 里两句话对 `payloadLen` 含哪种 padding 说法相反；`ecc.blockPad`（intra 块对齐）与头里的 `blockPad`（页填充）同名不同物 → 后者改名 `intraBlockPad` 并在 `meta.pages` 里把装配顺序、页序、两种 padding 全写成数据。参考侧另修一处"过期意见"：它对 method 0 无条件打印"note 叫你去 inflate"，而那句话我上轮已改——**对拍工具自己也要跟着答案卷更新，否则它会把已修的缺陷当成新发现反复上报**。新增 `ref/README.md`（独立性纪律、"PASS 不等于什么"、GAP 为何不闭合、以及那张"谁错了"的表）。JS 180/180、`--gate all` 全通过不变；`ref/probe_rs.py` 6 条断言全过。
