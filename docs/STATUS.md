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
| M2 | 版面渲染 + PNG/TIFF（读写）+ 回显带 + CLI send/receive | G1 | **完成**（最小 PDF 缺，见风险） | 136/136；G1 7档×6次 **269万格 0 误读**；磁盘文件→PNG→文件 sha256 相同 | `M2` |
| M3 | 解码全链路（真实图像：标记检测→单应→透视采样） | G1,G2 | **进行中** | `core/decode/transform.js` 完成（4 点 DLT + 残差自校验 + 逆矩阵 + 格心双线性，5 例绿）；`ideal.js` 理想采样器已有 | — |
| M4 | Python 仿真信道 + verify 套件 | G2,G3,G4,G5 | 未开始 | — | — |
| M5 | STL + 3MF 双色产物 | G8 | 未开始 | — | — |
| M6 | 双色优先·单色兜底 | G7 | **完成（图像层）** | `pskit verify --gate G7`：PL-D2@0.2/0.4 单色渲染 3/3 页判死色道 → 完整复原；PL-D3(off) 干净拒绝 | — |
| M7 | 喷嘴矩阵 + PL-G + calibrate | G10 | 未开始 | ρ 自标定已在理想层跑通（`measureTargets`） | — |
| M8 | Web 扫描端 PWA + Pages | G9 | 未开始 | — | — |
| M9 | soak/性能/文档 | G6 + 复跑全部 | 未开始 | — | — |
| M10 | 可选 `REL` 光影档 / `P-C4` 纸面4色 | — | 未开始 | — | — |

## 门限状态

| Gate | 判据摘要 | 状态 |
|---|---|---|
| G0 | RS/ChaCha20/SHA/CRC/帧/压缩 单元+属性全绿 | **通过**（136 例；GF(2⁸) 全域穷举、RS (t,e) 穷举 200/200、ChaCha20/SHA-256/PBKDF2 对拍 node:crypto 与 RFC 向量、deflate 双向对拍 node:zlib） |
| G1 | 理想往返 0 符号错 | **图像层通过**：`verify --gate G1` 7 档（PL-D2@0.2/0.4/0.8、PL-M1、PL-D3@0.2、PL-G@0.8、P-M1-300）× 6 次传输 = **2,691,948 格 0 误读**，全部还原；STL 往返部分待 M5 |
| G2 | 纸面 300/600dpi 200 seed 100% | 未开始（需 M4 仿真信道） |
| G3 | 缺页/乱序/重复 ≤parity 100%，超出干净拒绝 | 协议层通过；图像层待 M4 |
| G4 | 手机压力档 ≥99% + 失败分类 | 未开始 |
| G5 | 误接受实测 0（1 万次篡改全拒）+ 变异测试 | 协议层 mini 探针 300 轻损 + 40 重损，误接受 0；正式 1 万次待 M4 |
| G6 | 性能 + 30–60min soak 无泄漏 | 部分：SHA-256 285 MB/s、deflate 1.1MB/35ms、渲染+读回 600dpi 整页 (4530×6590px) 188ms+398ms、PNG 460ms/TIFF 127ms、50 次连跑 heap Δ 0.0MiB |
| G7 | 色道塌陷下单色兜底 100% | **图像层通过**（`--gate G7`：单色渲染图被判 `colourAlive=false` 后整道擦除 → 复原；`monoSafe:'off'` 档 → 拒绝而非猜） |
| G8 | 3MF/STL 被 Python 独立解析且水密/schema 正确 | 未开始（`ref/verify_raster.py` 已在，PNG/TIFF 已过 pillow 校验） |
| G9 | Web 产物零外部 origin + 离线 + selftest | 未开始 |
| G10 | 喷嘴×参数×拍摄矩阵（PL-G 全 100%） | 未开始 |

**验收机制本身的自检（重要）**：`runUnitFiles` 现在带两道护栏——观察到的测试数为 0 判失败、"有结果的测试文件数 < 发现的文件数"判失败。这条是被真的踩出来的：`isolation:'none'` 下事件词表是 `test:pass/test:fail/test:complete`（且叶子 `nesting` 恒为 0），早期计数器按旧词表数事件 → **空跑被报成 ALL GATES PASS**。已用故意失败的 canary 测试验证门限确会变红（`136 passed, 2 failed / GATE FAILURE`）。

## 决策（新增，勿回退）

1. **静区从单元格里扣**（`QUIET_CELLS=5`，`core/render/constants.js` 叶子模块）。之前只按点阵 fit 版面，页面实际超出板材。代价如实记录在容量表：`PL-D2@0.4` 1342→1098 B/页，`P-M1-600` 32558→31302 B/页。`constants.js` 必须独立成文件，否则 `profiles → render/layout → frame → profiles` 成环，`frame.PROFILE_CODES` 会在初始化时踩 TDZ。
2. **ρ 阈值自标定**：`shapeThresholds(levels, {targets})` + `measureTargets(cellPx, levels)`。有限像素下小点积分出的 ρ 系统性偏低（4 档 @24px：level3 目标 0.968 实测 0.905，裸阈值到判决边界的余量只剩 0.058）。解码端知道版面尺寸，就用"渲染器自己画出来的实测值"当目标，而不是把偏置当余量吃掉。`pskit calibrate` 将对真实扫描做同一件事。
3. **mono 不搬道**：单色渲染 = 色道信息**消失**（变成擦除），不是把色道位并进形状档位。旧代码 `min(shapeLevels-1, shape + colour*levels)` 会让 75% 的格子画点，直接毁掉单色可复原性。
4. **色道存活判据只看"出现过几种墨"**（`distinct>1`）。判据宁可保守：全页恰好只用一种墨的**彩色**页也会被声明为"死道"→ 走擦除重建，**浪费容量但绝不丢数据**。（旧写法 `spread>0.02` 逻辑反了：干净彩色图 spread≈0 会被判死。）
5. `monoSafe` 三档、明文摘要、分块塞满、`sessionId=sha256(明文)[0..8]`、`PL-D3='off'` 等 M1/M2 决策不变；旧条目里 1342/32558 等数字以本文件容量表为准。

## 容量实测表（`node cli/pskit.mjs status` 复算，勿手改）

| 档 | 喷嘴 | 节距 mm | 网格 | 净字节/页 | 码率 |
|---|---|---|---|---|---|
| P-M1-300 | — | 0.847 | 216×319 | 7514 | 0.874 |
| P-M1-600 | — | 0.423 | 443×649 | 31302 | 0.874 |
| P-M2-600 | — | 0.423 | 443×649 | 62604 | 0.874 |
| P-C4-600 | — | 0.423 | 443×649 | 35658 | 0.5 (full) |
| PL-D2 | 0.4 | 1.80 | 94×94 | 1098 | 0.5 (full) |
| PL-D2 | 0.2 | 1.04 | 170×170 | 3596 | 0.5 (full) |
| PL-D3 | 0.2 | 1.04 | 170×170 | 9460 | 0.873 (off) |
| PL-D3S | 0.4 | 1.80 | 94×94 | 2197 | 0.665 (partial) |
| PL-M1 | 0.4 | 1.80 | 94×94 | 960 | 0.873 |
| PL-G | 0.4 | 3.15 | 49×49 | 150 | 0.5 |
| PL-G | 0.8 | 3.80 | 39×39 | 166 | 0.5 |

1MB 载荷实测页数：纸面 600dpi 单色 **34+7=41 页**；600dpi 四色 `P-C4-600` **30+7=37 页**。20KB 板材 `PL-D2@0.4` = 19+4 = 23 页。板材超 255 页会被拒（页间 RS 上限），提示换密档。

## 已知风险 / 待办

- **最小 PDF 未写**（agent 静默失败）。PNG/TIFF 已够打印与验收，PDF 只是"方便丢进切片器/邮件"，M3 之后补。
- **TIFF 读回未接**（`pskit receive` 只吃 PNG）；TIFF 写侧已由 pillow 验证。
- `PL-G` 的"通用"指**单元格大到任何喷嘴都印得出来**，不是"一张版通吃所有喷嘴"。HARDWARE.md 必须写清"不知道对方喷嘴就选 0.8"。
- `densityReport` 对单通道档的 `monoSafe` 标 `n/a`（语义上正确，但容易被误读为"没保护"）。
- 真实相机/扫描仪路径（M3+）才是本项目的真正风险区：光照不均、透视、摩尔纹、对焦。理想采样器 0 误读**不等于**真实信道 0 误读。

## 变更日志

- M1：编码核心完成，105 单元全绿；修 RS 擦除定位子 (1+X·x)、BM 的 m 计数、deflate LZ77 重叠拷贝（`copyWithin` 语义错误）、native 档校验字节重复计入主通道、填充字节混入摘要；新增 `monoSafe` 三档与分块塞满；`tools/fix-mojibake.mjs`。
- **M2**：渲染层完成——`core/render/{units,glyphs,layout,raster}.js` + `core/palette.js` + `core/decode/{ideal,echo,png-read}.js` + `core/render/{png,tiff}.js`（agent 写，pillow+node:zlib 双向验证，A4@600dpi 4961×7016：PNG 460ms→0.84MiB / TIFF 127ms→99.6MiB）+ `cli/pskit.mjs`（send/receive/status/verify/roundtrip）。G1 图像层 269 万格 0 误读；G7 单色兜底通过；`pskit send`→磁盘 PNG→`pskit receive` 与原文件 sha256 相同。修：静区计入版面、ρ 阈值自标定、mono 搬道 bug、色道存活判据反了、门限空跑护栏。测试 105→136。
