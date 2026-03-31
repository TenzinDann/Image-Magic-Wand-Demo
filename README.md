# Image Magic Wand

一个基于 **React + Vite + OpenCV.js** 的网页图片瑕疵修复工具。  
你可以上传图片，用画笔涂抹要修复的区域，然后一键执行 inpaint（补全）。

## 正式版网站

Live Website: [https://tenzindann.github.io/image-magic-wand/](https://tenzindann.github.io/image-magic-wand/)

## 功能特性

- 支持文件选择和拖拽上传图片
- 画笔蒙版涂抹（可调笔刷大小）
- 修复算法可选：`默认` / `Telea` / `Navier-Stokes`
- 基于 ROI（局部区域）修复，减少全图计算开销
- 自动蒙版预处理、边缘保护、羽化融合与色彩协调
- 撤销（Undo）与导出 PNG
- 画布缩放与平移（适合大图精修）
- 内置回归指标采集（浏览器控制台可查看）

## 技术栈

- React 19
- TypeScript
- Vite 6
- OpenCV.js（运行时从 CDN 加载）
- lucide-react（图标）

## 本地运行

```bash
npm install
npm run dev
```

默认开发地址：`http://localhost:3000`

## 构建与预览

```bash
npm run build
npm run preview
```

## 使用说明

1. 点击“打开图片”或直接拖拽图片到中间区域。
2. 用画笔涂抹需要修复的区域。
3. 选择算法（建议先用 `默认`）。
4. 点击“修复”查看结果。
5. 需要回退可点“撤销”，满意后点“保存”导出 PNG。

## 快捷操作

- 鼠标滚轮：缩放
- `Space + 左键拖拽`：平移画布
- 鼠标中键拖拽：平移画布
- `W/A/S/D` 或方向键：连续平移
- 双击画布区域：缩放重置为适配视口