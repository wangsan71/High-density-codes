PSKT 验收包 —— 照下面的顺序做，把每一步的**终端输出**发回来。

这个包只装"要打印/拍摄的东西"和"照着敲的命令"。它不假装验过硬件：
真打印机、真扫描仪、真手机那三步只有你能做（docs/USE.md §5）。

包里有什么
  payload-paper.bin    纸面那一路要传的文件（{{PAPER_BYTES}} B），sha256 {{PAPER_SHA}}
  paper/               纸面页 page-000.png... + pack.pdf
  payload-plate.bin    板材那一路要传的文件（6 B），sha256 {{PLATE_SHA}}
  plates/              码牌（每个喷嘴一块，**只打 page-000 那一块**）
{{PLATE_LINES}}
  mtf/                 MTF 校准板 mtf-plate.3mf / .stl / .png + mtf-plate.json

────────────────────────────────────────────────────────────────────
第 1 步 · 纸面（验 G2/G3：扫描后逐字节还原）
  1a. 打印 paper\pack.pdf：选 100% / 实际大小，**关掉**"适应页面"（缩放会破坏几何）
  1b. 用 300 dpi、彩色扫描，**关掉**自动裁剪/去边界，存到 scans\
  1c. 在这台机器上跑：
        node cli/pskit.mjs receive scans --photo --profile P-M1-300 --out got-paper.bin
  1d. 比摘要：
        (Get-FileHash -Algorithm SHA256 got-paper.bin).Hash
      应当等于 {{PAPER_SHA}}
  ✗ 不一致：把 1c 的完整输出发回来（它会点名哪一页读不出）。

第 2 步 · 板材（验 G10：每个喷嘴一块码牌）
  2a. 把 plates\ 里**每个**喷嘴的 page-000.3mf 丢进切片软件，按那个喷嘴打一块
      （0.2 喷嘴打 0.2 的那块，以此类推；PL-D2 @ 0.4 是默认档）
  2b. 拍/扫每一块板（正对、四角完整、避免反光），每块一个目录
  2c. 逐块跑（把 0.8 换成实际的喷嘴）：
        node cli/pskit.mjs receive photos-0.8 --photo --profile PL-G --nozzle 0.8 --plate {{PLATE_MM}} --out got-0.8.bin
        (Get-FileHash -Algorithm SHA256 got-0.8.bin).Hash
      每块都应当等于 {{PLATE_SHA}}
  ✗ 某一块读不出：把那条命令的完整输出发回来（它会点名缺哪一页 / 哪一步失败）。

第 3 步 · MTF 校准板（量"这一档到底能读到多细"）
  3a. 打一块 mtf\mtf-plate.3mf（或把 mtf-plate.png 按 100% 打在纸上）
  3b. 拍/扫它，然后：
        node cli/pskit.mjs calibrate 你的照片.png --mtf --spec mtf\mtf-plate.json
  3c. 它会给一条"建议喷嘴"和逐档的读数。把这段输出发回来。
  提示：整张 200mm 板塞进一张手机照片（约 100dpi）连 0.95mm 的孔都读不出，
        这时它会**拒绝推荐任何喷嘴**并让你拍近一点 —— 那是实话，不是工具挑剔。

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
