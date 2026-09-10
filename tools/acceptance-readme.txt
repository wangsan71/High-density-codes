PSKT 验收包 —— 照下面的顺序做，把每一步的**终端输出**发回来。

这个包只装"要打印/拍摄的东西"和"照着敲的命令"。它不假装验过硬件：
真打印机、真扫描仪、真手机那三步只有你能做（docs/USE.md §5）。

包里有什么
  payload-paper.bin    纸面那一路要传的文件（{{PAPER_BYTES}} B），sha256 {{PAPER_SHA}}
  paper/               纸面页 page-000.png... + pack.pdf
  payload-module.bin   高密度模块纸面要传的文件（{{MODULE_BYTES}} B），sha256 {{MODULE_SHA}}
{{MODULE_LINES}}
  payload-plate.bin    板材那一路要传的文件（6 B），sha256 {{PLATE_SHA}}
  density-a4-300/      密度阶梯页（A4@300dpi：0.85/0.51/0.42/0.34mm）
  density-a5-600/      密度阶梯页（A5@600dpi：0.42/0.25/0.17mm）
  density-a6-1200/     密度阶梯页（A6@1200dpi：0.127/0.106/0.085mm）
{{PLATE_LINES}}
  mtf/                 MTF 校准板 mtf-plate.3mf / .stl / .png + mtf-plate.json

────────────────────────────────────────────────────────────────────
第 1 步 · 纸面（验 G2/G3：扫描后逐字节还原）
  1a. 打印 paper\pack.pdf：选 100% / 实际大小，**关掉**"适应页面"（缩放会破坏几何）
  1b. 用 300 dpi、彩色扫描，**关掉**自动裁剪/去边界，**存成 PNG 或 TIFF**，放 scans\
      （两个容器都直接解码：PNG 的黑白/灰度/彩色/调色板/16-bit 变体，以及 TIFF 的
       未压缩/LZW/Deflate/PackBits、二值/灰度/调色板/RGB/16-bit；多页 TIFF 会自动展开。
       只有 JPEG 要先转 PNG，或改用浏览器接收端——它自己解 JPEG）
  1c. 在这台机器上跑：
        node cli/pskit.mjs receive scans --photo --profile P-M1-300 --out got-paper.bin
  1d. 比摘要：
        (Get-FileHash -Algorithm SHA256 got-paper.bin).Hash
      应当等于 {{PAPER_SHA}}
  ✗ 不一致：把 1c 的完整输出发回来（它会点名哪一页读不出）。

第 1b 步 · 高密度模块纸面（验新的二进制模块表示）
  1b-a. 依次打印 module-6\pack.pdf、module-5\pack.pdf、module-4\pack.pdf：
        选 100% / 实际大小，**关掉**"适应页面"
  1b-b. 每份都用 300 dpi、彩色扫描，**关掉**自动裁剪/去边界，**存成 PNG 或 TIFF**
  1b-c. 分别接收（把 4 换成实际模块尺寸）：
          node cli/pskit.mjs receive scans-module-6 --photo --profile P-MX-300-6 --out got-module-6.bin
          node cli/pskit.mjs receive scans-module-5 --photo --profile P-MX-300-5 --out got-module-5.bin
          node cli/pskit.mjs receive scans-module-4 --photo --profile P-MX-300-4 --out got-module-4.bin
  1b-d. 三个输出文件的 sha256 都应当等于 {{MODULE_SHA}}
  ✗ 任一档读不出：把对应命令的完整输出发回来；真平板扫描是这三档从“模拟 16/16”
      变成“真实已验证”的必要一步。
  一条命令批量检查：
        node tools/check-module-scans.mjs --kit 这个验收包目录 --scans 放 scans-module-6/5/4 的父目录

第 2 步 · 密度阶梯（验 PLAN v5 P0：这套打印机+扫描仪**到底能细到多少**）
  说明：3D 板材那一条线已被产品负责人取消（PLAN-V5 §3）⇒ 不再打码牌、不再打 MTF 板。
        这一步量的是**纸**：同一张纸上并排印多种模块间距，扫回来直接给误码率。

  2a. 打三张（都在包里，**100% 缩放**，别选"适应页面"）：
{{LADDER_LINES}}
      小纸那两张（A5/A6）如果打印机只吃 A4，就把它打在 A4 纸上 —— PDF 页面尺寸是 A5/A6，
      实际码区就是那个尺寸，多出来的纸边无所谓。
  2b. 每张按它自己的 dpi 扫一次（彩色、关自动裁剪/去底色、存 PNG 或 TIFF）：
        density-a4-300   -> 300 dpi
        density-a5-600   -> 600 dpi
        density-a6-1200  -> 1200 dpi（打印机/扫描仪不支持 1200 就跳过这张，别的照做）
      扫描件放成三个目录：scans-a4 / scans-a5 / scans-a6
  2c. 逐张读回来（这是唯一一步"我给的命令"）：
        node tools/density-ladder.mjs --read scans-a4 --spec density-a4-300\density-ladder.json
        node tools/density-ladder.mjs --read scans-a5 --spec density-a5-600\density-ladder.json
        node tools/density-ladder.mjs --read scans-a6 --spec density-a6-1200\density-ladder.json
      把三段输出**原样**发回来。它逐条带打印 BER / 净 B per page / bit per mm² / 可用性。
  ✗ 如果三张都报 "markers/..."：把扫描件原样发回来（分辨率或裁剪不对是最常见的原因）。


第 4 步 · 浏览器（验 G9）
  4a. 在 Chrome / Edge / Safari 里各打开一次发送页与接收页
      （file:// 单文件版 + 局域网 http 版各一次；接收页加 ?selftest=1 看自检）
  4b. 发送页选一个文件 → 生成 → 接收页把它还原回来，比摘要
  ✗ 任何一步报错：把浏览器控制台（F12）里的红色文字发回来。

第 5 步 · 手机（验 G4）
  照 docs/USE.md §5 的 G4 那行做（手机同 Wi-Fi 打开局域网地址 → 页面最下面的
  "手机连拍" → 每轮在"存成什么名字"里填回带扩展名的原名 → 确认文件真的落盘）。

────────────────────────────────────────────────────────────────────
判据不会为了好看而放宽：跑通了我会按门限表如实记账；跑不通就把输出发回来，
我会把它记成缺陷（docs/DEFECTS.md），而不是记成"应该没问题"。
