const state = {
  cvReady: false,          // OpenCV.js 是否就绪
  imageLoaded: false,      // 是否已加载图片
  painting: false,         // 是否正在涂抹
  brushSize: 15,           // 画笔半径
  // 保存历史，用于撤销 (存储 ImageData)
  history: [],
  maxHistory: 20,
  // 原始图像的 cv.Mat（每次 inpaint 后更新）
  srcMat: null,
  // 缩放/平移
  zoom: 1,
  zoomMin: 0.1,
  zoomMax: 10,
  panX: 0,
  panY: 0,
  panning: false,
  panStartX: 0,
  panStartY: 0,
  historyBytes: 0,
  maxHistoryBytes: 256 * 1024 * 1024,
  maskBounds: null,
  lastBrushPoint: null,
};

const CV_READY_TIMEOUT_MS = 20_000;
let cvLoadStartAt = 0;

// ---- DOM 元素 ----
const $ = (sel) => document.querySelector(sel);
const fileInput      = $('#file-input');
const canvasMain     = $('#canvas-main');
const canvasMask     = $('#canvas-mask');
const ctxMain        = canvasMain.getContext('2d');
const ctxMask        = canvasMask.getContext('2d');
const canvasWrapper  = $('#canvas-wrapper');
const canvasArea     = $('#canvas-area');
const placeholder    = $('#placeholder');
const brushSlider    = $('#brush-size');
const brushSizeVal   = $('#brush-size-val');
const algoSelect     = $('#algo-select');
const btnInpaint     = $('#btn-inpaint');
const btnClearMask   = $('#btn-clear-mask');
const btnUndo        = $('#btn-undo');
const btnSave        = $('#btn-save');
const statusText     = $('#status-text');
const statusDims     = $('#status-dims');
const progressWrap   = $('#progress-bar-wrap');
const progressFill   = $('#progress-bar-fill');
const progressLabel  = $('#progress-bar-label');
let brushCursorCacheKey = '';


function showProgress(pct, label) {
  progressWrap.classList.remove('hidden');
  progressFill.style.width = pct + '%';
  progressLabel.textContent = label || '';
}
function hideProgress() {
  progressWrap.classList.add('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = '';
}


let _cvCheckTimer = null;

function onOpenCvReady() {
  // script onload 触发，但 Wasm 可能还没初始化完毕
  // 启动轮询，确保 cv.Mat 等核心 API 可用
  _waitForCv();
}

function _waitForCv() {
  if (_cvCheckTimer) return; // 避免重复
  cvLoadStartAt = performance.now();
  showProgress(30, '正在初始化 OpenCV.js Wasm 模块…');
  _cvCheckTimer = setInterval(() => {
    if (typeof cv !== 'undefined' && cv.Mat && cv.imread && cv.inpaint) {
      clearInterval(_cvCheckTimer);
      _cvCheckTimer = null;
      _onReady();
      return;
    }
    if (performance.now() - cvLoadStartAt > CV_READY_TIMEOUT_MS) {
      clearInterval(_cvCheckTimer);
      _cvCheckTimer = null;
      hideProgress();
      setStatus('OpenCV.js 加载超时，请检查网络后刷新页面');
    }
  }, 80);
}

function _onReady() {
  state.cvReady = true;
  cvLoadStartAt = 0;
  hideProgress();
  setStatus('OpenCV.js 就绪 — 请加载图片');
  console.log('[Flaw Broom] OpenCV.js ready');
}

function onOpenCvError() {
  if (_cvCheckTimer) {
    clearInterval(_cvCheckTimer);
    _cvCheckTimer = null;
  }
  cvLoadStartAt = 0;
  hideProgress();
  setStatus('OpenCV.js 加载失败，请检查网络或稍后重试');
}

// OpenCV script onload — 在 JS 中注册，避免 async 脚本与 app.js 的时序竞态
const opencvScript = document.getElementById('opencv-script');
if (opencvScript) {
  opencvScript.onload = onOpenCvReady;
  opencvScript.onerror = onOpenCvError;
}

// 页面加载时也启动检测（兜底）
window.addEventListener('load', () => {
  if (!state.cvReady) {
    setStatus('⏳ 正在加载 OpenCV.js…');
    showProgress(10, '正在下载 OpenCV.js…');
    _waitForCv();
  }
});


fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadImageFile(file);
});

// 拖拽支持
canvasArea.addEventListener('dragover', (e) => { e.preventDefault(); });
canvasArea.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImageFile(file);
});

function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;

  // Use object URL to avoid base64 inflation from readAsDataURL.
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    initCanvas(img);
    URL.revokeObjectURL(objectUrl);
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    setStatus('❌ 图片加载失败，请选择其他图片');
  };

  img.src = objectUrl;
}

function initCanvas(img) {
  // 设置画布尺寸
  canvasMain.width  = img.width;
  canvasMain.height = img.height;
  canvasMask.width  = img.width;
  canvasMask.height = img.height;

  // 绘制原图
  ctxMain.drawImage(img, 0, 0);

  // 清空蒙版
  clearMask();

  // 保存当前状态到 OpenCV Mat（仅在 cv 就绪时）
  if (state.cvReady) {
    if (state.srcMat) state.srcMat.delete();
    state.srcMat = cv.imread(canvasMain);
  }

  // 重置历史
  state.history = [];
  state.historyBytes = 0;
  pushHistory();

  // UI
  placeholder.style.display = 'none';
  canvasWrapper.classList.remove('hidden');
  state.imageLoaded = true;
  btnInpaint.disabled = false;
  btnClearMask.disabled = false;
  btnSave.disabled = false;
  updateHistoryButtons();

  // 自适应缩放：让图片完整显示在视口内
  zoomToFit();
  brushCursorCacheKey = '';
  updateCursorOverlay();

  statusDims.textContent = `${img.width} × ${img.height} | ${Math.round(state.zoom * 100)}%`;
  setStatus('图片已加载 — 用画笔涂抹需要修复的区域');
}

function zoomToFit() {
  const padding = 40;  // 边距留白
  const areaW = canvasArea.clientWidth  - padding;
  const areaH = canvasArea.clientHeight - padding;
  const imgW  = canvasMain.width;
  const imgH  = canvasMain.height;

  if (imgW <= 0 || imgH <= 0) return;

  // 取宽高缩放比的较小值，保证整张图都能显示
  const fitZoom = Math.min(areaW / imgW, areaH / imgH, 1); // 不超过 100%

  state.zoom = fitZoom;

  // 居中显示
  const scaledW = imgW * fitZoom;
  const scaledH = imgH * fitZoom;
  state.panX = (canvasArea.clientWidth  - scaledW) / 2;
  state.panY = (canvasArea.clientHeight - scaledH) / 2;

  applyTransform();
}

// 窗口 resize 时重新适配
window.addEventListener('resize', () => {
  if (state.imageLoaded) zoomToFit();
});

// ============================================================
// 画笔 / 蒙版绘制
// ============================================================
brushSlider.addEventListener('input', () => {
  state.brushSize = parseInt(brushSlider.value, 10);
  brushSizeVal.textContent = state.brushSize;
  updateCursorOverlay();
});

canvasMask.addEventListener('mousedown', (e) => {
  if (!state.imageLoaded || spaceHeld || state.panning) return;
  state.painting = true;
  state.lastBrushPoint = null;
  drawBrush(e);
});
canvasMask.addEventListener('mousemove', (e) => {
  if (!spaceHeld && !state.panning) updateCursorOverlay();
  if (state.painting && !spaceHeld) drawBrush(e);
});
canvasMask.addEventListener('mouseup',    () => stopPainting());
canvasMask.addEventListener('mouseleave', () => stopPainting());

function stopPainting() {
  state.painting = false;
  state.lastBrushPoint = null;
}

function resetTrackedMaskBounds() {
  state.maskBounds = null;
}

function updateTrackedMaskBounds(x, y, radius) {
  const w = canvasMask.width;
  const h = canvasMask.height;
  const minX = Math.max(0, Math.floor(x - radius - 1));
  const minY = Math.max(0, Math.floor(y - radius - 1));
  const maxX = Math.min(w - 1, Math.ceil(x + radius + 1));
  const maxY = Math.min(h - 1, Math.ceil(y + radius + 1));

  if (maxX < minX || maxY < minY) return;

  if (!state.maskBounds) {
    state.maskBounds = { minX, minY, maxX, maxY };
    return;
  }

  if (minX < state.maskBounds.minX) state.maskBounds.minX = minX;
  if (minY < state.maskBounds.minY) state.maskBounds.minY = minY;
  if (maxX > state.maskBounds.maxX) state.maskBounds.maxX = maxX;
  if (maxY > state.maskBounds.maxY) state.maskBounds.maxY = maxY;
}

function getTrackedMaskBounds(padding) {
  if (!state.maskBounds) return { hasMask: false, bounds: null };

  const w = canvasMask.width;
  const h = canvasMask.height;
  const minX = Math.max(0, state.maskBounds.minX - padding);
  const minY = Math.max(0, state.maskBounds.minY - padding);
  const maxX = Math.min(w - 1, state.maskBounds.maxX + padding);
  const maxY = Math.min(h - 1, state.maskBounds.maxY + padding);

  if (maxX < minX || maxY < minY) return { hasMask: false, bounds: null };
  return {
    hasMask: true,
    bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

function stampBrushAt(x, y) {
  ctxMask.beginPath();
  ctxMask.arc(x, y, state.brushSize, 0, Math.PI * 2);
  ctxMask.fill();
  updateTrackedMaskBounds(x, y, state.brushSize);
}

function drawBrush(e) {
  const rect = canvasMask.getBoundingClientRect();
  const scaleX = canvasMask.width / rect.width;
  const scaleY = canvasMask.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top)  * scaleY;

  // Keep mask fully opaque to ensure deterministic extraction.
  ctxMask.globalCompositeOperation = 'source-over';
  ctxMask.fillStyle = 'rgba(255, 60, 60, 1.0)';

  const prev = state.lastBrushPoint;
  if (!prev) {
    stampBrushAt(x, y);
    state.lastBrushPoint = { x, y };
    return;
  }

  const dx = x - prev.x;
  const dy = y - prev.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.max(1, state.brushSize * 0.35);
  const steps = Math.max(1, Math.ceil(dist / step));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stampBrushAt(prev.x + dx * t, prev.y + dy * t);
  }

  state.lastBrushPoint = { x, y };
}

function updateCursorOverlay() {
  const screenRadius = state.brushSize * state.zoom;
  const size = Math.round(screenRadius * 2);
  const half = Math.round(screenRadius);
  const cacheKey = `${size}-${half}`;
  if (brushCursorCacheKey === cacheKey) return;

  const r = Math.max(1, half - 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${half}" cy="${half}" r="${r}" fill="none" stroke="white" stroke-width="1.5" opacity="0.8"/>` +
    `<circle cx="${half}" cy="${half}" r="${r}" fill="none" stroke="black" stroke-width="0.5" opacity="0.4"/>` +
    `</svg>`;
  const encoded = encodeURIComponent(svg);
  canvasMask.style.cursor = `url("data:image/svg+xml,${encoded}") ${half} ${half}, crosshair`;
  brushCursorCacheKey = cacheKey;
}

function clearMask() {
  ctxMask.clearRect(0, 0, canvasMask.width, canvasMask.height);
  state.lastBrushPoint = null;
  resetTrackedMaskBounds();
}
btnClearMask.addEventListener('click', clearMask);

function buildMaskAndBounds(padding) {
  const w = canvasMask.width;
  const h = canvasMask.height;
  const data = ctxMask.getImageData(0, 0, w, h).data;
  const maskMat = new cv.Mat(h, w, cv.CV_8UC1);
  const mask = maskMat.data;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let hasMask = false;

  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    const alpha = data[i + 3];
    const masked = alpha > 0 ? 255 : 0;
    mask[px] = masked;
    if (!masked) continue;

    hasMask = true;
    const x = px % w;
    const y = (px / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (!hasMask) {
    maskMat.delete();
    return { hasMask: false, maskMat: null, bounds: null };
  }

  const rawBounds = { minX, minY, maxX, maxY };
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(w - 1, maxX + padding);
  maxY = Math.min(h - 1, maxY + padding);

  return {
    hasMask: true,
    maskMat,
    bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    rawBounds,
  };
}

function buildRoiMaskFromBounds(bounds) {
  const data = ctxMask.getImageData(bounds.x, bounds.y, bounds.w, bounds.h).data;
  const roiMask = new cv.Mat(bounds.h, bounds.w, cv.CV_8UC1);
  let hasMask = false;

  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    const masked = data[i + 3] > 0 ? 255 : 0;
    roiMask.data[px] = masked;
    if (masked) hasMask = true;
  }

  if (!hasMask) {
    roiMask.delete();
    return null;
  }
  return roiMask;
}

function toOdd(n) {
  return n % 2 === 0 ? n + 1 : n;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function computeDynamicRoiPadding(baseRadius) {
  const basePad = Math.max(12, Math.round(baseRadius * 3));
  if (!state.maskBounds) return basePad;

  const rawW = Math.max(1, state.maskBounds.maxX - state.maskBounds.minX + 1);
  const rawH = Math.max(1, state.maskBounds.maxY - state.maskBounds.minY + 1);
  const area = rawW * rawH;
  const areaBoost = Math.round(Math.sqrt(area) * 0.16);
  const aspect = Math.max(rawW, rawH) / Math.max(1, Math.min(rawW, rawH));
  const aspectBoost = aspect > 2 ? Math.round(baseRadius * 1.4) : 0;
  const maxPad = Math.max(basePad, 140);

  return Math.min(maxPad, basePad + areaBoost + aspectBoost);
}

function cleanupMaskComponents(maskMat, brushSize) {
  const src = maskMat.clone();
  const cleaned = cv.Mat.zeros(maskMat.rows, maskMat.cols, cv.CV_8UC1);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const inv = new cv.Mat();
  const holeContours = new cv.MatVector();
  const holeHierarchy = new cv.Mat();

  try {
    const roiPixels = Math.max(1, src.rows * src.cols);
    const maskPixels = cv.countNonZero(src);
    const fillRatio = maskPixels / roiPixels;

    // Adaptive thresholds from brush scale + current mask area.
    const baseMinArea = brushSize * brushSize * 0.16;
    const densityScale = fillRatio < 0.02 ? 0.78 : (fillRatio > 0.18 ? 1.35 : 1);
    const areaBoost = clamp(Math.sqrt(maskPixels) * 0.06, 0, 36);
    const minAreaCap = Math.max(6, Math.round(maskPixels * 0.22));
    const minArea = clamp(
      Math.round(baseMinArea * densityScale + areaBoost),
      4,
      minAreaCap
    );
    const holeCap = Math.max(8, Math.round(maskPixels * 0.08));
    const maxHoleArea = clamp(
      Math.round(minArea * (fillRatio > 0.1 ? 1.0 : 0.7)),
      3,
      holeCap
    );

    cv.findContours(src, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      contour.delete();
      if (area >= minArea) {
        cv.drawContours(cleaned, contours, i, new cv.Scalar(255), -1, cv.LINE_8);
      }
    }

    // Fill tiny enclosed holes while keeping true background connected to borders.
    cv.bitwise_not(cleaned, inv);
    cv.findContours(inv, holeContours, holeHierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < holeContours.size(); i++) {
      const contour = holeContours.get(i);
      const area = cv.contourArea(contour);
      const rect = cv.boundingRect(contour);
      contour.delete();

      const touchesBorder =
        rect.x <= 0 ||
        rect.y <= 0 ||
        rect.x + rect.width >= cleaned.cols ||
        rect.y + rect.height >= cleaned.rows;

      if (!touchesBorder && area <= maxHoleArea) {
        cv.drawContours(cleaned, holeContours, i, new cv.Scalar(255), -1, cv.LINE_8);
      }
    }

    cleaned.copyTo(maskMat);
  } finally {
    src.delete();
    cleaned.delete();
    contours.delete();
    hierarchy.delete();
    inv.delete();
    holeContours.delete();
    holeHierarchy.delete();
  }
}

function protectMaskNearEdges(maskMat, referenceRgba, brushSize) {
  if (!referenceRgba || referenceRgba.rows !== maskMat.rows || referenceRgba.cols !== maskMat.cols) {
    return;
  }

  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const edgeBand = new cv.Mat();
  const edgeOverlap = new cv.Mat();
  const erodedMask = new cv.Mat();
  const nonEdge = new cv.Mat();
  const offEdgeMask = new cv.Mat();
  const onEdgeCore = new cv.Mat();
  const protectedMask = new cv.Mat();
  let edgeKernel = null;
  let erodeKernel = null;

  try {
    const srcCount = cv.countNonZero(maskMat);
    if (srcCount < 24) return;

    cv.cvtColor(referenceRgba, gray, cv.COLOR_RGBA2GRAY);
    const c1 = Math.max(20, Math.round(brushSize * 4.2));
    const c2 = Math.max(42, c1 * 2);
    cv.Canny(gray, edges, c1, c2);

    const edgeK = Math.max(3, Math.min(15, toOdd(Math.round(brushSize * 0.55))));
    edgeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(edgeK, edgeK));
    cv.dilate(edges, edgeBand, edgeKernel, new cv.Point(-1, -1), 1);

    cv.bitwise_and(maskMat, edgeBand, edgeOverlap);
    const overlapRatio = cv.countNonZero(edgeOverlap) / Math.max(1, srcCount);
    if (overlapRatio < 0.04) return;

    const erodeScale = clamp(0.42 + overlapRatio * 1.4, 0.42, 0.92);
    const erodeK = Math.max(3, Math.min(11, toOdd(Math.round(brushSize * erodeScale))));
    erodeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(erodeK, erodeK));
    cv.erode(maskMat, erodedMask, erodeKernel, new cv.Point(-1, -1), 1);

    cv.bitwise_not(edgeBand, nonEdge);
    cv.bitwise_and(maskMat, nonEdge, offEdgeMask);
    cv.bitwise_and(erodedMask, edgeBand, onEdgeCore);
    cv.bitwise_or(offEdgeMask, onEdgeCore, protectedMask);

    const protectedCount = cv.countNonZero(protectedMask);
    const keepRatio = protectedCount / Math.max(1, srcCount);
    if (keepRatio >= 0.58) {
      protectedMask.copyTo(maskMat);
    }
  } finally {
    gray.delete();
    edges.delete();
    edgeBand.delete();
    edgeOverlap.delete();
    erodedMask.delete();
    nonEdge.delete();
    offEdgeMask.delete();
    onEdgeCore.delete();
    protectedMask.delete();
    if (edgeKernel) edgeKernel.delete();
    if (erodeKernel) erodeKernel.delete();
  }
}

function preprocessInpaintMask(maskMat, brushSize, referenceRgba = null) {
  const processed = maskMat.clone();
  let closeKernel = null;
  let dilateKernel = null;

  try {
    const closeSize = Math.max(3, Math.min(9, toOdd(Math.round(brushSize * 0.35))));
    closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(closeSize, closeSize));
    cv.morphologyEx(processed, processed, cv.MORPH_CLOSE, closeKernel);

    if (brushSize >= 8) {
      dilateKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      cv.dilate(processed, processed, dilateKernel, new cv.Point(-1, -1), 1);
    }

    if (referenceRgba) {
      protectMaskNearEdges(processed, referenceRgba, brushSize);
    }

    cleanupMaskComponents(processed, brushSize);
  } finally {
    if (closeKernel) closeKernel.delete();
    if (dilateKernel) dilateKernel.delete();
  }

  return processed;
}

function estimateAdaptiveInpaintRadius(maskMat, baseRadius) {
  const dist = new cv.Mat();
  try {
    cv.distanceTransform(maskMat, dist, cv.DIST_L2, 3);
    const { maxVal } = cv.minMaxLoc(dist);
    const blended = Math.round(baseRadius * 0.65 + maxVal * 0.35);
    const maxRadius = Math.max(baseRadius, Math.round(baseRadius * 1.8));
    return Math.max(2, Math.min(maxRadius, blended));
  } catch (_) {
    return baseRadius;
  } finally {
    dist.delete();
  }
}

function blendRoiWithFeather(inpaintedRgba, originalRgba, mask8u, featherPx) {
  const alpha = new cv.Mat();
  const alphaBlur = new cv.Mat();
  const alphaEdge = new cv.Mat();
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const edgeWeight = new cv.Mat();
  const invEdgeWeight = new cv.Mat();
  const edgeMixA = new cv.Mat();
  const edgeMixB = new cv.Mat();
  const ones1 = new cv.Mat();
  const alpha4 = new cv.Mat();
  const dstF = new cv.Mat();
  const srcF = new cv.Mat();
  const partA = new cv.Mat();
  const partB = new cv.Mat();
  const ones = new cv.Mat();
  const oneMinus = new cv.Mat();
  const blendF = new cv.Mat();
  const blended = new cv.Mat();
  const channels = new cv.MatVector();
  let edgeKernel = null;

  try {
    mask8u.convertTo(alpha, cv.CV_32FC1, 1 / 255);

    // Edge-aware: near strong edges, pull alpha back toward hard mask to avoid halo.
    cv.cvtColor(originalRgba, gray, cv.COLOR_RGBA2GRAY);
    const c1 = Math.max(24, Math.round(featherPx * 5));
    const c2 = Math.max(48, c1 * 2);
    cv.Canny(gray, edges, c1, c2);
    const rawEdgeDensity = cv.countNonZero(edges) / Math.max(1, edges.rows * edges.cols);
    const edgeKScale = clamp(1.55 - rawEdgeDensity * 3.2, 0.95, 1.55);
    const edgeK = Math.max(3, toOdd(Math.round(featherPx * edgeKScale)));
    edgeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(edgeK, edgeK));
    cv.dilate(edges, edges, edgeKernel, new cv.Point(-1, -1), 1);

    const edgeDensity = cv.countNonZero(edges) / Math.max(1, edges.rows * edges.cols);
    const blurScale = clamp(1.75 - edgeDensity * 3.4, 0.9, 1.75);
    const blurKernel = Math.max(3, toOdd(Math.round(featherPx * blurScale)));
    cv.GaussianBlur(alpha, alphaBlur, new cv.Size(blurKernel, blurKernel), 0, 0, cv.BORDER_DEFAULT);

    const edgeHardness = clamp(0.5 + edgeDensity * 2.8, 0.5, 0.9);
    edges.convertTo(edgeWeight, cv.CV_32FC1, edgeHardness / 255);
    ones1.create(edgeWeight.rows, edgeWeight.cols, cv.CV_32FC1);
    ones1.setTo(new cv.Scalar(1));
    cv.subtract(ones1, edgeWeight, invEdgeWeight);
    cv.multiply(alphaBlur, invEdgeWeight, edgeMixA);
    cv.multiply(alpha, edgeWeight, edgeMixB);
    cv.add(edgeMixA, edgeMixB, alphaEdge);

    channels.push_back(alphaEdge);
    channels.push_back(alphaEdge);
    channels.push_back(alphaEdge);
    channels.push_back(alphaEdge);
    cv.merge(channels, alpha4);

    inpaintedRgba.convertTo(dstF, cv.CV_32FC4);
    originalRgba.convertTo(srcF, cv.CV_32FC4);

    cv.multiply(dstF, alpha4, partA);
    ones.create(alpha4.rows, alpha4.cols, cv.CV_32FC4);
    ones.setTo(new cv.Scalar(1, 1, 1, 1));
    cv.subtract(ones, alpha4, oneMinus);
    cv.multiply(srcF, oneMinus, partB);
    cv.add(partA, partB, blendF);
    blendF.convertTo(blended, cv.CV_8UC4);
    return blended;
  } catch (_) {
    return inpaintedRgba.clone();
  } finally {
    alpha.delete();
    alphaBlur.delete();
    alphaEdge.delete();
    gray.delete();
    edges.delete();
    edgeWeight.delete();
    invEdgeWeight.delete();
    edgeMixA.delete();
    edgeMixB.delete();
    ones1.delete();
    alpha4.delete();
    dstF.delete();
    srcF.delete();
    partA.delete();
    partB.delete();
    ones.delete();
    oneMinus.delete();
    blendF.delete();
    channels.delete();
    if (edgeKernel) edgeKernel.delete();
  }
}

// ============================================================
// Inpaint 核心 — ROI 裁剪 + 分步进度条
// ============================================================
function evaluateSeamQualityScore(blendedRgba, originalRgba, mask8u, featherPx) {
  const dilated = new cv.Mat();
  const eroded = new cv.Mat();
  const seamBand = new cv.Mat();
  const outsideBand = new cv.Mat();
  const diff4 = new cv.Mat();
  const diffGray = new cv.Mat();
  const srcGray = new cv.Mat();
  const outGray = new cv.Mat();
  const srcEdges = new cv.Mat();
  const outEdges = new cv.Mat();
  const edgeDelta = new cv.Mat();
  let bandKernel = null;

  try {
    if (cv.countNonZero(mask8u) === 0) return 0;

    const bandK = Math.max(3, Math.min(21, toOdd(Math.round(featherPx * 1.5))));
    bandKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(bandK, bandK));
    cv.dilate(mask8u, dilated, bandKernel, new cv.Point(-1, -1), 1);
    cv.erode(mask8u, eroded, bandKernel, new cv.Point(-1, -1), 1);
    cv.subtract(dilated, eroded, seamBand);
    cv.subtract(dilated, mask8u, outsideBand);

    const seamCount = cv.countNonZero(seamBand);
    if (seamCount === 0) return 0;

    cv.absdiff(blendedRgba, originalRgba, diff4);
    cv.cvtColor(diff4, diffGray, cv.COLOR_RGBA2GRAY);
    const seamColorDelta = cv.mean(diffGray, seamBand)[0];

    const outsideCount = cv.countNonZero(outsideBand);
    const outsideColorDelta = outsideCount > 0 ? cv.mean(diffGray, outsideBand)[0] : 0;
    cv.cvtColor(originalRgba, srcGray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(blendedRgba, outGray, cv.COLOR_RGBA2GRAY);
    const c1 = Math.max(16, Math.round(featherPx * 4.2));
    const c2 = Math.max(34, c1 * 2);
    cv.Canny(srcGray, srcEdges, c1, c2);
    cv.Canny(outGray, outEdges, c1, c2);
    cv.absdiff(srcEdges, outEdges, edgeDelta);
    const seamEdgeDelta = cv.mean(edgeDelta, seamBand)[0];

    const colorScore = clamp(seamColorDelta / 22, 0, 1);
    const edgeScore = clamp(seamEdgeDelta / 42, 0, 1);
    const leakScore = clamp(outsideColorDelta / 18, 0, 1);
    return clamp(colorScore * 0.45 + edgeScore * 0.35 + leakScore * 0.2, 0, 1);
  } catch (_) {
    return 0;
  } finally {
    dilated.delete();
    eroded.delete();
    seamBand.delete();
    outsideBand.delete();
    diff4.delete();
    diffGray.delete();
    srcGray.delete();
    outGray.delete();
    srcEdges.delete();
    outEdges.delete();
    edgeDelta.delete();
    if (bandKernel) bandKernel.delete();
  }
}

function harmonizeRoiLab(inpaintedRgba, originalRgba, mask8u, brushSize) {
  const inpaintRgb = new cv.Mat();
  const originalRgb = new cv.Mat();
  const inpaintLab = new cv.Mat();
  const originalLab = new cv.Mat();
  const ringDilated = new cv.Mat();
  const ringMask = new cv.Mat();
  const invMask = new cv.Mat();
  const alpha = new cv.Mat();
  const alphaBlur = new cv.Mat();
  const alpha3 = new cv.Mat();
  const labBaseF = new cv.Mat();
  const labShiftedF = new cv.Mat();
  const shiftedPart = new cv.Mat();
  const basePart = new cv.Mat();
  const ones = new cv.Mat();
  const invAlpha3 = new cv.Mat();
  const labBlendF = new cv.Mat();
  const labBlend8 = new cv.Mat();
  const rgbOut = new cv.Mat();
  const rgbaOut = new cv.Mat();
  const alphaChannels = new cv.MatVector();
  const contextMean = new cv.Mat();
  const contextStd = new cv.Mat();
  let ringKernel = null;

  try {
    if (cv.countNonZero(mask8u) === 0) return inpaintedRgba.clone();

    cv.cvtColor(inpaintedRgba, inpaintRgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(originalRgba, originalRgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(inpaintRgb, inpaintLab, cv.COLOR_RGB2Lab);
    cv.cvtColor(originalRgb, originalLab, cv.COLOR_RGB2Lab);

    const ringKernelSize = Math.max(3, Math.min(31, toOdd(Math.round(brushSize * 1.8))));
    ringKernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(ringKernelSize, ringKernelSize)
    );
    cv.dilate(mask8u, ringDilated, ringKernel, new cv.Point(-1, -1), 1);
    cv.bitwise_not(mask8u, invMask);
    cv.bitwise_and(ringDilated, invMask, ringMask);

    const srcCount = cv.countNonZero(mask8u);
    const minRingCount = Math.max(80, Math.round(srcCount * 0.35));
    const ringCount = cv.countNonZero(ringMask);
    const contextMask = ringCount >= minRingCount ? ringMask : invMask;

    const contextCount = cv.countNonZero(contextMask);
    if (contextCount === 0) return inpaintedRgba.clone();

    const srcMean = cv.mean(inpaintLab, mask8u);
    const dstMean = cv.mean(originalLab, contextMask);
    cv.meanStdDev(originalLab, contextMean, contextStd, contextMask);

    const stdData = contextStd.data64F || [];
    const stdL = stdData.length > 0 ? stdData[0] : 0;
    const stdA = stdData.length > 1 ? stdData[1] : 0;
    const stdB = stdData.length > 2 ? stdData[2] : 0;
    const chromaStd = (stdA + stdB) * 0.5;
    const varianceConfidence = clamp(
      1 - (stdL / 95 + chromaStd / 60) * 0.5,
      0.4,
      1
    );
    const ringCoverage = clamp(ringCount / Math.max(1, minRingCount), 0, 1.2);
    const contextCoverage = clamp(contextCount / Math.max(1, srcCount * 2.2), 0, 1);
    const sampleConfidence = clamp(
      (Math.min(1, ringCoverage) * 0.5 + contextCoverage * 0.5) * varianceConfidence,
      0.25,
      1
    );

    const blendStrength = clamp(0.35 + sampleConfidence * 0.65, 0.35, 1);
    const maxLShift = 8 + sampleConfidence * 18;
    const maxCShift = 5 + sampleConfidence * 11;
    const dL = clamp((dstMean[0] - srcMean[0]) * blendStrength, -maxLShift, maxLShift);
    const dA = clamp((dstMean[1] - srcMean[1]) * blendStrength, -maxCShift, maxCShift);
    const dB = clamp((dstMean[2] - srcMean[2]) * blendStrength, -maxCShift, maxCShift);

    inpaintLab.convertTo(labBaseF, cv.CV_32FC3);
    cv.add(labBaseF, new cv.Scalar(dL, dA, dB, 0), labShiftedF);

    mask8u.convertTo(alpha, cv.CV_32FC1, 1 / 255);
    const alphaKernel = Math.max(3, Math.min(31, toOdd(Math.round(brushSize * 1.2))));
    cv.GaussianBlur(alpha, alphaBlur, new cv.Size(alphaKernel, alphaKernel), 0, 0, cv.BORDER_DEFAULT);

    alphaChannels.push_back(alphaBlur);
    alphaChannels.push_back(alphaBlur);
    alphaChannels.push_back(alphaBlur);
    cv.merge(alphaChannels, alpha3);

    ones.create(alpha3.rows, alpha3.cols, cv.CV_32FC3);
    ones.setTo(new cv.Scalar(1, 1, 1));
    cv.subtract(ones, alpha3, invAlpha3);
    cv.multiply(labShiftedF, alpha3, shiftedPart);
    cv.multiply(labBaseF, invAlpha3, basePart);
    cv.add(shiftedPart, basePart, labBlendF);
    labBlendF.convertTo(labBlend8, cv.CV_8UC3);

    cv.cvtColor(labBlend8, rgbOut, cv.COLOR_Lab2RGB);
    cv.cvtColor(rgbOut, rgbaOut, cv.COLOR_RGB2RGBA);
    return rgbaOut;
  } catch (_) {
    return inpaintedRgba.clone();
  } finally {
    inpaintRgb.delete();
    originalRgb.delete();
    inpaintLab.delete();
    originalLab.delete();
    ringDilated.delete();
    ringMask.delete();
    invMask.delete();
    alpha.delete();
    alphaBlur.delete();
    alpha3.delete();
    labBaseF.delete();
    labShiftedF.delete();
    shiftedPart.delete();
    basePart.delete();
    ones.delete();
    invAlpha3.delete();
    labBlendF.delete();
    labBlend8.delete();
    rgbOut.delete();
    alphaChannels.delete();
    contextMean.delete();
    contextStd.delete();
    if (ringKernel) ringKernel.delete();
  }
}

btnInpaint.addEventListener('click', runInpaint);

/**
 * 从蒙版中提取有效区域的 bounding box
 * 返回 { x, y, w, h, hasMask } — 已含 padding
 */
function runInpaint() {
  if (!state.cvReady) {
    setStatus('⏳ OpenCV.js 尚未加载完成，请稍候…');
    return;
  }
  if (!state.imageLoaded) return;

  const algoMode = algoSelect.value;
  let algo = algoMode === 'ns' ? cv.INPAINT_NS : cv.INPAINT_TELEA;
  let algoLabel = algoMode === 'ns' ? 'Navier-Stokes' : 'Telea';
  const baseInpaintRadius = Math.max(3, Math.round(state.brushSize * 0.5));
  let inpaintRadius = baseInpaintRadius;
  let detailInpaintRadius = baseInpaintRadius;

  // 计算蒙版 bounding box，padding = inpaintRadius * 3 让边缘过渡自然
  const roiPad = computeDynamicRoiPadding(baseInpaintRadius);
  const trackedMaskInfo = getTrackedMaskBounds(roiPad);
  let fullScanMaskInfo = null;
  let bounds = null;

  if (trackedMaskInfo.hasMask) {
    bounds = trackedMaskInfo.bounds;
  } else {
    fullScanMaskInfo = buildMaskAndBounds(roiPad);
    if (!fullScanMaskInfo.hasMask) {
      setStatus('⚠️ 请先用画笔涂抹需要修复的区域');
      return;
    }
    bounds = fullScanMaskInfo.bounds;
    if (fullScanMaskInfo.rawBounds) {
      state.maskBounds = { ...fullScanMaskInfo.rawBounds };
    }
  }

  let roiMaskClone = buildRoiMaskFromBounds(bounds);
  if (!roiMaskClone) {
    if (!fullScanMaskInfo) fullScanMaskInfo = buildMaskAndBounds(roiPad);
    if (!fullScanMaskInfo.hasMask) {
      setStatus('⚠️ 请先用画笔涂抹需要修复的区域');
      return;
    }
    bounds = fullScanMaskInfo.bounds;
    if (fullScanMaskInfo.rawBounds) {
      state.maskBounds = { ...fullScanMaskInfo.rawBounds };
    }
    const maskRoiView = fullScanMaskInfo.maskMat.roi(
      new cv.Rect(bounds.x, bounds.y, bounds.w, bounds.h)
    );
    roiMaskClone = maskRoiView.clone();
    maskRoiView.delete();
  }

  if (fullScanMaskInfo && fullScanMaskInfo.maskMat) {
    fullScanMaskInfo.maskMat.delete();
    fullScanMaskInfo.maskMat = null;
  }

  const fullW = canvasMain.width, fullH = canvasMain.height;
  const roiPixels = bounds.w * bounds.h;
  const fullPixels = fullW * fullH;

  setStatus('🔄 正在修复…');
  showProgress(0, '准备中…');
  btnInpaint.disabled = true;

  // 临时变量
  const work = {};
  work.roiMaskClone = roiMaskClone;

  const steps = [
    { pct: 10,  label: `定位修复区域 (${bounds.w}×${bounds.h})…`, fn: () => {
      // 读取全图
      if (!state.srcMat) state.srcMat = cv.imread(canvasMain);
      work.fullSrc = state.srcMat.clone();
    }},
    { pct: 25,  label: '裁剪 ROI…', fn: () => {
      // 裁剪 ROI
      const roi = new cv.Rect(bounds.x, bounds.y, bounds.w, bounds.h);
      work.roiSrc4 = work.fullSrc.roi(roi);

      // RGBA → RGB
      work.roiSrc3 = new cv.Mat();
      cv.cvtColor(work.roiSrc4, work.roiSrc3, cv.COLOR_RGBA2RGB);
      work.roiMaskPrepared = preprocessInpaintMask(work.roiMaskClone, state.brushSize, work.roiSrc4);
      inpaintRadius = estimateAdaptiveInpaintRadius(work.roiMaskPrepared, baseInpaintRadius);
      const nonZero = cv.countNonZero(work.roiMaskPrepared);
      const total = Math.max(1, bounds.w * bounds.h);
      work.maskFillRatio = nonZero / total;
      const detailScale = clamp(0.58 + work.maskFillRatio * 0.45, 0.58, 0.86);
      detailInpaintRadius = Math.max(
        2,
        Math.min(inpaintRadius, Math.round(inpaintRadius * detailScale))
      );
      const coarseScale = clamp(1 + work.maskFillRatio * 0.32, 1, 1.22);
      inpaintRadius = Math.max(
        detailInpaintRadius,
        Math.round(inpaintRadius * coarseScale)
      );

      if (algoMode === 'auto') {
        const fillRatio = work.maskFillRatio;
        const aspect = Math.max(bounds.w, bounds.h) / Math.max(1, Math.min(bounds.w, bounds.h));
        const useNs = fillRatio < 0.14 && aspect > 2.4;
        algo = useNs ? cv.INPAINT_NS : cv.INPAINT_TELEA;
        algoLabel = useNs ? 'Navier-Stokes(auto)' : 'Telea(auto)';
      }

      // 复制 mask ROI（roi() 返回的是视图，inpaint 需要连续内存）
    }},
    { pct: 40,  label: `执行 Inpaint (${Math.round(roiPixels/1000)}K 像素, 节省 ${Math.round((1 - roiPixels/fullPixels)*100)}%)…`, fn: () => {
      work.roiPass1 = new cv.Mat();
      cv.inpaint(
        work.roiSrc3,
        work.roiMaskPrepared,
        work.roiPass1,
        detailInpaintRadius,
        algo
      );
      work.roiDst = new cv.Mat();
      if (inpaintRadius > detailInpaintRadius) {
        cv.inpaint(work.roiPass1, work.roiMaskPrepared, work.roiDst, inpaintRadius, algo);
      } else {
        work.roiPass1.copyTo(work.roiDst);
      }
    }},
    { pct: 75,  label: '合并结果…', fn: () => {
      // RGB → RGBA
      work.roiDst4 = new cv.Mat();
      cv.cvtColor(work.roiDst, work.roiDst4, cv.COLOR_RGB2RGBA);
      work.roiHarmonized4 = harmonizeRoiLab(
        work.roiDst4,
        work.roiSrc4,
        work.roiMaskPrepared,
        state.brushSize
      );
      work.roiBlend4 = blendRoiWithFeather(
        work.roiHarmonized4,
        work.roiSrc4,
        work.roiMaskPrepared,
        inpaintRadius
      );

      // 将 ROI 结果写回全图
      const primarySeamScore = evaluateSeamQualityScore(
        work.roiBlend4,
        work.roiSrc4,
        work.roiMaskPrepared,
        inpaintRadius
      );
      if (primarySeamScore > 0.52) {
        const conservativeBrush = Math.max(2, Math.round(state.brushSize * 0.72));
        const conservativeFeather = Math.max(2, Math.round(inpaintRadius * 0.72));
        work.roiFallbackHarmonized4 = harmonizeRoiLab(
          work.roiDst4,
          work.roiSrc4,
          work.roiMaskPrepared,
          conservativeBrush
        );
        work.roiFallbackBlend4 = blendRoiWithFeather(
          work.roiFallbackHarmonized4,
          work.roiSrc4,
          work.roiMaskPrepared,
          conservativeFeather
        );
        const fallbackSeamScore = evaluateSeamQualityScore(
          work.roiFallbackBlend4,
          work.roiSrc4,
          work.roiMaskPrepared,
          conservativeFeather
        );
        const improvedEnough = fallbackSeamScore + 0.03 < primarySeamScore;
        const severePrimary = primarySeamScore >= 0.66 && fallbackSeamScore <= primarySeamScore;
        if (improvedEnough || severePrimary) {
          work.roiBlend4.delete();
          work.roiBlend4 = work.roiFallbackBlend4.clone();
        }
      }

      const dstRegion = work.fullSrc.roi(new cv.Rect(bounds.x, bounds.y, bounds.w, bounds.h));
      work.roiBlend4.copyTo(dstRegion);
      dstRegion.delete();
    }},
    { pct: 90,  label: '显示结果…', fn: () => {
      cv.imshow(canvasMain, work.fullSrc);

      if (state.srcMat) state.srcMat.delete();
      state.srcMat = work.fullSrc.clone();

      pushHistory();
      clearMask();
    }},
  ];

  let i = 0;
  function next() {
    if (i >= steps.length) {
      // 清理所有临时 Mat
      ['fullSrc','roiSrc4','roiSrc3','roiMaskClone','roiMaskPrepared','roiPass1','roiDst','roiDst4','roiHarmonized4','roiFallbackHarmonized4','roiBlend4','roiFallbackBlend4']
        .forEach(k => { try { work[k] && work[k].delete(); } catch(_){} });

      showProgress(100, '修复完成');
      setTimeout(() => { hideProgress(); setStatus(`✅ 修复完成 (${algoLabel}, r=${inpaintRadius})`); }, 350);
      btnInpaint.disabled = false;
      updateHistoryButtons();
      return;
    }
    const step = steps[i++];
    showProgress(step.pct, step.label);
    setTimeout(() => {
      try {
        step.fn();
        next();
      } catch (err) {
        let msg = err.message || '';
        if (typeof err === 'number') {
          try { msg = cv.exceptionFromPtr(err).msg; } catch (_) { msg = 'OpenCV 内部错误'; }
        }
        console.error('[Inpaint Error]', msg, err);
        setStatus('❌ 修复失败: ' + msg);
        hideProgress();
        ['fullSrc','roiSrc4','roiSrc3','roiMaskClone','roiMaskPrepared','roiPass1','roiDst','roiDst4','roiHarmonized4','roiFallbackHarmonized4','roiBlend4','roiFallbackBlend4']
          .forEach(k => { try { work[k] && work[k].delete(); } catch(_){} });
        btnInpaint.disabled = false;
      }
    }, 30);  // 30ms 间隔让浏览器有时间更新进度条
  }
  next();
}

function updateHistoryButtons() {
  btnUndo.disabled = state.history.length <= 1;
}
function pushHistory() {
  const imgData = ctxMain.getImageData(0, 0, canvasMain.width, canvasMain.height);
  const snapshot = { imgData, bytes: imgData.data.byteLength };
  state.history.push(snapshot);
  state.historyBytes += snapshot.bytes;
  while (
    state.history.length > 1 &&
    (state.history.length > state.maxHistory || state.historyBytes > state.maxHistoryBytes)
  ) {
    const removed = state.history.shift();
    state.historyBytes -= removed.bytes;
  }
  updateHistoryButtons();
}

btnUndo.addEventListener('click', () => {
  if (state.history.length <= 1) return;
  const current = state.history.pop(); // 弹出当前
  state.historyBytes -= current.bytes;
  const prev = state.history[state.history.length - 1];
  ctxMain.putImageData(prev.imgData, 0, 0);

  // 同步 srcMat
  if (state.srcMat) state.srcMat.delete();
  state.srcMat = cv.imread(canvasMain);

  clearMask();
  updateHistoryButtons();
  setStatus('↩ 已撤销');
});

btnSave.addEventListener('click', () => {
  canvasMain.toBlob((blob) => {
    if (!blob) {
      setStatus('❌ 导出失败，请重试');
      return;
    }
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.download = 'flaw-broom-result.png';
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('💾 图片已保存');
  }, 'image/png');
});

function setStatus(msg) {
  statusText.textContent = msg;
}

function applyTransform() {
  canvasWrapper.style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  statusDims.textContent = state.imageLoaded
    ? `${canvasMain.width} × ${canvasMain.height} | ${Math.round(state.zoom * 100)}%`
    : '';
  if (!spaceHeld && !state.panning && state.imageLoaded) updateCursorOverlay();
}

// 滚轮缩放 (以鼠标位置为中心)
canvasArea.addEventListener('wheel', (e) => {
  if (!state.imageLoaded) return;
  e.preventDefault();

  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = Math.min(state.zoomMax, Math.max(state.zoomMin, state.zoom * delta));

  // 以鼠标位置为缩放中心
  const rect = canvasArea.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  // 调整平移，使缩放中心不变
  state.panX = mx - (mx - state.panX) * (newZoom / state.zoom);
  state.panY = my - (my - state.panY) * (newZoom / state.zoom);
  state.zoom = newZoom;

  applyTransform();
}, { passive: false });

// 中键拖拽平移
canvasArea.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    startPan(e);
  }
});

// ---- 键盘状态 ----
let spaceHeld = false;
const keysHeld = new Set();
const PAN_SPEED = 8;
let keyPanRAF = null;

// WASD / 方向键 持续平移
const PAN_KEYS = {
  'KeyW': [0, 1], 'ArrowUp':    [0, 1],
  'KeyS': [0, -1], 'ArrowDown':  [0, -1],
  'KeyA': [1, 0], 'ArrowLeft':  [1, 0],
  'KeyD': [-1, 0], 'ArrowRight': [-1, 0],
};

function keyPanLoop() {
  if (keysHeld.size === 0) { keyPanRAF = null; return; }
  let dx = 0, dy = 0;
  for (const code of keysHeld) {
    const dir = PAN_KEYS[code];
    if (dir) { dx += dir[0]; dy += dir[1]; }
  }
  if (dx !== 0 || dy !== 0) {
    state.panX += dx * PAN_SPEED;
    state.panY += dy * PAN_SPEED;
    applyTransform();
  }
  keyPanRAF = requestAnimationFrame(keyPanLoop);
}

document.addEventListener('keydown', (e) => {
  // Space — 拖拽平移模式
  if (e.code === 'Space' && !spaceHeld && state.imageLoaded) {
    e.preventDefault();
    spaceHeld = true;
    brushCursorCacheKey = '';
    canvasMask.style.cursor = 'grab';
  }
  // WASD / 方向键 — 持续平移
  if (PAN_KEYS[e.code] && state.imageLoaded && !e.repeat) {
    e.preventDefault();
    keysHeld.add(e.code);
    if (!keyPanRAF) keyPanRAF = requestAnimationFrame(keyPanLoop);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false;
    brushCursorCacheKey = '';
    if (!state.panning && state.imageLoaded) updateCursorOverlay();
  }
  keysHeld.delete(e.code);
});

// Space + 左键拖拽
canvasMask.addEventListener('mousedown', (e) => {
  if (spaceHeld && e.button === 0) {
    e.preventDefault();
    e.stopPropagation();
    startPan(e);
    return;
  }
}, true);

function startPan(e) {
  state.panning = true;
  state.panStartX = e.clientX - state.panX;
  state.panStartY = e.clientY - state.panY;
  brushCursorCacheKey = '';
  canvasMask.style.cursor = 'grabbing';

  const onMove = (ev) => {
    state.panX = ev.clientX - state.panStartX;
    state.panY = ev.clientY - state.panStartY;
    applyTransform();
  };
  const onUp = () => {
    state.panning = false;
    if (spaceHeld) {
      canvasMask.style.cursor = 'grab';
    } else {
      brushCursorCacheKey = '';
      updateCursorOverlay();
    }
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 双击重置为自适应缩放
canvasArea.addEventListener('dblclick', () => {
  if (state.imageLoaded) zoomToFit();
});
