# 怎么用 · PSKT（打印—扫描传文件）

**这套东西现在就能用。** 本文件是给用户看的操作手册；判据与实测在 `docs/ACCEPTANCE.md`，门限状态与下一步在 `docs/STATUS.md`，已知问题在 `docs/DEFECTS.md`。

- 零运行时依赖：`package.json` 的 `dependencies` 恒为 `{}` ⇒ **不需要 `npm install`** ✓
- 全程气隙：不联网、页面里没有任何外部 URL，数据只走"打印出来的图案" ✓
- 需要 Node（本机 v24.14.0 ✓）。只有"模拟打印+扫描"那一步需要 Python 3.10 + numpy + opencv（真打印真扫描时不需要）。

---

## 1. 电脑端：双击就能用（`file://`，无需服务器）

| 要做什么 | 打开哪个文件 |
|---|---|
| **发送**：把文件变成可打印的页 | `web/dist/pskt-send-file.html`（单文件版，内核已内联） |
| **接收**：把扫描/照片还原成文件 | `web/dist/pskt-file.html`（单文件版） |

发送页：拖入或选择文件 → 选 profile（纸面 `P-M1-300`；实体码牌 `PL-D2`）→ 下载 **页图 PNG** / **`pack.pdf`（真实物理尺寸，直接送打印机）** / 板材 **`.3mf` + `.stl`**。
接收页：把**整盘**扫描或照片一次拖进去（可以乱序、可以缺页，页面会报缺哪几页；页间有 RS 冗余，少量缺页能自动补回）→ 还原后落盘。

> 为什么有"单文件版"：`send.html` / `index.html` 是走 ES module 的瘦版，**浏览器在 `file://` 下拒绝加载 module**（CORS），所以双击必须用单文件版。瘦版经 http 提供时同样可用（见 §2）。

**自检入口**（确认你这台机器的浏览器真能跑解码路径）：在接收页地址后加 `?selftest=1`，例如
`file:///D:/.../web/dist/pskt-file.html?selftest=1`

## 2. 手机端：一条命令起局域网服务

手机要用**摄像头连拍接收**（`web/dist/index.html`，带 PWA `manifest.webmanifest` + `sw.js`），而摄像头权限、module、service worker 在 `file://` 下都不可用 ⇒ 必须经 http：

```powershell
# 在电脑上（仓库根目录）
python -m http.server 8000 --directory web/dist
ipconfig        # 看 IPv4 地址，例如 192.168.1.23
```

手机连**同一个 Wi-Fi**，浏览器打开：`http://192.168.1.23:8000/index.html`（把 IP 换成你的）
自检：`http://192.168.1.23:8000/index.html?selftest=1`

**如实说明（别期待错）**：PWA 的"添加到主屏幕/离线安装"要求 **https 或 localhost**，局域网 http 源会被浏览器拒绝 ⇒ 代码里也照实处理了（`pskt-file.html` 只在 `secure` 时才注册 `sw.js`）⇒ **手机上能用，但装不成离线 PWA**。要真装需要 https 托管：`.github/workflows/pages.yml` 还没写（见 `docs/STATUS.md`），而且 GitHub 推送本身还等你的仓库地址与凭据。**第二个安装阻塞**：manifest 里唯一的图标是 `icon-page.png`、尺寸写的是 `3290x3290`（整页渲染被当图标用 ✗），而安装性要求 **192×192 与 512×512** ⇒ 记在 `docs/DEFECTS.md` **D43**，修法要动构建（`tools/build-web.mjs`）而不是手改 dist。

**不用手机也能先验一遍"服务端这半是真的"**（本轮实测 exit 0）：

```powershell
python -m http.server 8123 --directory web/dist     # 一个终端
node tools/check-lan.mjs --port 8123                # 另一个终端
```

它做的是浏览器会做的事：把 SW 预缓存清单里**每一条**资源 fetch 下来、用我们自己的 `core/hash.js` 比对 sha256（**48/48 一致** ⇒ `cache.add()` 无从失败 ✓）；扫 4 个页面有没有**外部 URL**（`src=`/`href=`/`fetch()`/`import()`，只豁免 `xmlns` 命名空间串 ⇒ 气隙契约在 http 源上同样成立 ✓）；确认瘦页的模块图能解析、manifest 的 `start_url` 可取；并**报告** CSP meta 是否存在（实测 4 页都有 ✓）。它**不能**证明 SW 注册、安装提示、摄像头权限——那要真浏览器（G9 / D18），而且它会把上面两个安装阻塞**打印出来但不计入通过与否**（报出来 ≠ 通过 ✓）。

发送端在手机上也能开（`.../pskt-send-file.html`），但小屏拖拽体验差 ⇒ 建议**电脑发送、手机接收**。

## 3. 真打印 / 真扫描 / 真拍照

- **打印**：用 `pack.pdf`。打印对话框里必须选 **100% / 实际大小**，**关掉**"适应页面/适应可打印区域"——缩放会破坏几何（这件事记在 `docs/DEFECTS.md` D8，浏览器默认缩放是已知坑 ✗）。
- **扫描**：300 或 600 dpi、**彩色**、**关掉自动裁剪/去边界**（会切掉角上的基准标记 ✗）。
- **拍照**：正对、四角完整、避免反光；接收走 `--photo` 路径（自动找标记 → 透视校正 → 读）。
- **3D 码牌**：`.3mf` 直接丢给切片软件（Bambu Studio / Orca / PrusaSlicer 等）；`--nozzle 0.2|0.4|0.6|0.8` 决定最小可打印特征。实测 `PL-D2@0.4`：3 objects / 377964 triangles / 4.1 MB，且通过 3MF Core 1.4 子集校验（`verify --gate G8`）。

**一次能传多大**（实测数字与 CLI 自己的容量拒绝推算，不是估的）：

- 一次传输最多 **255 页**（页间 RS 的限制）⇒ 最大 payload ≈ 每页净字节 × 255。
- 纸面 `P-M1-300`：每页净 **7514 B** ⇒ 上限约 **1.9 MB**；200 KiB 的文件 = **3 页**（实测 ✓）。
- 板材 `PL-D2@0.4`：每页净**约 180 B** ⇒ 上限约 **46 KB**。拿 200 KiB 去喂它，CLI 会**直接拒绝**并给可操作建议：`needs 1120 pages > 255 (inter-page RS limit): shrink payload or use a denser profile` ✓ 这是设计行为（宁可拒绝，也不产出"看起来成功但是错"的东西）。
- 完整容量表（各 profile × 喷嘴）：`node cli/pskit.mjs status`

**命令行等价**（可脚本化，与页面走同一份 `core/`）：

```powershell
node cli/pskit.mjs send FILE --profile P-M1-300 --format png,pdf --out DIR
node cli/pskit.mjs send FILE --profile PL-D2 --nozzle 0.4 --format 3mf,stl --out DIR
node cli/pskit.mjs receive DIR --photo --out OUT.bin
node cli/pskit.mjs status                       # 各 profile / 喷嘴的容量表
node cli/pskit.mjs verify --gate all            # 进程内门限（会打印本次没评估哪些）
```

## 4. 一条命令自证"能跑起来并且可以用"

```powershell
& .\tools\usability.ps1                 # 纸面 + 3D + 两个客户端数据路径
& .\tools\usability.ps1 -Preset phone40 # 换成手机拍照的信道预设
& .\tools\usability.ps1 -Skip3D         # 只跑纸面，更快
```

它做的是一条**用户真会走的路**：`send`（写页图 + 真实尺寸 PDF）→ `sim/channel.py`（确定性 seed 的"打印+扫描"替身）→ `receive --photo` → **SHA-256 逐字节比对** → 板材 `send --format 3mf,stl` 并用 G8 校验写出来的 `.3mf` → `tools/smoke-sender.mjs`（网页发送端的真实数据路径，盲解码）与 `tools/smoke-capture.mjs`（连拍取舍逻辑）。每步**只看 exit code** 判定，不靠 grep 关键字（"什么都没打印"不能算通过 ✗）。

**它不证明**：真墨真纸、真手机摄像头、浏览器的打印缩放（D8）、PWA 安装、以及需要硬件的门限 G4 / G6 / G9 / G10 ⇒ 见 §5。

## 5. 需要你用真硬件验收的清单

| 项 | 怎么做 | 现状 |
|---|---|---|
| **G4 手机压力** | 手机开接收页连拍 **500 页 × 8 轮**，看是否 100% 还原 | **从未跑过** ✗ |
| **G9 浏览器** | Chrome / Edge / Safari 各开发送页与接收页各一次（`file://` 单文件版 + http 瘦版各一次） | 未跑 ✗ |
| **D8 打印缩放** | 打一页，量实际尺寸与 PDF 标称是否一致；若被缩放，手动改 100% 再量 | 未量化 ✗ |
| **G10 喷嘴矩阵** | 用 0.2 / 0.4 / 0.6 / 0.8 各打一块码牌，拍/扫后还原 | 需打印机 ✗ |
| **G6 soak** | 长时间连续运行 | 进程内实现尚无 ✗ |

做完把结果（截图、量的尺寸、失败页号）发回来，我按门限表**如实**记账——**判据不会为了好看而放宽**。

## 6. 出问题时

- **一页都读不出**：先确认扫描没被"自动裁剪"、没被转成灰度（只有 `monoSafe` 的 profile 才保证单色可恢复 ✓）。
- **缺页**：接收页会点名缺哪几页；补拍那几页即可。冗余比例由发送时的 `--parity` 决定。
- **报 `digest mismatch`**：这是**设计行为**——宁可失败也绝不交出"看起来成功但是错"的数据（误接受为 0 是本项目的硬约束）。
- **想自己验内核**：`node cli/pskit.mjs verify --gate all`（G0 单测 277/277、G1/G3/G5/G7/G8 进程内），或接收页 `?selftest=1`。
