# RENDER CONTRACT · 渲染层三件套的共同约定

任何产出图像的模块都必须遵守本文件。改约定要同时改这里、实现、以及所有测试。

## 像素缓冲（唯一的跨模块数据结构）

```js
{
  width: number,            // 像素
  height: number,           // 像素
  pixels: Uint8Array,       // 长度必须 === width * height * 4
  dpi: number,              // 打印分辨率（300 / 600），只影响物理尺寸标注，不改变像素
}
```

- 排列：**行主序，首行 = 顶行**（不是 BMP 的自底向上）。
- 通道：**RGBA 4 通道，8 bit/通道，直通 alpha（非预乘）**。不透明处 `A = 255`。
- 坐标系：`(0,0)` 在左上角；`x` 向右、`y` 向下。
- 颜色：RGB 直给，不做 gamma/色彩管理（打印机驱动负责）。调色板见 `core/palette.js`。
- 越界写入视为 bug：写之前先 assert 索引 `< pixels.length`。

## 各编码器签名（纯函数，不碰文件系统、不用 `node:` 内建）

```js
encodePNG ({ width, height, pixels, dpi })            -> Uint8Array   // 8-bit，无隔行，非调色板
encodeTIFF({ width, height, pixels, dpi })            -> Uint8Array   // baseline little-endian，photometric 2，单 strip，无压缩
encodePDFPage({ width, height, pixels, dpi, pageMm }) -> Uint8Array   // 一页，图像以 /FlateDecode + PNG predictor 内嵌
```

三者都必须是**同步**的（浏览器 `file://` 与 Node 共用），且对同一输入产出**字节确定**（byte-deterministic）的结果——G8/G9 要用哈希对比验收。

## 单位换算（唯一入口，别在别处手算）

`core/render/units.js`:
```js
mmToPx(mm, dpi) -> number   // Math.round(mm * dpi / 25.4)
pxToMm(px, dpi) -> number
ewPx(ewMm, dpi) -> number   // 一次挤压宽度的像素数（可非整数，但格子中心必须落在整数像素上）
```

## 版面（layout）要素，从左到右

1. **静区 quiet zone**：≥ 4 × pitch 的纯背景边带（`layout.quietPx`）。
2. **定位角标 fiducials**：三个角的实心方块 + 空心方框（外 3×3 单元、中心实心），用于单应估计的初值。**不得**与数据单元格形状混淆。
3. **回显带 echo band**：沿左边的一条 `HEADER_LEN*8` 高的单元带，内容是帧头比特（1=有色，0=背景）。见 `core/frame.js#encodeEcho`。
4. **数据点阵 lattice**：`geom.cols × geom.rows`，单元边长 = `geom.pitchMm`，左上角在 `geom.originMm`。
5. 单元内容：色道 → 调色板颜色；形状道 → 参考环内的实心圆，面积比 ρ 决定档位（见 `core/render/glyphs.js`）。

## 打印物理的建模规则

- 所有特征尺寸必须是**整数倍挤出宽度 (EW)**； EW 见 `core/nozzles.js`。
- 形状判别用**比值**（中心特征面积 / 参考环面积），不用绝对直径——这样 0.2 与 0.8 喷嘴的产物可由同一套阈值解码。
- 相邻有色单元在打印时会被挤成连片，因此**同一色道内相邻同色单元允许合并渲染**，但解码端必须按"单元"重新切分（靠格子中心，不靠连通域）。
