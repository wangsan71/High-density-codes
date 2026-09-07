# `ref/` — 独立参考解码器（PLAN §9 的对拍侧）

这个目录的存在只有一个理由：**证明 `core/**` 的编码格式不是"自洽即正确"**。同一份 JS 自己
编、自己解，永远测不出"我把规格写歪了但两边都歪得一样"。所以这里放着第二套实现，它跑
`tests/conformance.json` 里的每一条向量，任何一项不一致就 exit 1。

```
python ref/decode.py            # 跑全部向量，打印每组 ok/total
python ref/decode.py -v         # 逐条打印
python ref/decode.py --strict-gaps   # 把 SPEC GAP 也当失败
python ref/probe_rs.py          # RS 分解诊断（定位子取向、擦除、混合、超预算）
```

## 独立性靠"看不到"来保证

写这个目录的纪律是：**不许读 `core/*.js`**，只依据答案卷里 `meta`  stated 的规则实现——
GF(2⁸) 参数、CRC 参数、位序与色道打包、交织置换、56 字节头表、KDF、PSZ1 容器、页序与装配
顺序。信息不足时报 `SPEC GAP`，**禁止猜**。这条纪律是这个文件有意义的前提；一旦有人为了省事
去照抄 JS，对拍就退化成"和我自己比"，剩下的绿灯全是假的。

反过来也成立：**只要这里报 GAP 或"读出来不像规格说的"，先当作规格的失败来修**，而不是当作用户
（实现者）的错误。历史上每一条都对应一次真缺陷：

| 现象 | 谁错了 | 之后写进 meta 的东西 |
|---|---|---|
| "页面上没有任何东西告诉我要解密" | 我：`{passphrase}` 少 `cipher:true` 就静默印明文 | 口令即加密请求（决策 13） |
| 容器长度字段端序对不上 | 我：meta 把 `PSZ1` 写成 u32**be**、9 字节头 | 10 字节头、offset 6 u32LE、offset 5 保留 |
| content 全对、parity 全错 | 参考侧按文字读错了次通道位移（文字确实允许这么读） | 可验算数字 + 位移式子（决策 15①） |
| `payloadLen` 768 vs 明文 576 | 我：一个词指两种填充，且两句话互相矛盾 | `meta.pages`：页优先装配、两种 padding 分别命名 |
| 干净页重组从 offset 1 起不一致 | 参考侧把页间 RS 的"列视角"用到了数据装配上 | `meta.pages.assembly` 明写列视角只用于纠错 |

## 原语用 stdlib，不是偷懒（决策 14）

`sha256_bytes` → `hashlib`；`crc_calc` 的 CRC-32 分支 → `zlib.crc32`；PBKDF2 → 
`hashlib.pbkdf2_hmac`；DEFLATE → `zlib.decompressobj(-15)`。对拍要的独立性在**协议逻辑**
（RS、交织、色道、容器、头），不在重造 FIPS 原语：`core/hash.js` / `core/crc.js` /
`core/deflate.js` 已在门限 G0 分别钉在 node:crypto / node:zlib 上，参考端再用一个经审计的
第三方实现只会**更强**——两边同时错成一样的概率更低。它自己手搓的那份 SHA-256 保留为
`_sha256_handrolled`，证据写在 `sha256_bytes` 的 docstring 里（所有输入的输出尾部四个字恒
定 = 消息没进压缩函数）。**ChaCha20 仍是它自己写的**（stdlib 没有，且它 8/8 全过）：这是这
个目录里"真独立"的活证据，别换成 `cryptography` 之类。

## PASS 不等于什么

- 不等于真实相机/扫描仪能读出来：这里对的是**字节层的格式约定**，光学退化归 G2/G4/G10（信道
  在 `sim/`）。
- 不等于 `ref/` 是"正确的解码器"：它只是第二意见。两边不一致时，判据是"谁被物理证据支持"——
  例如次通道那次，`core/` 的约定被 G1 的 269 万格双色渲染读回验证过，所以错在参考侧。
- 不等于没有已知含糊：见下面 GAP。

## 已接受的 SPEC GAP（`--strict-gaps` 会失败，这是有意的）

`geometry-*` 四条：向量给的是 pitchMm / 纸张尺寸 / 净字节每页 / 字形几何的**结果**，而 `meta`
没有记载推导它们的规则（那需要把决策 6 的 EW 量化搜索整个搬进规格，代价高且容易和实现脱节）。
所以这四条只校验内部算术自洽，不校验"能否从规则推出"。**板材几何的端到端证据在 G8（3MF/STL
被独立解析）和 G10（喷嘴矩阵），不要拿 geometry 向量代替它们。**

## 答案卷怎么长出来

`node tools/emit-conformance.mjs`（确定性：自作的 LCG，salt/nonce 固定注入）→ `tests/conformance.json`
（78 向量 / 203 KiB / 发射器带 400 KiB 预算闸）。`tests/unit/conformance.test.mjs` 在 JS 侧逐类复算，
并断言"重新发射必须逐字节相同"，所以这份答案卷不会静默腐烂，也不依赖本机是否有 Python。
