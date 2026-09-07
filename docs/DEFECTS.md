# 缺陷台账（按用户指示：错误先记录、后修复；本文件只增不删，修好才划掉）

> 规则：每条必须能被一条命令复现。**不写"应该没问题"**。性能问题一律不修（用户明示先不管）。

## 未修（第 23 轮末状态）

| # | 缺陷 | 复现 | 性质 |
|---|---|---|---|
| D1 | `web/send.html` + `web/sender.js` 尚未进 dist 拷贝清单（构建器目前只拷 index/app/css/selftest/pskt-file），所以 `node tools/check-dist.mjs` 通过 ≠ 发送端已在产物里 | `node tools/build-web.mjs && Test-Path web/dist/send.html` ⇒ False | 接线缺失 |
| D2 | `sender.js` 里 `encodeTransfer` 的选项形状、`pageLayout` 的 `sheetMm:true`（我传了布尔，CLI 传的是尺寸）未经执行验证 | `node --check web/sender.js`（语法）＋浏览器打开点"编码"看日志是否报 `sheetMm` | 可能崩，崩了会拒绝出文件（安全侧） |
| D3 | 单测红 3 条：我给 `core/decode/advice.js` 登记 `no-candidate-geometry` / `no-geometry-matched` 满足了"每条失败 reason 都要有建议"，但破了"每条已登记 reason 必须是测试可发现的真实失败形状" | `node --test --test-isolation=none "tests/unit/**/*.test.mjs"` ⇒ 228/231 | 判据两边都要满足，禁止削弱测试 |
| D4 | 首页 `index.html` 无到 `send.html` 的入口（接收端页面里点不到发送端） | 打开 dist/index.html 目视 | 可用性问题 |
| D5 | 发送端未进 `pskt-file.html` 单文件变体（`file://` 下只能"收"，不能"发"） | 打开 `web/dist/pskt-file.html` 目视 | PLAN 只要求接收端 file:// 可用，故列为待办非违约 |
| D6 | PWA 安装（`manifest.webmanifest` + 图标）没做 ⇒ 手机"添加到主屏幕"不完整；iOS 需 PNG 图标（需自研：可用 `core/render/png.js` 在构建期生成 ✓ 无新依赖） | `Select-String -Path web/index.html -Pattern manifest` ⇒ 无 | 手机端体验 |
| D7 | 手机摄像头**连拍取页**没做（现有 `--photo` 等价逻辑在 CLI；web 端只有单张文件/单次取景），`core/decode/fiducial.js`+`warp.js` 已就绪未接线 | 手机开 https 版本站"摄像头"按钮，观察只能一张 | 手机端核心 |
| D8 | 浏览器打印依赖用户手选"实际大小/100%"，缩放错则几何错（帧头会拒收 ⇒ 不会静默出错，但要重扫） | 打印一页后用 300 dpi 扫描对比 cellPx | 已知限制，UI 已提示走 `pack.pdf` |
| D9 | 我在这两个新文件里犯了本项目头号错两类：**DOM id 前后不一致**（`dl-pdf` vs `dlpdf` ✓ 已改）与**引用未证实的字段/导出**（`t.profileId`、`p.parity`、`t.dataPages`、从 `protocol.js` import `advise` ✓ 已全部改为防御式或删除） | `git show HEAD --stat`；日志现改为打印真实 `Object.keys(t.geom)` | 复发 5 次；根治办法是"先跑一遍再说"，不是再看一遍代码 |
| D10 | `docs/STATUS.md` 第 23 轮那行没写（预算耗尽）；`docs/ACCEPTANCE.md` 的 G9 行也仍是旧结论 | `git log -1 --stat` 不含 STATUS | 台账欠账，下轮第一件事补 |
