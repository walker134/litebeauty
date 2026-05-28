/* ================================================================
   LiteBeauty — 主应用逻辑
   功能：图像滤镜 | 人脸检测 | 局部美颜 | 预设管理 | PWA
   ================================================================ */

(function () {
  'use strict';

  // ================================================================
  //  DOM 引用
  // ================================================================
  const canvas       = document.getElementById('canvas');
  const ctx          = canvas.getContext('2d', { willReadFrequently: true });
  const placeholder  = document.getElementById('placeholder');
  const fileInput    = document.getElementById('fileInput');
  const cameraBtn    = document.getElementById('cameraBtn');
  const resetBtn     = document.getElementById('resetBtn');
  const savePresetBtn = document.getElementById('savePresetBtn');
  const presetListContainer = document.getElementById('presetListContainer');
  const installBtn   = document.getElementById('installBtn');
  const video        = document.getElementById('cameraVideo');

  // 基础滑块
  const sliderBrightness = document.getElementById('brightness');
  const sliderContrast   = document.getElementById('contrast');
  const sliderSaturate   = document.getElementById('saturate');
  const valBrightness    = document.getElementById('brightnessVal');
  const valContrast      = document.getElementById('contrastVal');
  const valSaturate      = document.getElementById('saturateVal');

  // 智能美颜
  const smartToggle     = document.getElementById('smartBeautyToggle');
  const smartSliders    = document.getElementById('smartSliders');
  const statusEl        = document.getElementById('detectionStatus');
  const sliderSmoothing = document.getElementById('smoothing');
  const sliderRedEye    = document.getElementById('redEye');
  const valSmoothing    = document.getElementById('smoothingVal');
  const valRedEye       = document.getElementById('redEyeVal');
  const sliderSlimFace  = document.getElementById('slimFace');
  const sliderSmallHead = document.getElementById('smallHead');
  const sliderBigEye    = document.getElementById('bigEye');
  const sliderTeethWhiten = document.getElementById('teethWhiten');
  const valSlimFace     = document.getElementById('slimFaceVal');
  const valSmallHead    = document.getElementById('smallHeadVal');
  const valBigEye       = document.getElementById('bigEyeVal');
  const valTeethWhiten  = document.getElementById('teethWhitenVal');

  // 滤镜
  const filterList        = document.getElementById('filterList');
  const filterStrengthRow = document.getElementById('filterStrengthRow');
  const sliderFilterStr   = document.getElementById('filterStrength');
  const valFilterStr      = document.getElementById('filterStrengthVal');

  // 对比视图
  const compareCanvas  = document.getElementById('compareCanvas');
  const compareCtx     = compareCanvas.getContext('2d');
  const compareBadge   = document.getElementById('compareBadge');
  const compareDivider = document.getElementById('compareDivider');
  const compareModeBtn = document.getElementById('compareModeBtn');
  const canvasWrapper  = canvas.parentElement; // 精确选取 canvas 的直接父容器

  // ================================================================
  //  状态
  // ================================================================
  let sourceImage    = null;
  let stream         = null;
  let faceLandmarks  = null;     // 缓存的 68 关键点 { positions: [{x,y},...] }
  let modelsReady    = false;    // 模型是否就绪（本地或 Worker）
  let detectionStatus = 'idle';
  let installPrompt  = null;     // PWA 安装事件

  // Web Worker 引用
  let detectWorker   = null;
  let workerReady    = false;
  let workerSupported = true;    // 设为 false 则回退主线程检测

  // 当前效果参数 —— 与所有滑块实时同步
  let currentSettings = {
    brightness: 100,
    contrast: 100,
    saturation: 100,
    smoothness: 50,
    redeye: 50,
    slimFace: 0,
    smallHead: 0,
    bigEye: 0,
    teethWhiten: 0
  };

  // 滤镜状态
  let currentFilter = 'none';
  let filterStrength = 100;

  // 预设
  let presets = [];
  const PRESETS_KEY = 'beautyPresets';

  const defaults = {
    brightness: 100, contrast: 100, saturation: 100,
    smoothness: 50, redeye: 50, slimFace: 0, smallHead: 0, bigEye: 0, teethWhiten: 0
  };

  const DEFAULT_PRESETS = [
    { name: '自然', settings: { brightness: 100, contrast: 100, saturation: 100, smoothness: 30, redeye: 0 } },
    { name: '明亮', settings: { brightness: 115, contrast: 105, saturation: 110, smoothness: 50, redeye: 0 } },
    { name: '柔焦', settings: { brightness: 105, contrast: 95,  saturation: 95,  smoothness: 70, redeye: 0 } }
  ];

  // 渲染节流
  let rafId = null;

  // 历史记录栈（撤销/重做）
  const MAX_HISTORY = 20;
  let historyStack  = [];
  let historyIndex  = -1;

  // 对比视图状态
  let compareMode  = 'press';   // 'press' = 长按对比 | 'slide' = 滑动对比
  let isDragging   = false;
  let dividerPos   = 0.5;      // 分割线位置 (0–1)

  // 离屏 Canvas 复用
  let blurCanvas = null;
  let blurCtx    = null;

  // ── 手动液化状态 ──
  let liquifyActive      = false;   // 液化工具模式是否激活
  let brushSize          = 40;      // 笔刷半径 (px)
  let liquifyStr         = 30;      // 液化强度 (10-50)
  let liquifyStrokes     = [];      // 所有笔画（追加，不截断）[{points, radius, strength}]
  let activeStrokeCount  = 0;       // 当前活跃的笔画数（用于撤销/重做）
  let isBrushing         = false;   // 当前是否正在涂抹
  let currentStrokePts   = [];      // 当前笔画已采集的点
  let currentStrokeEraser = false;  // 当前笔画是否为橡皮擦
  let brushCursorEl      = null;    // 笔刷光标 DOM
  let eraserMode         = false;   // 橡皮擦模式（Alt 键按下）

  // ================================================================
  //  localStorage 安全读写
  // ================================================================
  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      alert('无法保存预设（可能处于隐私模式），请检查浏览器设置。');
      return false;
    }
  }

  // ================================================================
  //  currentSettings ↔ 滑块同步
  // ================================================================
  function syncCurrentSettings() {
    currentSettings.brightness = +sliderBrightness.value;
    currentSettings.contrast   = +sliderContrast.value;
    currentSettings.saturation = +sliderSaturate.value;
    currentSettings.smoothness = +sliderSmoothing.value;
    currentSettings.redeye     = +sliderRedEye.value;
    currentSettings.slimFace   = +sliderSlimFace.value;
    currentSettings.smallHead  = +sliderSmallHead.value;
    currentSettings.bigEye     = +sliderBigEye.value;
    currentSettings.teethWhiten = +sliderTeethWhiten.value;
    filterStrength = +sliderFilterStr.value;
  }

  function applySettings(settings, recordHistory) {
    sliderBrightness.value = settings.brightness;
    sliderContrast.value   = settings.contrast;
    sliderSaturate.value   = settings.saturation;
    sliderSmoothing.value  = settings.smoothness;
    sliderRedEye.value     = settings.redeye;
    sliderSlimFace.value   = settings.slimFace  !== undefined ? settings.slimFace  : 0;
    sliderSmallHead.value  = settings.smallHead !== undefined ? settings.smallHead : 0;
    sliderBigEye.value     = settings.bigEye    !== undefined ? settings.bigEye    : 0;
    sliderTeethWhiten.value = settings.teethWhiten !== undefined ? settings.teethWhiten : 0;

    valBrightness.textContent = settings.brightness + '%';
    valContrast.textContent   = settings.contrast   + '%';
    valSaturate.textContent   = settings.saturation + '%';
    valSmoothing.textContent  = settings.smoothness + '%';
    valRedEye.textContent     = settings.redeye     + '%';
    valSlimFace.textContent   = (settings.slimFace  || 0) + '%';
    valSmallHead.textContent  = (settings.smallHead || 0) + '%';
    valBigEye.textContent     = (settings.bigEye    || 0) + '%';
    valTeethWhiten.textContent = (settings.teethWhiten || 0) + '%';

    currentSettings = { ...settings };
    scheduleRender();

    // recordHistory 默认为 true（预设/重置/撤销等操作）
    if (recordHistory !== false) {
      pushHistory();
    }
  }

  // ================================================================
  //  历史记录栈（撤销 / 重做）
  // ================================================================
  function pushHistory() {
    var snap = {
      brightness: currentSettings.brightness,
      contrast:   currentSettings.contrast,
      saturation: currentSettings.saturation,
      smoothness: currentSettings.smoothness,
      redeye:     currentSettings.redeye,
      slimFace:   currentSettings.slimFace,
      smallHead:  currentSettings.smallHead,
      bigEye:     currentSettings.bigEye,
      teethWhiten: currentSettings.teethWhiten,
      filter:     currentFilter,
      filterStr:  filterStrength,
      liquifyStrokeCount: activeStrokeCount
    };

    // 舍弃当前位置之后的所有记录（新操作覆盖旧分支）
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(snap);

    // 限制最大长度
    if (historyStack.length > MAX_HISTORY) {
      historyStack.shift();
    } else {
      historyIndex++;
    }
    updateUndoRedoButtons();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreFromHistory();
    showHistoryPreview();
  }

  function redo() {
    if (historyIndex >= historyStack.length - 1) return;
    historyIndex++;
    restoreFromHistory();
    showHistoryPreview();
  }

  var historyPreviewTimer = null;
  function showHistoryPreview() {
    var bad = document.getElementById('undoRedoPreview');
    if (bad) bad.remove();
    clearTimeout(historyPreviewTimer);

    // 创建小缩略图预览
    var preview = document.createElement('canvas');
    var scale = Math.min(80 / canvas.width, 60 / canvas.height);
    preview.width  = Math.round(canvas.width  * scale);
    preview.height = Math.round(canvas.height * scale);
    var pCtx = preview.getContext('2d');
    pCtx.drawImage(canvas, 0, 0, preview.width, preview.height);

    var div = document.createElement('div');
    div.id = 'undoRedoPreview';
    div.className = 'fixed z-50 bg-gray-900/95 border border-gray-700 rounded-xl px-2 py-1.5 shadow-2xl';
    div.style.cssText = 'top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;transition:opacity 0.3s';

    var label = historyIndex < historyStack.length - 1 ?
      '已撤销 (' + (historyIndex + 1) + '/' + historyStack.length + ')' :
      '已重做 (' + (historyIndex + 1) + '/' + historyStack.length + ')';

    div.innerHTML = '<div class="text-xs text-gray-300 text-center mb-1">' + label + '</div>';
    preview.style.borderRadius = '6px';
    div.appendChild(preview);
    document.body.appendChild(div);

    historyPreviewTimer = setTimeout(function () {
      div.style.opacity = '0';
      setTimeout(function () { if (div.parentNode) div.remove(); }, 300);
    }, 1000);
  }

  function restoreFromHistory() {
    var snap = historyStack[historyIndex];
    if (!snap) return;

    // 静默恢复：不触发 pushHistory
    sliderBrightness.value = snap.brightness;
    sliderContrast.value   = snap.contrast;
    sliderSaturate.value   = snap.saturation;
    sliderSmoothing.value  = snap.smoothness;
    sliderRedEye.value     = snap.redeye;
    sliderSlimFace.value   = snap.slimFace  || 0;
    sliderSmallHead.value  = snap.smallHead || 0;
    sliderBigEye.value     = snap.bigEye    || 0;
    sliderTeethWhiten.value = snap.teethWhiten || 0;

    valBrightness.textContent = snap.brightness + '%';
    valContrast.textContent   = snap.contrast   + '%';
    valSaturate.textContent   = snap.saturation + '%';
    valSmoothing.textContent  = snap.smoothness + '%';
    valRedEye.textContent     = snap.redeye     + '%';
    valSlimFace.textContent   = (snap.slimFace  || 0) + '%';
    valSmallHead.textContent  = (snap.smallHead || 0) + '%';
    valBigEye.textContent     = (snap.bigEye    || 0) + '%';
    valTeethWhiten.textContent = (snap.teethWhiten || 0) + '%';

    currentSettings = { brightness: snap.brightness, contrast: snap.contrast,
      saturation: snap.saturation, smoothness: snap.smoothness, redeye: snap.redeye,
      slimFace: snap.slimFace || 0, smallHead: snap.smallHead || 0,
      bigEye: snap.bigEye || 0, teethWhiten: snap.teethWhiten || 0 };

    // 恢复液化笔画数（笔画数据保留，通过 count 控制可见性）
    if (snap.liquifyStrokeCount !== undefined) {
      activeStrokeCount = snap.liquifyStrokeCount;
    }

    // 恢复滤镜状态
    if (snap.filter !== undefined) {
      currentFilter = snap.filter;
      filterStrength = snap.filterStr;
      sliderFilterStr.value = filterStrength;
      valFilterStr.textContent = filterStrength + '%';
      renderFilterList();
    }

    scheduleRender();
    updateUndoRedoButtons();
  }

  function resetHistory() {
    historyStack = [];
    historyIndex = -1;
    pushHistory(); // 记录初始状态
  }

  function updateUndoRedoButtons() {
    var undoBtn = document.getElementById('undoBtn');
    var redoBtn = document.getElementById('redoBtn');
    if (undoBtn) {
      undoBtn.disabled = historyIndex <= 0;
    }
    if (redoBtn) {
      redoBtn.disabled = historyIndex >= historyStack.length - 1;
    }
  }

  // ================================================================
  //  渲染节流：requestAnimationFrame 保证最多 60fps
  // ================================================================
  function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  // ================================================================
  //  Web Worker 初始化（用于人脸检测）
  // ================================================================
  function initWorker() {
    if (!workerSupported) return;

    try {
      detectWorker = new Worker('worker.js');

      detectWorker.onmessage = function (e) {
        const { type, success, positions, error } = e.data;

        if (type === 'ready') {
          workerReady = success;
          if (success) {
            modelsReady = true;
            setStatus('idle', '模型就绪 (Worker)');
            // 若智能美颜已开启且尚未检测，自动触发
            if (smartToggle.checked && !faceLandmarks && sourceImage) {
              detectFace();
            }
          } else {
            console.warn('Worker 模型加载失败:', error);
            workerSupported = false;
            detectWorker = null;
            // 回退到主线程加载，完成后自动触发检测
            loadModelsMainThread().then(function () {
              if (smartToggle.checked && !faceLandmarks && sourceImage) detectFace();
            });
          }
        }

        if (type === 'result') {
          if (success) {
            if (positions && positions.length > 0) {
              // 将 positions 数组包装为兼容 faceLandmarks 的结构
              faceLandmarks = {
                positions: positions,
                getJawOutline:     function () { return this.positions.slice(0, 17); },
                getLeftEye:        function () { return this.positions.slice(36, 42); },
                getRightEye:       function () { return this.positions.slice(42, 48); },
                getLeftEyeBrow:    function () { return this.positions.slice(17, 22); },
                getRightEyeBrow:   function () { return this.positions.slice(22, 27); },
                getMouth:          function () { return this.positions.slice(48, 60); },
                getNose:           function () { return this.positions.slice(27, 36); }
              };
              setStatus('detected', '检测到人脸 ✓');
            } else {
              faceLandmarks = null;
              setStatus('no_face', '未检测到人脸');
            }
          } else {
            console.error('Worker 检测失败:', error);
            faceLandmarks = null;
            setStatus('error', '检测失败');
          }
          render();
        }
      };

      detectWorker.onerror = function (err) {
        console.warn('Worker 错误，回退到主线程检测:', err.message);
        workerSupported = false;
        detectWorker = null;
        loadModelsMainThread().then(function () {
          if (smartToggle.checked && !faceLandmarks && sourceImage) detectFace();
        });
      };
    } catch (e) {
      console.warn('无法创建 Worker，使用主线程检测:', e.message);
      workerSupported = false;
      loadModelsMainThread();
    }
  }

  // ================================================================
  //  主线程模型加载（Worker 不可用时的回退方案）
  // ================================================================
  async function loadModelsMainThread() {
    if (typeof faceapi === 'undefined') {
      setStatus('error', 'Face API 加载失败');
      return;
    }

    setStatus('loading', '模型加载中...');
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';

    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
      ]);
      modelsReady = true;
      setStatus('idle', '模型就绪');
    } catch (err) {
      console.error('模型加载失败:', err);
      setStatus('error', '模型加载失败');
    }
  }

  // ================================================================
  //  状态显示
  // ================================================================
  function setStatus(state, text) {
    detectionStatus = state;
    statusEl.textContent = text;
    statusEl.className = 'text-xs px-2 py-0.5 rounded-full ';
    switch (state) {
      case 'loading':
      case 'detecting':
        statusEl.className += 'bg-yellow-900/40 text-yellow-400';
        break;
      case 'detected':
        statusEl.className += 'bg-green-900/40 text-green-400';
        break;
      case 'no_face':
      case 'error':
        statusEl.className += 'bg-red-900/40 text-red-400';
        break;
      default:
        statusEl.className += 'bg-gray-800 text-gray-500';
    }
  }

  // ================================================================
  //  人脸检测
  // ================================================================
  async function detectFace() {
    if (!sourceImage) return;
    if (!smartToggle.checked) return;

    setStatus('detecting', '检测中...');
    faceLandmarks = null;

    // 优先使用 Worker
    if (detectWorker && workerReady) {
      try {
        const bitmap = await createImageBitmap(sourceImage);
        detectWorker.postMessage(
          { type: 'detect', imageBitmap: bitmap },
          [bitmap]  // transfer
        );
        return; // 结果由 worker.onmessage 异步返回
      } catch (e) {
        console.warn('Worker 检测失败，回退主线程:', e.message);
      }
    }

    // 回退：主线程检测
    await detectFaceMainThread();
  }

  async function detectFaceMainThread() {
    if (!modelsReady) return;

    try {
      const options = new faceapi.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.5
      });
      const result = await faceapi
        .detectSingleFace(sourceImage, options)
        .withFaceLandmarks();

      if (result && result.landmarks) {
        faceLandmarks = result.landmarks;
        setStatus('detected', '检测到人脸 ✓');
      } else {
        setStatus('no_face', '未检测到人脸');
      }
    } catch (err) {
      console.error('人脸检测出错:', err);
      setStatus('error', '检测失败');
    }

    render();
  }

  // ================================================================
  //  辅助：缩放关键点
  // ================================================================
  function scalePoint(p, scale) {
    return { x: p.x * scale, y: p.y * scale };
  }

  function getScaledPositions(scale) {
    return faceLandmarks.positions.map(p => scalePoint(p, scale));
  }

  // ================================================================
  //  面部皮肤遮罩（含眼/嘴挖孔）
  // ================================================================
  function buildFaceClipPath(ctx, pts) {
    const jaw = pts.slice(0, 17);
    const leftBrow  = pts.slice(17, 22);
    const rightBrow = pts.slice(22, 27);

    const browArchL = leftBrow[2];
    const browArchR = rightBrow[2];
    const browAvgY  = (browArchL.y + browArchR.y) / 2;
    const chinY     = jaw[8].y;
    const foreheadH = (chinY - browAvgY) * 0.40;
    const topY      = browAvgY - foreheadH;

    const foreheadTop   = { x: (browArchL.x + browArchR.x) / 2, y: topY - foreheadH * 0.1 };
    const foreheadLeft  = { x: leftBrow[0].x  - 8, y: topY };
    const foreheadRight = { x: rightBrow[4].x + 8, y: topY };

    ctx.beginPath();
    ctx.moveTo(leftBrow[0].x, leftBrow[0].y);
    ctx.lineTo(foreheadLeft.x, foreheadLeft.y);
    ctx.lineTo(foreheadTop.x, foreheadTop.y);
    ctx.lineTo(foreheadRight.x, foreheadRight.y);
    ctx.lineTo(rightBrow[4].x, rightBrow[4].y);
    for (let i = 16; i >= 0; i--) ctx.lineTo(jaw[i].x, jaw[i].y);
    ctx.closePath();

    addHole(ctx, pts.slice(36, 42));
    addHole(ctx, pts.slice(42, 48));
    addHole(ctx, pts.slice(48, 60), 1.15);
  }

  function addHole(ctx, ring, expand) {
    if (expand === undefined) expand = 1.2;
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
    ctx.moveTo(
      cx + (ring[0].x - cx) * expand,
      cy + (ring[0].y - cy) * expand
    );
    for (let i = 1; i < ring.length; i++) {
      ctx.lineTo(
        cx + (ring[i].x - cx) * expand,
        cy + (ring[i].y - cy) * expand
      );
    }
    ctx.closePath();
  }

  // ================================================================
  //  液化变形（瘦脸 / 小头）
  //  基于 68 点关键点，使用局部收缩 warp 算法
  // ================================================================

  /**
   * 对 Canvas 指定区域执行局部收缩变换
   * @param {CanvasRenderingContext2D} ctx  目标上下文
   * @param {number} w  Canvas 宽度
   * @param {number} h  Canvas 高度
   * @param {Array}  centers  变形中心 [{x, y, radius, dirX, dirY}, ...]
   * @param {number} strength  强度 0-1
   */
  function applyContractWarp(ctx, w, h, centers, strength) {
    if (strength <= 0 || !centers.length) return;

    // 计算受影响区域的包围盒
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var ci = 0; ci < centers.length; ci++) {
      var c = centers[ci];
      if (c.x - c.radius < minX) minX = c.x - c.radius;
      if (c.y - c.radius < minY) minY = c.y - c.radius;
      if (c.x + c.radius > maxX) maxX = c.x + c.radius;
      if (c.y + c.radius > maxY) maxY = c.y + c.radius;
    }
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(w - 1, Math.ceil(maxX));
    maxY = Math.min(h - 1, Math.ceil(maxY));

    var regionW = maxX - minX + 1;
    var regionH = maxY - minY + 1;
    if (regionW <= 0 || regionH <= 0) return;

    var imageData = ctx.getImageData(minX, minY, regionW, regionH);
    var src = new Uint8ClampedArray(imageData.data); // 源像素副本
    var dst = imageData.data;
    var sFac = strength * 0.012; // 整体强度系数

    for (var y = 0; y < regionH; y++) {
      for (var x = 0; x < regionW; x++) {
        var gx = x + minX, gy = y + minY;
        var dx = 0, dy = 0;

        for (var ci = 0; ci < centers.length; ci++) {
          var c = centers[ci];
          var dist = Math.sqrt((gx - c.x) * (gx - c.x) + (gy - c.y) * (gy - c.y));
          if (dist < c.radius && dist > 0.5) {
            // 二次衰减：越靠近中心位移越大
            var factor = sFac * (1 - dist / c.radius) * (1 - dist / c.radius);
            dx += (c.x - gx) * factor; // 向内收缩
            dy += (c.y - gy) * factor;
          }
        }

        // 反向查找源像素
        var sx = Math.round(x - dx);
        var sy = Math.round(y - dy);
        if (sx >= 0 && sx < regionW && sy >= 0 && sy < regionH) {
          var si = (sy * regionW + sx) * 4;
          var di = (y  * regionW + x)  * 4;
          dst[di]     = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
        }
      }
    }

    ctx.putImageData(imageData, minX, minY);
  }

  /** 构建瘦脸的变形中心点（左右脸颊向内推） */
  function getSlimFaceCenters(pts) {
    var centers = [];
    var nose = pts[27]; // 鼻梁作为中心参考
    var jaw  = pts.slice(0, 17);

    // 左脸颊：jaw[3]~jaw[6]，右脸颊：jaw[10]~jaw[13]
    var indices = [3, 4, 5, 6, 10, 11, 12, 13];
    for (var i = 0; i < indices.length; i++) {
      var p  = jaw[indices[i]];
      var cx = p.x + (nose.x - p.x) * 0.15; // 向鼻梁方向略微偏移
      var cy = p.y + (nose.y - p.y) * 0.10;
      centers.push({
        x: cx, y: cy,
        radius: 48 + i * 2
      });
    }
    return centers;
  }

  /** 构建小头的变形中心点（头部轮廓向内收缩） */
  function getSmallHeadCenters(pts) {
    var centers = [];
    var jaw  = pts.slice(0, 17);
    var leftBrow  = pts[17];
    var rightBrow = pts[26];

    // 下巴区域密集布点
    for (var i = 4; i <= 12; i++) {
      centers.push({
        x: jaw[i].x, y: jaw[i].y,
        radius: 70
      });
    }
    // 左右耳侧
    centers.push({ x: jaw[0].x,  y: jaw[0].y,  radius: 60 });
    centers.push({ x: jaw[16].x, y: jaw[16].y, radius: 60 });
    // 额头
    var browMidY = (leftBrow.y + rightBrow.y) / 2;
    var chinY    = jaw[8].y;
    var fh       = (chinY - browMidY) * 0.35;
    var topY     = browMidY - fh;
    var midX     = (leftBrow.x + rightBrow.x) / 2;
    centers.push({ x: midX, y: topY, radius: 65 });
    centers.push({ x: leftBrow.x  - 10, y: topY, radius: 55 });
    centers.push({ x: rightBrow.x + 10, y: topY, radius: 55 });

    return centers;
  }

  /**
   * 统一入口：根据当前设置应用瘦脸/小头变形
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w 画布宽
   * @param {number} h 画布高
   * @param {object} points  已缩放到画布的 68 点数组
   */
  function applyFaceWarp(ctx, w, h, points) {
    syncCurrentSettings();
    if (!points || points.length < 68) return;

    if (currentSettings.slimFace > 0) {
      var slimCenters = getSlimFaceCenters(points);
      applyContractWarp(ctx, w, h, slimCenters, currentSettings.slimFace);
    }
    if (currentSettings.smallHead > 0) {
      var headCenters = getSmallHeadCenters(points);
      applyContractWarp(ctx, w, h, headCenters, currentSettings.smallHead);
    }
  }

  // ================================================================
  //  大眼算法（基于眼部关键点向外扩张）
  // ================================================================
  function applyBigEyeWarp(ctx, w, h, points, strength) {
    if (strength <= 0 || !points || points.length < 68) return;

    var leftEye  = points.slice(36, 42);
    var rightEye = points.slice(42, 48);
    var eyeCenters = [];

    [leftEye, rightEye].forEach(function (ring) {
      var cx = ring.reduce(function (s, p) { return s + p.x; }, 0) / ring.length;
      var cy = ring.reduce(function (s, p) { return s + p.y; }, 0) / ring.length;
      // 以眼睛关键点的最大半宽作为影响半径
      var maxR = 0;
      ring.forEach(function (p) {
        var d = Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy));
        if (d > maxR) maxR = d;
      });
      var radius = maxR * 2.5; // 扩大影响范围
      eyeCenters.push({ x: cx, y: cy, radius: radius });
    });

    // 对每只眼睛执行向外扩张（逆收缩）
    var sFac = strength / 100 * 0.025;

    eyeCenters.forEach(function (eye) {
      var margin = Math.ceil(eye.radius);
      var minX = Math.max(0, Math.floor(eye.x - margin));
      var minY = Math.max(0, Math.floor(eye.y - margin));
      var maxX = Math.min(w - 1, Math.ceil(eye.x + margin));
      var maxY = Math.min(h - 1, Math.ceil(eye.y + margin));
      var rw = maxX - minX + 1, rh = maxY - minY + 1;
      if (rw <= 0 || rh <= 0) return;

      var imageData = ctx.getImageData(minX, minY, rw, rh);
      var src = new Uint8ClampedArray(imageData.data);
      var dst = imageData.data;

      for (var y = 0; y < rh; y++) {
        for (var x = 0; x < rw; x++) {
          var gx = x + minX, gy = y + minY;
          var dist = Math.sqrt((gx - eye.x) * (gx - eye.x) + (gy - eye.y) * (gy - eye.y));
          if (dist >= eye.radius || dist < 0.5) continue;

          var falloff = 1 - dist / eye.radius;
          falloff = falloff * falloff;
          var disp = sFac * falloff * eye.radius;
          // 从更靠近中心的位置采样（向外扩张）
          var factor = 1 - disp / (dist + 0.01);
          var sx = (gx - eye.x) * factor + eye.x - minX;
          var sy = (gy - eye.y) * factor + eye.y - minY;
          var six = Math.round(sx), siy = Math.round(sy);
          if (six >= 0 && six < rw && siy >= 0 && siy < rh) {
            var si = (siy * rw + six) * 4;
            var di = (y  * rw + x)  * 4;
            dst[di]     = src[si];
            dst[di + 1] = src[si + 1];
            dst[di + 2] = src[si + 2];
          }
        }
      }
      ctx.putImageData(imageData, minX, minY);
    });
  }

  // ================================================================
  //  牙齿美白算法
  // ================================================================
  function applyTeethWhitening(ctx, w, h, points, strength) {
    if (strength <= 0 || !points || points.length < 68) return;

    var mouth = points.slice(48, 60);
    // 上唇内缘: 61-63, 下唇内缘: 65-67 (如果有的话)，否则使用外缘
    // 使用口腔区域：嘴中心区域
    var centerX = mouth.reduce(function (s, p) { return s + p.x; }, 0) / mouth.length;
    var centerY = mouth.reduce(function (s, p) { return s + p.y; }, 0) / mouth.length;

    // 估算牙齿区域 = 嘴的中心偏上部分
    var topLip    = mouth.slice(0, 4);   // 48-51
    var bottomLip = mouth.slice(4, 8);   // 54-57  (skip 52-53 which are center)
    // 用上下唇关键点构建区域
    var topY    = (topLip[1].y + topLip[2].y) / 2;
    var bottomY = (bottomLip[1].y + bottomLip[2].y) / 2;
    var teethH  = bottomY - topY;
    var teethW  = teethH * 2.2;

    var box = {
      x: Math.max(0, Math.floor(centerX - teethW / 2)),
      y: Math.max(0, Math.floor(topY - teethH * 0.1)),
      w: Math.min(Math.ceil(teethW), w - Math.floor(centerX - teethW / 2)),
      h: Math.min(Math.ceil(teethH * 1.2), h - Math.floor(topY - teethH * 0.1))
    };
    if (box.w <= 0 || box.h <= 0) return;

    var imageData = ctx.getImageData(box.x, box.y, box.w, box.h);
    var pixels = imageData.data;
    var factor = strength / 100;

    for (var i = 0; i < pixels.length; i += 4) {
      var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      // 检测偏黄/米色像素（牙渍特征）
      var brightness = (r + g + b) / 3;
      if (r > 150 && g > 120 && b > 80 && r > b * 1.15) {
        // 提亮 + 去黄
        var gray = brightness;
        pixels[i]     = r + (gray - r) * factor * 0.6;
        pixels[i + 1] = g + (gray - g) * factor * 0.4;
        pixels[i + 2] = b + ((r + g) / 2 - b) * factor * 0.7; // 增加蓝色分量去黄
        // 整体提亮
        pixels[i]     = Math.min(255, pixels[i]     + 20 * factor);
        pixels[i + 1] = Math.min(255, pixels[i + 1] + 20 * factor);
        pixels[i + 2] = Math.min(255, pixels[i + 2] + 30 * factor);
      }
    }
    ctx.putImageData(imageData, box.x, box.y);
  }

  // ================================================================
  //  手动液化算法
  // ================================================================

  /** 点到线段的距离 */
  function pointToSegmentDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (lenSq < 0.001) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
    var t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var nearX = ax + t * dx, nearY = ay + t * dy;
    return Math.sqrt((px - nearX) * (px - nearX) + (py - nearY) * (py - nearY));
  }

  /**
   * 对画布指定区域执行单段液化变形（逆映射，无空洞）
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w  画布宽
   * @param {number} h  画布高
   * @param {number} fromX / fromY  拖拽起点
   * @param {number} toX   / toY    拖拽终点
   * @param {number} radius  笔刷半径
   * @param {number} strength  强度 10-50
   */
  function applyLiquifySegment(ctx, w, h, fromX, fromY, toX, toY, radius, strength) {
    var dx = toX - fromX;
    var dy = toY - fromY;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.3) return;
    var nx = dx / len, ny = dy / len;

    var margin = Math.ceil(radius + len);
    var minX = Math.max(0, Math.floor(Math.min(fromX, toX) - margin));
    var minY = Math.max(0, Math.floor(Math.min(fromY, toY) - margin));
    var maxX = Math.min(w - 1, Math.ceil(Math.max(fromX, toX) + margin));
    var maxY = Math.min(h - 1, Math.ceil(Math.max(fromY, toY) + margin));

    var rw = maxX - minX + 1, rh = maxY - minY + 1;
    if (rw <= 0 || rh <= 0) return;

    var imageData = ctx.getImageData(minX, minY, rw, rh);
    var src = new Uint8ClampedArray(imageData.data);
    var dst = imageData.data;
    var sFac = strength / 50 * len * 0.25;

    for (var y = 0; y < rh; y++) {
      for (var x = 0; x < rw; x++) {
        var gx = x + minX, gy = y + minY;
        var dist = pointToSegmentDist(gx, gy, fromX, fromY, toX, toY);
        if (dist >= radius) continue;

        var falloff = 1 - dist / radius;
        falloff = falloff * falloff;
        var disp = sFac * falloff;

        var sx = x - nx * disp;
        var sy = y - ny * disp;
        var six = Math.round(sx), siy = Math.round(sy);
        if (six >= 0 && six < rw && siy >= 0 && siy < rh) {
          var si = (siy * rw + six) * 4;
          var di = (y  * rw + x)  * 4;
          dst[di]     = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
        }
      }
    }
    ctx.putImageData(imageData, minX, minY);
  }

  /** 重放所有活跃笔画 + 当前正在绘制的部分笔画 */
  function applyAllLiquifyStrokes(ctx, w, h) {
    var sx = sourceImage ? w / sourceImage.width  : 1;
    var sy = sourceImage ? h / sourceImage.height : 1;
    var avgScale = (sx + sy) / 2;
    // 已保存的活跃笔画（归一化坐标 → 当前画布坐标）
    for (var si = 0; si < activeStrokeCount; si++) {
      var stroke = liquifyStrokes[si];
      var pts = stroke.points;
      var scaledRadius = stroke.radius * avgScale;
      for (var i = 1; i < pts.length; i++) {
        var x1 = pts[i - 1].x * sx, y1 = pts[i - 1].y * sy;
        var x2 = pts[i].x     * sx, y2 = pts[i].y     * sy;
        if (stroke.eraser) {
          applyLiquifySegment(ctx, w, h, x2, y2, x1, y1, scaledRadius, stroke.strength);
        } else {
          applyLiquifySegment(ctx, w, h, x1, y1, x2, y2, scaledRadius, stroke.strength);
        }
      }
    }
    // 当前正在绘制的笔画（已在画布坐标中，用于实时预览）
    if (isBrushing && currentStrokePts.length > 1) {
      for (var i = 1; i < currentStrokePts.length; i++) {
        applyLiquifySegment(ctx, w, h,
          currentStrokePts[i - 1].x, currentStrokePts[i - 1].y,
          currentStrokePts[i].x, currentStrokePts[i].y,
          brushSize, liquifyStr);
      }
    }
  }

  // ================================================================
  //  核心渲染管线
  // ================================================================
  function render() {
    if (!sourceImage) return;

    const containerWidth = canvas.parentElement.clientWidth;
    const maxHeight      = window.innerHeight * 0.6;
    const imgRatio       = sourceImage.width / sourceImage.height;

    let drawW = containerWidth;
    let drawH = drawW / imgRatio;
    if (drawH > maxHeight) {
      drawH = maxHeight;
      drawW = drawH * imgRatio;
    }

    if (canvas.width !== drawW || canvas.height !== drawH) {
      canvas.width  = drawW;
      canvas.height = drawH;
    }

    syncCurrentSettings();
    const { brightness: b, contrast: c, saturation: s } = currentSettings;

    valBrightness.textContent = b + '%';
    valContrast.textContent   = c + '%';
    valSaturate.textContent   = s + '%';

    ctx.filter = `brightness(${b}%) contrast(${c}%) saturate(${s}%)`;
    ctx.clearRect(0, 0, drawW, drawH);
    ctx.drawImage(sourceImage, 0, 0, drawW, drawH);
    ctx.filter = 'none';

    // ── LUT 滤镜 ──
    if (currentFilter !== 'none' && filterStrength > 0 && LiteBeautyFilters.isInitialized()) {
      var lut = LiteBeautyFilters.getLUT(currentFilter);
      if (lut) {
        LiteBeautyFilters.applyToContext(ctx, drawW, drawH, lut, filterStrength / 100);
      }
    }

    placeholder.classList.add('hidden');

    if (smartToggle.checked && faceLandmarks) {
      const scale      = drawW / sourceImage.width;
      const smoothness = currentSettings.smoothness;
      const redeye     = currentSettings.redeye;

      if (smoothness > 0) applySkinSmoothing(scale, smoothness);
      if (redeye > 0)     applyRedEyeCorrection(scale, redeye);

      // ── 第三步：液化变形（瘦脸 / 小头） ──
      if ((currentSettings.slimFace > 0 || currentSettings.smallHead > 0)) {
        syncCurrentSettings();
        applyFaceWarp(ctx, drawW, drawH, getScaledPositions(scale));
      }
      // ── 大眼 ──
      if (currentSettings.bigEye > 0) {
        syncCurrentSettings();
        applyBigEyeWarp(ctx, drawW, drawH, getScaledPositions(scale), currentSettings.bigEye);
      }
      // ── 牙齿美白 ──
      if (currentSettings.teethWhiten > 0) {
        applyTeethWhitening(ctx, drawW, drawH, getScaledPositions(scale), currentSettings.teethWhiten);
      }
    }

    // ── 第四步：手动液化（最后渲染，在所有美颜/滤镜/变形之后） ──
    if (activeStrokeCount > 0 || (isBrushing && currentStrokePts.length > 1)) {
      applyAllLiquifyStrokes(ctx, drawW, drawH);
    }

    // ── 第五步：水印（最顶层） ──
    drawWatermark(ctx, drawW, drawH);
  }

  // ================================================================
  //  局部磨皮
  // ================================================================
  function applySkinSmoothing(scale, strength) {
    const pts = getScaledPositions(scale);

    if (!blurCanvas || blurCanvas.width !== canvas.width || blurCanvas.height !== canvas.height) {
      blurCanvas = document.createElement('canvas');
      blurCanvas.width  = canvas.width;
      blurCanvas.height = canvas.height;
      blurCtx = blurCanvas.getContext('2d');
    }

    const blurRadius = (strength / 100) * (canvas.width / 28);
    blurCtx.filter = `blur(${blurRadius}px)`;
    blurCtx.clearRect(0, 0, blurCanvas.width, blurCanvas.height);
    blurCtx.drawImage(canvas, 0, 0);
    blurCtx.filter = 'none';

    ctx.save();
    buildFaceClipPath(ctx, pts);
    ctx.clip('evenodd');
    ctx.globalAlpha = (strength / 100) * 0.65;
    ctx.drawImage(blurCanvas, 0, 0);
    ctx.restore();
  }

  // ================================================================
  //  红眼消除
  // ================================================================
  function applyRedEyeCorrection(scale, strength) {
    const pts = getScaledPositions(scale);
    [pts.slice(36, 42), pts.slice(42, 48)].forEach(eyeRing => {
      const xs = eyeRing.map(p => p.x), ys = eyeRing.map(p => p.y);
      const box = {
        x: Math.floor(Math.min(...xs)),
        y: Math.floor(Math.min(...ys)),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs)),
        h: Math.ceil(Math.max(...ys) - Math.min(...ys))
      };
      const padX = box.w * 0.25, padY = box.h * 0.25;
      box.x = Math.max(0, Math.floor(box.x - padX));
      box.y = Math.max(0, Math.floor(box.y - padY));
      box.w = Math.min(Math.ceil(box.w + padX * 2), canvas.width  - box.x);
      box.h = Math.min(Math.ceil(box.h + padY * 2), canvas.height - box.y);

      if (box.w <= 0 || box.h <= 0) return;

      const imageData = ctx.getImageData(box.x, box.y, box.w, box.h);
      const pixels = imageData.data;
      const factor = strength / 100;

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (r > 50 && r > g * 1.4 && r > b * 1.4) {
          const gray = (g + b) / 2;
          pixels[i]     = r - (r - gray) * factor;
          pixels[i + 1] = g + (gray - g) * factor * 0.35;
          pixels[i + 2] = b + (gray - b) * factor * 0.35;
        }
      }
      ctx.putImageData(imageData, box.x, box.y);
    });
  }

  // ================================================================
  //  对比视图（长按原图 / 滑动对比）
  // ================================================================

  /** 将原图绘制到对比 Canvas 上（不含任何滤镜） */
  function drawCompareOriginal() {
    if (!sourceImage || !canvas.width || !canvas.height) return;
    compareCanvas.width  = canvas.width;
    compareCanvas.height = canvas.height;
    compareCtx.clearRect(0, 0, compareCanvas.width, compareCanvas.height);
    compareCtx.drawImage(sourceImage, 0, 0, compareCanvas.width, compareCanvas.height);
  }

  /** 同步对比 Canvas 的 CSS 位置和尺寸，使其精确覆盖主 Canvas */
  function syncCompareLayout() {
    var cRect  = canvas.getBoundingClientRect();
    var wRect  = canvasWrapper.getBoundingClientRect();
    var left   = cRect.left - wRect.left;
    var top    = cRect.top  - wRect.top;
    var cw     = cRect.width;
    var ch     = cRect.height;

    compareCanvas.style.left   = left + 'px';
    compareCanvas.style.top    = top  + 'px';
    compareCanvas.style.width  = cw   + 'px';
    compareCanvas.style.height = ch   + 'px';

    // 分割线
    compareDivider.style.left   = (left + cw * dividerPos) + 'px';
    compareDivider.style.top    = top  + 'px';
    compareDivider.style.height = ch   + 'px';
  }

  /** 滑动对比模式下，更新剪切区域 */
  function updateSlideClip() {
    if (!sourceImage) return;
    syncCompareLayout();
    var w = compareCanvas.width;
    compareCtx.clearRect(0, 0, w, compareCanvas.height);
    compareCtx.save();
    compareCtx.beginPath();
    compareCtx.rect(0, 0, Math.round(w * dividerPos), compareCanvas.height);
    compareCtx.clip();
    compareCtx.drawImage(sourceImage, 0, 0, w, compareCanvas.height);
    compareCtx.restore();
  }

  /** 进入滑动对比模式 */
  function enterSlideMode() {
    compareMode = 'slide';
    compareModeBtn.classList.add('text-violet-400');
    compareModeBtn.classList.remove('text-gray-500');
    compareModeBtn.title = '当前：滑动对比 — 点击切换为长按对比';
    if (sourceImage) {
      drawCompareOriginal();
      syncCompareLayout();
      updateSlideClip();
      compareCanvas.classList.remove('hidden');
      compareDivider.classList.remove('hidden');
    }
  }

  /** 退出滑动对比模式，回到长按模式 */
  function exitSlideMode() {
    compareMode = 'press';
    compareModeBtn.classList.remove('text-violet-400');
    compareModeBtn.classList.add('text-gray-500');
    compareModeBtn.title = '当前：长按对比 — 点击切换为滑动对比';
    compareCanvas.classList.add('hidden');
    compareDivider.classList.add('hidden');
    compareBadge.classList.add('hidden');
    isDragging = false;
  }

  // ── 长按事件（press 模式） ──
  function onComparePressStart(e) {
    if (compareMode !== 'press' || !sourceImage || !canvas.width) return;
    e.preventDefault();
    drawCompareOriginal();
    syncCompareLayout();
    compareCanvas.classList.remove('hidden');
    compareBadge.classList.remove('hidden');
  }

  function onComparePressEnd() {
    if (compareMode !== 'press') return;
    compareCanvas.classList.add('hidden');
    compareBadge.classList.add('hidden');
  }

  // ── 滑动拖动事件（slide 模式） ──
  function onDividerDragStart(e) {
    if (compareMode !== 'slide' || !sourceImage) return;
    e.preventDefault();
    isDragging = true;
    updateDividerFromEvent(e);
  }

  function onDividerDragMove(e) {
    if (!isDragging) return;
    updateDividerFromEvent(e);
  }

  function onDividerDragEnd() {
    isDragging = false;
  }

  function updateDividerFromEvent(e) {
    var wRect = canvasWrapper.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var x = clientX - wRect.left;

    var cRect = canvas.getBoundingClientRect();
    var relX = x - (cRect.left - wRect.left);
    dividerPos = Math.max(0.03, Math.min(0.97, relX / cRect.width));
    updateSlideClip();
  }

  // ── 事件绑定（同时支持鼠标和触摸） ──
  canvasWrapper.addEventListener('mousedown', function (e) {
    if (liquifyActive && !cropper) { onLiquifyStart(e); return; }
    if (compareMode === 'press')  onComparePressStart(e);
    if (compareMode === 'slide')  onDividerDragStart(e);
  });
  canvasWrapper.addEventListener('touchstart', function (e) {
    if (liquifyActive && !cropper) { onLiquifyStart(e); return; }
    if (compareMode === 'press')  onComparePressStart(e);
    if (compareMode === 'slide')  onDividerDragStart(e);
  }, { passive: false });

  window.addEventListener('mouseup',   function () { if (isBrushing) onLiquifyEnd(); onComparePressEnd(); onDividerDragEnd(); });
  window.addEventListener('touchend',  function () { if (isBrushing) onLiquifyEnd(); onComparePressEnd(); onDividerDragEnd(); });
  window.addEventListener('touchcancel', function () { if (isBrushing) onLiquifyEnd(); onComparePressEnd(); onDividerDragEnd(); });
  window.addEventListener('mousemove',  function (e) { if (isBrushing) onLiquifyMove(e); else if (isDragging) onDividerDragMove(e); });
  window.addEventListener('touchmove',  function (e) { if (isBrushing) onLiquifyMove(e); else if (isDragging) onDividerDragMove(e); }, { passive: false });

  // 鼠标离开画布区域时也结束
  canvasWrapper.addEventListener('mouseleave', function () {
    hideBrushCursor();
    if (isBrushing) onLiquifyEnd();
    onComparePressEnd();
    onDividerDragEnd();
  });

  // ── 模式切换按钮 ──
  compareModeBtn.addEventListener('click', function () {
    if (compareMode === 'press') {
      enterSlideMode();
    } else {
      exitSlideMode();
    }
  });

  // ── 窗口 resize / render 后同步对比视图 ──
  var origRender = render;
  render = function () {
    origRender();
    if (compareMode === 'slide' && sourceImage) {
      updateSlideClip();
    }
  };

  // ================================================================
  //  旋转与裁剪
  // ================================================================
  var rotateLeftBtn  = document.getElementById('rotateLeftBtn');
  var rotateRightBtn = document.getElementById('rotateRightBtn');
  var cropBtn        = document.getElementById('cropBtn');
  var cropUI         = document.getElementById('cropUI');
  var cropImage      = document.getElementById('cropImage');
  var cropConfirmBtn = document.getElementById('cropConfirmBtn');
  var cropCancelBtn  = document.getElementById('cropCancelBtn');
  var cropper        = null;

  /** 旋转图片：在离屏 Canvas 上旋转后，替换 sourceImage */
  function rotateImage(degrees) {
    if (!sourceImage) return;
    var tempCanvas = document.createElement('canvas');
    if (degrees === 90 || degrees === 270) {
      tempCanvas.width  = sourceImage.height;
      tempCanvas.height = sourceImage.width;
    } else {
      tempCanvas.width  = sourceImage.width;
      tempCanvas.height = sourceImage.height;
    }
    var tempCtx = tempCanvas.getContext('2d');
    tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    tempCtx.rotate(degrees * Math.PI / 180);
    tempCtx.drawImage(sourceImage, -sourceImage.width / 2, -sourceImage.height / 2);

    // 从离屏 Canvas 创建新 Image
    var dataUrl = tempCanvas.toDataURL('image/jpeg', 0.95);
    var newImg  = new Image();
    newImg.onload = function () {
      sourceImage   = newImg;
      faceLandmarks = null;      // 旋转后面部关键点失效
      resetHistory();
      render();
      if (smartToggle.checked) detectFace();
    };
    newImg.src = dataUrl;
  }

  rotateLeftBtn.addEventListener('click',  function () { rotateImage(-90); });
  rotateRightBtn.addEventListener('click', function () { rotateImage( 90); });

  // ── 裁剪流程 ──
  cropBtn.addEventListener('click', function () {
    if (!sourceImage) { showToast('请先选择一张图片'); return; }
    enterCropMode();
  });

  function enterCropMode() {
    if (liquifyActive) exitLiquifyMode();
    // 将当前处理后的画面导出为 DataURL，供 cropperjs 使用
    var dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    cropImage.src = dataUrl;
    cropImage.classList.remove('hidden');
    cropImage.style.display = 'block';
    canvas.classList.add('hidden');
    compareCanvas.classList.add('hidden');

    cropUI.classList.remove('hidden');

    cropImage.onload = function () {
      // 销毁旧实例
      if (cropper) cropper.destroy();
      cropper = new Cropper(cropImage, {
        viewMode: 1,
        autoCropArea: 0.9,
        responsive: true,
        guides: true,
        background: false,
        modal: true,
      });
      highlightRatioBtn(null); // 默认自由比例
    };
    // 若图片已缓存，直接触发 onload
    if (cropImage.complete) cropImage.onload();
  }

  function exitCropMode() {
    if (cropper) { cropper.destroy(); cropper = null; }
    cropImage.classList.add('hidden');
    cropImage.style.display = 'none';
    cropImage.src = '';
    canvas.classList.remove('hidden');
    cropUI.classList.add('hidden');
  }

  cropCancelBtn.addEventListener('click', exitCropMode);

  cropConfirmBtn.addEventListener('click', function () {
    if (!cropper) return;
    var croppedCanvas = cropper.getCroppedCanvas();
    if (!croppedCanvas) { showToast('裁剪失败'); return; }

    var dataUrl = croppedCanvas.toDataURL('image/jpeg', 0.95);
    var newImg  = new Image();
    newImg.onload = function () {
      sourceImage   = newImg;
      faceLandmarks = null;
      liquifyStrokes = [];
      activeStrokeCount = 0;
      currentStrokePts = [];
      isBrushing = false;
      if (liquifyActive) exitLiquifyMode();
      selectFilter('none');
      sliderFilterStr.value = 100;
      valFilterStr.textContent = '100%';
      filterStrength = 100;
      exitCropMode();
      applySettings(defaults);
      resetHistory();
      if (smartToggle.checked) detectFace();
      showToast('裁剪完成');
    };
    newImg.src = dataUrl;
  });

  // ── 裁剪比例按钮 ──
  var ratioButtons = document.querySelectorAll('.crop-ratio-btn');
  ratioButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!cropper) return;
      var ratio = btn.dataset.ratio || null;
      if (ratio) {
        var parts = ratio.split(':');
        cropper.setAspectRatio(+parts[0] / +parts[1]);
      } else {
        cropper.setAspectRatio(NaN);
      }
      highlightRatioBtn(btn);
    });
  });

  function highlightRatioBtn(activeBtn) {
    ratioButtons.forEach(function (b) {
      b.classList.remove('active', 'bg-violet-600', 'text-white');
      b.classList.add('bg-gray-700', 'text-gray-400');
    });
    if (activeBtn) {
      activeBtn.classList.add('active', 'bg-violet-600', 'text-white');
      activeBtn.classList.remove('bg-gray-700', 'text-gray-400');
    }
  }

  // ================================================================
  //  实时拍照模式（相机美颜预览）
  // ================================================================
  var tabAlbum      = document.getElementById('tabAlbum');
  var tabCamera     = document.getElementById('tabCamera');
  var albumPreview  = document.getElementById('albumPreview');
  var cameraPreview = document.getElementById('cameraPreview');
  var liveVideo     = document.getElementById('liveVideo');
  var liveCanvas    = document.getElementById('liveCanvas');
  var liveCtx       = liveCanvas.getContext('2d', { willReadFrequently: true });
  var shutterBtn    = document.getElementById('shutterBtn');
  var liveBadge     = document.getElementById('liveBeautyBadge');
  var controlPanel  = document.getElementById('controlPanel');

  // 离线处理 Canvas（不插入 DOM）
  var procCanvas  = document.createElement('canvas');
  var procCtx     = procCanvas.getContext('2d', { willReadFrequently: true });

  var liveStream      = null;
  var liveFrameCount  = 0;
  var liveRAFId       = null;
  var liveFaceLm      = null;       // 相机模式下的人脸关键点
  var liveBlurCanvas  = null;       // 相机模式磨皮复用画布
  var liveBlurCtx     = null;

  // ── 选项卡切换 ──
  tabAlbum.addEventListener('click', function () {
    if (!cameraMode && sourceImage) return; // 已在相册模式
    switchToAlbumMode();
  });

  tabCamera.addEventListener('click', function () {
    if (cameraMode) return;
    switchToCameraMode();
  });

  // 追踪当前模式
  var cameraMode = false;

  function switchToAlbumMode() {
    cameraMode = false;
    tabAlbum.classList.add('bg-pink-600', 'text-white');
    tabAlbum.classList.remove('bg-gray-800', 'text-gray-400');
    tabCamera.classList.add('bg-gray-800', 'text-gray-400');
    tabCamera.classList.remove('bg-pink-600', 'text-white');

    stopLiveCamera();
    albumPreview.classList.remove('hidden');
    cameraPreview.classList.add('hidden');
    // 恢复控制面板按钮
    showControlButtons(true);

    if (sourceImage) render();
  }

  async function switchToCameraMode() {
    if (liquifyActive) exitLiquifyMode();
    cameraMode = true;
    tabCamera.classList.add('bg-pink-600', 'text-white');
    tabCamera.classList.remove('bg-gray-800', 'text-gray-400');
    tabAlbum.classList.add('bg-gray-800', 'text-gray-400');
    tabAlbum.classList.remove('bg-pink-600', 'text-white');

    albumPreview.classList.add('hidden');
    cameraPreview.classList.remove('hidden');
    // 隐藏上传/裁剪等相册专属按钮
    showControlButtons(false);

    await startLiveCamera();
    startCameraLoop();
  }

  function showControlButtons(visible) {
    // 遍历控制面板中的按钮行、保存按钮等
    var grids = controlPanel.querySelectorAll('.grid');
    var savePreset = document.getElementById('savePresetBtn');
    var savePhoto  = document.getElementById('savePhotoBtn');
    var installBtn = document.getElementById('installBtn');
    var donateSec  = document.getElementById('donateSection');

    grids.forEach(function (g) { g.style.display = visible ? '' : 'none'; });
    if (savePreset) savePreset.style.display = visible ? '' : 'none';
    if (savePhoto)  savePhoto.style.display  = visible ? '' : 'none';
    if (installBtn) installBtn.parentElement.style.display = visible ? '' : 'none';
    if (donateSec)  donateSec.style.display  = visible ? '' : 'none';
  }

  // ── 启动实时摄像头 ──
  async function startLiveCamera() {
    if (liveStream) return;

    var constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    };

    try {
      liveStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // 前置失败 → 尝试后置
      try {
        constraints.video.facingMode = 'environment';
        liveStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e2) {
        alert('无法访问摄像头：' + e2.message);
        switchToAlbumMode();
        return;
      }
    }

    liveVideo.srcObject = liveStream;
    await liveVideo.play();
  }

  function stopLiveCamera() {
    if (liveRAFId) { cancelAnimationFrame(liveRAFId); liveRAFId = null; }
    if (liveStream) {
      liveStream.getTracks().forEach(function (t) { t.stop(); });
      liveStream = null;
      liveVideo.srcObject = null;
    }
    liveFaceLm     = null;
    liveFrameCount = 0;
    liveBlurCanvas = null;
    liveBlurCtx    = null;
    liveBadge.classList.add('hidden');
  }

  // ── 实时处理循环（requestAnimationFrame） ──
  function startCameraLoop() {
    if (liveRAFId) return;
    liveFrameCount = 0;

    function loop() {
      if (!cameraMode) { liveRAFId = null; return; }
      processCameraFrame();
      liveRAFId = requestAnimationFrame(loop);
    }
    loop();
  }

  function processCameraFrame() {
    if (!liveVideo.readyState || liveVideo.readyState < 2) return;

    var vw = liveVideo.videoWidth;
    var vh = liveVideo.videoHeight;
    if (!vw || !vh) return;

    // 限制最大预览宽度 1280px 以保证性能
    var MAX_W = 1280;
    if (vw > MAX_W) {
      vh = Math.round(vh * MAX_W / vw);
      vw = MAX_W;
    }

    syncCurrentSettings();

    // Canvas 尺寸匹配
    if (procCanvas.width !== vw || procCanvas.height !== vh) {
      procCanvas.width = vw; procCanvas.height = vh;
    }
    if (liveCanvas.width !== vw || liveCanvas.height !== vh) {
      liveCanvas.width = vw; liveCanvas.height = vh;
    }

    // ── 第一步：基础滤镜绘制到处理画布 ──
    procCtx.filter = 'brightness(' + currentSettings.brightness + '%) ' +
                     'contrast('   + currentSettings.contrast   + '%) ' +
                     'saturate('   + currentSettings.saturation + '%)';
    procCtx.drawImage(liveVideo, 0, 0, vw, vh);
    procCtx.filter = 'none';

    // ── LUT 滤镜（相机模式用较低分辨率处理以保帧率） ──
    if (currentFilter !== 'none' && filterStrength > 0 && LiteBeautyFilters.isInitialized()) {
      var camLut = LiteBeautyFilters.getLUT(currentFilter);
      if (camLut) {
        LiteBeautyFilters.applyToContext(procCtx, vw, vh, camLut, filterStrength / 100);
      }
    }

    // ── 第二步：智能美颜（每 3 帧检测一次，其余用缓存） ──
    if (smartToggle.checked) {
      liveFrameCount++;
      if (liveFrameCount % 3 === 0) {
        detectFaceOnLiveFrame();
      }

      if (liveFaceLm && currentSettings.smoothness > 0) {
        applyLiveSkinSmoothing();
      }
      if (liveFaceLm && currentSettings.redeye > 0) {
        applyLiveRedEye();
      }
      // 相机模式液化变形
      if (liveFaceLm && (currentSettings.slimFace > 0 || currentSettings.smallHead > 0)) {
        applyFaceWarp(procCtx, vw, vh, liveFaceLm.positions);
      }
    }

    // ── 第三步：绘制到显示 Canvas ──
    liveCtx.clearRect(0, 0, vw, vh);
    liveCtx.drawImage(procCanvas, 0, 0);

    // 美颜状态指示
    if (smartToggle.checked && liveFaceLm) {
      liveBadge.classList.remove('hidden');
      liveBadge.textContent = '美颜中';
      liveBadge.classList.add('bg-pink-600/80');
      liveBadge.classList.remove('bg-yellow-600/80');
    } else if (smartToggle.checked) {
      liveBadge.classList.remove('hidden');
      liveBadge.textContent = '检测中';
      liveBadge.classList.add('bg-yellow-600/80');
      liveBadge.classList.remove('bg-pink-600/80');
    } else {
      liveBadge.classList.add('hidden');
    }
  }

  // ── 相机帧人脸检测（异步，不阻塞渲染） ──
  function detectFaceOnLiveFrame() {
    if (!modelsReady || typeof faceapi === 'undefined') return;

    var options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 224,          // 更小的输入尺寸以加速
      scoreThreshold: 0.5
    });

    faceapi.detectSingleFace(liveVideo, options).withFaceLandmarks()
      .then(function (result) {
        if (result && result.landmarks) {
          liveFaceLm = result.landmarks;
          liveBadge.textContent = '美颜中';
          liveBadge.classList.add('bg-pink-600/80');
          liveBadge.classList.remove('bg-yellow-600/80');
        } else {
          liveFaceLm = null;
        }
      })
      .catch(function () {
        liveFaceLm = null;
      });
  }

  // ── 相机模式下轻量级磨皮（简化版，不挖孔以提升性能） ──
  function applyLiveSkinSmoothing() {
    if (!liveFaceLm) return;
    var pts = liveFaceLm.positions;

    var jaw = pts.slice(0, 17);
    var leftBrow  = pts.slice(17, 22);
    var rightBrow = pts.slice(22, 27);
    var chinY = jaw[8].y;
    var browAvgY = (leftBrow[2].y + rightBrow[2].y) / 2;
    var foreheadH = (chinY - browAvgY) * 0.35;
    var topY = browAvgY - foreheadH;

    // 复用模糊画布，避免每帧创建
    if (!liveBlurCanvas || liveBlurCanvas.width !== procCanvas.width || liveBlurCanvas.height !== procCanvas.height) {
      liveBlurCanvas = document.createElement('canvas');
      liveBlurCanvas.width  = procCanvas.width;
      liveBlurCanvas.height = procCanvas.height;
      liveBlurCtx = liveBlurCanvas.getContext('2d');
    }
    var blurR = (currentSettings.smoothness / 100) * (procCanvas.width / 28);
    liveBlurCtx.filter = 'blur(' + blurR + 'px)';
    liveBlurCtx.drawImage(procCanvas, 0, 0);
    liveBlurCtx.filter = 'none';

    procCtx.save();
    procCtx.beginPath();
    procCtx.moveTo(leftBrow[0].x, topY);
    procCtx.lineTo((leftBrow[2].x + rightBrow[2].x) / 2, topY - foreheadH * 0.3);
    procCtx.lineTo(rightBrow[4].x, topY);
    for (var i = 16; i >= 0; i--) procCtx.lineTo(jaw[i].x, jaw[i].y);
    procCtx.closePath();
    procCtx.clip();
    procCtx.globalAlpha = (currentSettings.smoothness / 100) * 0.6;
    procCtx.drawImage(liveBlurCanvas, 0, 0);
    procCtx.restore();
  }

  /** 相机模式红眼消除（轻量版，性能优先） */
  function applyLiveRedEye() {
    if (!liveFaceLm) return;
    var pts = liveFaceLm.positions;
    [pts.slice(36, 42), pts.slice(42, 48)].forEach(function (eyeRing) {
      var xs = eyeRing.map(function (p) { return p.x; });
      var ys = eyeRing.map(function (p) { return p.y; });
      var box = {
        x: Math.floor(Math.min.apply(null, xs)),
        y: Math.floor(Math.min.apply(null, ys)),
        w: Math.ceil(Math.max.apply(null, xs) - Math.min.apply(null, xs)),
        h: Math.ceil(Math.max.apply(null, ys) - Math.min.apply(null, ys))
      };
      var padX = box.w * 0.25, padY = box.h * 0.25;
      box.x = Math.max(0, Math.floor(box.x - padX));
      box.y = Math.max(0, Math.floor(box.y - padY));
      box.w = Math.min(Math.ceil(box.w + padX * 2), procCanvas.width  - box.x);
      box.h = Math.min(Math.ceil(box.h + padY * 2), procCanvas.height - box.y);
      if (box.w <= 0 || box.h <= 0) return;

      var imageData = procCtx.getImageData(box.x, box.y, box.w, box.h);
      var pixels = imageData.data;
      var factor = currentSettings.redeye / 100;
      for (var i = 0; i < pixels.length; i += 4) {
        var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (r > 50 && r > g * 1.4 && r > b * 1.4) {
          var gray = (g + b) / 2;
          pixels[i]     = r - (r - gray) * factor;
          pixels[i + 1] = g + (gray - g) * factor * 0.35;
          pixels[i + 2] = b + (gray - b) * factor * 0.35;
        }
      }
      procCtx.putImageData(imageData, box.x, box.y);
    });
  }

  // ── 快门按钮：捕获当前处理后帧 → 进入相册编辑模式 ──
  shutterBtn.addEventListener('click', function () {
    if (!cameraMode) return;
    // 保存当前处理画面
    var dataUrl = liveCanvas.toDataURL('image/jpeg', 0.9);
    var img = new Image();
    img.onload = function () {
      sourceImage   = img;
      faceLandmarks = null;
      liquifyStrokes = [];
      activeStrokeCount = 0;
      currentStrokePts = [];
      isBrushing = false;
      if (liquifyActive) exitLiquifyMode();
      selectFilter('none');
      sliderFilterStr.value = 100;
      valFilterStr.textContent = '100%';
      filterStrength = 100;
      switchToAlbumMode();
      applySettings(defaults);
      resetHistory();
      showToast('照片已保存');
    };
    img.src = dataUrl;
  });

  // ================================================================
  //  HEIC 格式转换（iOS 兼容）
  //  功能说明：现代浏览器有效；老旧 Android 可能不拍摄 HEIC，
  //  但能正常读取转换后的 JPG
  // ================================================================
  var heicOverlay = document.getElementById('heicOverlay');

  function showHeicOverlay(show) {
    if (heicOverlay) {
      heicOverlay.classList.toggle('hidden', !show);
    }
  }

  // 用支持 HEIC 的新处理器替换
  var convertingHeic = false;
  var fileInputHandler = async function (e) {
    if (convertingHeic) return; // 防止重复提交
    var file = e.target.files[0];
    if (!file) return;
    stopCamera();
    fileInput.value = ''; // 尽早清空以允许重复选择

    // 检测 HEIC/HEIF 格式
    var isHeic = file.type === 'image/heic' ||
                 file.type === 'image/heif' ||
                 /\.(heic|heif)$/i.test(file.name);

    if (isHeic && typeof heic2any !== 'undefined') {
      convertingHeic = true;
      showHeicOverlay(true);
      try {
        var blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
        // heic2any 可能返回单个 Blob 或 Blob 数组
        var resultBlob = Array.isArray(blob) ? blob[0] : blob;
        loadImageFromSource(resultBlob);
        applySettings(defaults);
      } catch (err) {
        console.error('HEIC 转换失败:', err);
        convertingHeic = false;
        showHeicOverlay(false);
        alert('格式不支持，请尝试截图后上传');
        return;
      }
      convertingHeic = false;
      showHeicOverlay(false);
    } else if (isHeic) {
      // heic2any 库未加载
      alert('HEIC 格式需要 heic2any 库支持，请检查网络后刷新重试');
      return;
    } else {
      // 普通 JPG/PNG → 原有流程
      loadImageFromSource(file);
      applySettings(defaults);
    }
  };

  fileInput.addEventListener('change', fileInputHandler);

  // ================================================================
  //  图片加载
  // ================================================================
  function loadImageFromSource(imgSrc) {
    const img = new Image();
    img.onload = async function () {
      sourceImage   = img;
      faceLandmarks = null;
      liquifyStrokes = [];
      activeStrokeCount = 0;
      currentStrokePts = [];
      isBrushing = false;
      if (liquifyActive) exitLiquifyMode();
      resetHistory();
      selectFilter('none');
      sliderFilterStr.value = 100;
      valFilterStr.textContent = '100%';
      filterStrength = 100;
      render();
      if (smartToggle.checked) await detectFace();
    };
    img.onerror = function () {
      alert('图片加载失败，请重试。');
    };
    var objUrl = (imgSrc instanceof Blob || imgSrc instanceof File)
      ? URL.createObjectURL(imgSrc)
      : null;
    img.src = objUrl || imgSrc;
    // 图片加载后释放 Object URL
    if (objUrl) {
      img.addEventListener('load', function () { URL.revokeObjectURL(objUrl); }, { once: true });
      img.addEventListener('error', function () { URL.revokeObjectURL(objUrl); }, { once: true });
    }
  }

  // ================================================================
  //  文件选择
  // ================================================================
  // (文件上传处理器已在此文件前部注册，含 HEIC 转换支持)

  // ================================================================
  //  摄像头
  // ================================================================
  cameraBtn.addEventListener('click', async function () {
    if (stream) { captureFrame(); return; }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      cameraBtn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
        </svg>
        点击拍摄
      `;
    } catch (err) {
      alert('无法访问摄像头：' + err.message);
    }
  });

  function captureFrame() {
    if (!stream || video.readyState < 2) return;
    const tc = document.createElement('canvas');
    tc.width = video.videoWidth;
    tc.height = video.videoHeight;
    tc.getContext('2d').drawImage(video, 0, 0);
    loadImageFromSource(tc.toDataURL('image/jpeg', 0.9));
    applySettings(defaults);
    stopCamera();
    cameraBtn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
      </svg>
      拍照
    `;
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
      video.srcObject = null;
    }
  }

  // ================================================================
  //  智能美颜开关
  // ================================================================
  smartToggle.addEventListener('change', async function () {
    if (this.checked) {
      smartSliders.classList.remove('hidden');
      if (!modelsReady && workerSupported) {
        // Worker 正在初始化或已失败，等待
        if (!detectWorker) initWorker();
      } else if (!modelsReady) {
        await loadModelsMainThread();
      }
      if (!faceLandmarks) await detectFace();
      else render();
    } else {
      smartSliders.classList.add('hidden');
      render();
    }
  });

  // ================================================================
  //  滑块事件（input 实时预览不记录历史，change 松开后记录）
  // ================================================================
  [sliderBrightness, sliderContrast, sliderSaturate, sliderSmoothing, sliderRedEye,
   sliderSlimFace, sliderSmallHead, sliderBigEye, sliderTeethWhiten]
    .forEach(function (slider) {
      slider.addEventListener('input', onSliderInput);
      slider.addEventListener('change', onSliderChange);
    });

  function onSliderInput() {
    syncCurrentSettings();
    valBrightness.textContent = currentSettings.brightness + '%';
    valContrast.textContent   = currentSettings.contrast   + '%';
    valSaturate.textContent   = currentSettings.saturation + '%';
    valSmoothing.textContent  = currentSettings.smoothness + '%';
    valRedEye.textContent     = currentSettings.redeye     + '%';
    valSlimFace.textContent   = currentSettings.slimFace   + '%';
    valSmallHead.textContent  = currentSettings.smallHead  + '%';
    valBigEye.textContent     = currentSettings.bigEye     + '%';
    valTeethWhiten.textContent = currentSettings.teethWhiten + '%';
    scheduleRender();
  }

  function onSliderChange() {
    syncCurrentSettings();
    pushHistory();
  }

  // ================================================================
  //  重置按钮
  // ================================================================
  resetBtn.addEventListener('click', function () {
    applySettings(defaults);
    selectFilter('none');
    sliderFilterStr.value = 100;
    valFilterStr.textContent = '100%';
    filterStrength = 100;
    // 同时清除所有液化笔画
    if (activeStrokeCount > 0) {
      liquifyStrokes = [];
      activeStrokeCount = 0;
      pushHistory();
    }
  });

  // ── 撤销 / 重做按钮 ──
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);

  // ── 键盘快捷键 Ctrl+Z / Ctrl+Y ──
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      undo();
    } else if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      redo();
    }
  });

  // ── 双指滑动手势 撤销/重做（移动端） ──
  var gestureStartX = 0;
  var gestureActive = false;
  var gestureMinDist = 60; // 最小滑动距离

  canvasWrapper.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2 && !liquifyActive && !cropper) {
      gestureActive = true;
      gestureStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    } else {
      gestureActive = false;
    }
  }, { passive: true });

  canvasWrapper.addEventListener('touchmove', function (e) {
    if (!gestureActive || e.touches.length !== 2) return;
  }, { passive: true });

  canvasWrapper.addEventListener('touchend', function (e) {
    if (!gestureActive) return;
    gestureActive = false;
    if (e.touches.length > 0) return; // 还有手指在屏幕上
    var endX = (e.changedTouches[0].clientX + (e.changedTouches[1] ? e.changedTouches[1].clientX : e.changedTouches[0].clientX)) / 2;
    var dx = endX - gestureStartX;
    if (Math.abs(dx) < gestureMinDist) return;

    if (dx > 0) {
      // 右滑 → 重做
      redo();
      showToast('重做');
    } else {
      // 左滑 → 撤销
      undo();
      showToast('撤销');
    }
  });

  // ================================================================
  //  手动液化 —— 模式管理与画布交互
  // ================================================================

  // DOM 引用
  var toolBeautyBtn      = document.getElementById('toolBeauty');
  var toolLiquifyBtn     = document.getElementById('toolLiquify');
  var liquifyControls    = document.getElementById('liquifyControls');
  var brushSizeSlider    = document.getElementById('brushSize');
  var liquifyStrSlider   = document.getElementById('liquifyStrength');
  var brushSizeVal       = document.getElementById('brushSizeVal');
  var liquifyStrVal      = document.getElementById('liquifyStrVal');
  var resetLiquifyBtn    = document.getElementById('resetLiquifyBtn');
  brushCursorEl          = document.getElementById('brushCursor');

  function enterLiquifyMode() {
    if (!sourceImage) {
      showToast('请先选择一张图片');
      return;
    }
    liquifyActive = true;
    toolBeautyBtn.classList.remove('bg-pink-600', 'text-white');
    toolBeautyBtn.classList.add('bg-gray-800', 'text-gray-400');
    toolLiquifyBtn.classList.remove('bg-gray-800', 'text-gray-400', 'hover:bg-gray-700');
    toolLiquifyBtn.classList.add('bg-violet-600', 'text-white');
    liquifyControls.classList.remove('hidden');
    if (compareMode === 'slide') exitSlideMode();
    compareModeBtn.classList.add('pointer-events-none', 'opacity-30');
    updateBrushCursorSize();
    canvas.style.cursor = 'none';
    hideBrushCursor();
  }

  function exitLiquifyMode() {
    liquifyActive = false;
    isBrushing = false;
    currentStrokePts = [];
    toolBeautyBtn.classList.remove('bg-gray-800', 'text-gray-400');
    toolBeautyBtn.classList.add('bg-pink-600', 'text-white');
    toolLiquifyBtn.classList.remove('bg-violet-600', 'text-white');
    toolLiquifyBtn.classList.add('bg-gray-800', 'text-gray-400', 'hover:bg-gray-700');
    liquifyControls.classList.add('hidden');
    compareModeBtn.classList.remove('pointer-events-none', 'opacity-30');
    hideBrushCursor();
    canvas.style.cursor = '';
  }

  function resetLiquify() {
    if (activeStrokeCount === 0 && currentStrokePts.length === 0) return;
    liquifyStrokes = [];
    activeStrokeCount = 0;
    currentStrokePts = [];
    isBrushing = false;
    pushHistory();
    scheduleRender();
    showToast('液化已重置');
  }

  resetLiquifyBtn.addEventListener('click', resetLiquify);

  function updateBrushCursorSize() {
    var d = brushSize * 2;
    brushCursorEl.style.width  = d + 'px';
    brushCursorEl.style.height = d + 'px';
  }

  brushSizeSlider.addEventListener('input', function () {
    brushSize = +this.value;
    brushSizeVal.textContent = brushSize + 'px';
    updateBrushCursorSize();
  });

  liquifyStrSlider.addEventListener('input', function () {
    liquifyStr = +this.value;
    liquifyStrVal.textContent = liquifyStr;
  });

  // ── 液化笔刷坐标转换 ──
  function getCanvasPos(e) {
    var rect = canvas.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width  / rect.width),
      y: (clientY - rect.top)  * (canvas.height / rect.height)
    };
  }

  function updateBrushCursorPos(e) {
    var rect = canvas.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    brushCursorEl.style.left = (clientX - rect.left) + 'px';
    brushCursorEl.style.top  = (clientY - rect.top)  + 'px';
  }

  function showBrushCursor(e) {
    if (!liquifyActive) return;
    brushCursorEl.classList.remove('hidden');
    updateBrushCursorPos(e);
  }

  function hideBrushCursor() {
    brushCursorEl.classList.add('hidden');
  }

  function onLiquifyStart(e) {
    if (!liquifyActive || !sourceImage || cameraMode) return;
    e.preventDefault();
    e.stopPropagation();
    isBrushing = true;
    currentStrokePts = [];
    var pos = getCanvasPos(e);
    currentStrokePts.push({ x: pos.x, y: pos.y });
    brushCursorEl.classList.remove('hidden');
    updateBrushCursorPos(e);
    // 在笔画开始时捕获橡皮擦状态（而非结束时）
    currentStrokeEraser = eraserMode;
  }

  function onLiquifyMove(e) {
    if (!isBrushing) return;
    e.preventDefault();
    var pos = getCanvasPos(e);
    var last = currentStrokePts[currentStrokePts.length - 1];
    var dsq = (pos.x - last.x) * (pos.x - last.x) + (pos.y - last.y) * (pos.y - last.y);
    if (dsq < 9) return;
    currentStrokePts.push({ x: pos.x, y: pos.y });
    // 橡皮擦模式：反向涂抹
    if (eraserMode) {
      applyLiquifySegment(ctx, canvas.width, canvas.height,
        pos.x, pos.y, last.x, last.y, brushSize, liquifyStr);
    } else {
      applyLiquifySegment(ctx, canvas.width, canvas.height,
        last.x, last.y, pos.x, pos.y, brushSize, liquifyStr);
    }
    updateBrushCursorPos(e);
  }

  function onLiquifyEnd(e) {
    if (!isBrushing) return;
    isBrushing = false;
    if (currentStrokePts.length > 1) {
      // 将画布坐标归一化到源图坐标（分辨率无关，支持 resize 和导出）
      var sx = sourceImage.width  / canvas.width;
      var sy = sourceImage.height / canvas.height;
      var avgScale = (canvas.width / sourceImage.width + canvas.height / sourceImage.height) / 2;
      var normPts = currentStrokePts.map(function (p) {
        return { x: p.x * sx, y: p.y * sy };
      });
      // 截断 undo 之后的数据（新笔画覆盖旧分支），追加新笔画
      liquifyStrokes = liquifyStrokes.slice(0, activeStrokeCount);
      liquifyStrokes.push({
        points: normPts,
        radius: brushSize / avgScale,
        strength: liquifyStr,
        eraser: currentStrokeEraser
      });
      activeStrokeCount = liquifyStrokes.length;
      pushHistory();
    }
    currentStrokePts = [];
    hideBrushCursor();
  }

  // ── Canvas 悬停显示笔刷光标 ──
  canvas.addEventListener('mouseenter', function (e) {
    if (liquifyActive && sourceImage && !cameraMode) showBrushCursor(e);
  });
  canvas.addEventListener('mouseleave', function () {
    hideBrushCursor();
    if (isBrushing) onLiquifyEnd();
  });

  // 笔刷光标跟随鼠标
  canvas.addEventListener('mousemove', function (e) {
    if (!isBrushing && liquifyActive && sourceImage && !cameraMode) {
      updateBrushCursorPos(e);
    }
  });

  // ── 工具切换按钮 ──
  toolBeautyBtn.addEventListener('click', function () {
    if (!liquifyActive) return;
    exitLiquifyMode();
  });

  toolLiquifyBtn.addEventListener('click', function () {
    if (liquifyActive) return;
    enterLiquifyMode();
  });

  // ================================================================
  //  自定义 LUT 滤镜上传
  // ================================================================
  var lutFileInput = document.getElementById('lutFileInput');
  var uploadLUTBtn = document.getElementById('uploadLUTBtn');
  var CUSTOM_LUTS_KEY = 'customLUTs';

  uploadLUTBtn.addEventListener('click', function () {
    lutFileInput.click();
  });

  lutFileInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    lutFileInput.value = '';

    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        // 缩放到 512x512
        var lutCanvas = document.createElement('canvas');
        lutCanvas.width = 512;
        lutCanvas.height = 512;
        var lutCtx = lutCanvas.getContext('2d');
        lutCtx.drawImage(img, 0, 0, 512, 512);

        var filterId = 'custom_' + Date.now();
        var filterName = file.name.replace(/\.(png|jpe?g|webp)$/i, '').substring(0, 10);

        // 生成预览
        var sampleImg = document.createElement('canvas');
        sampleImg.width = 80; sampleImg.height = 55;
        var sCtx = sampleImg.getContext('2d');
        if (LiteBeautyFilters && LiteBeautyFilters.isInitialized()) {
          // 使用 LUT 引擎的 sampleImage
          var tempCanvas = document.createElement('canvas');
          tempCanvas.width = 160; tempCanvas.height = 110;
          var tCtx = tempCanvas.getContext('2d');
          var sampleSrc = document.createElement('canvas');
          sampleSrc.width = 160; sampleSrc.height = 110;
          // 简单创建一个渐变色样本
          var gradCtx = sampleSrc.getContext('2d');
          var grad = gradCtx.createLinearGradient(0, 0, 160, 0);
          grad.addColorStop(0, '#f4c89a'); grad.addColorStop(0.3, '#87CEEB');
          grad.addColorStop(0.6, '#ffffff'); grad.addColorStop(1, '#7ec850');
          gradCtx.fillStyle = grad;
          gradCtx.fillRect(0, 0, 160, 110);
          LiteBeautyFilters.applyToContext(gradCtx, 160, 110, lutCanvas, 1.0);
          sCtx.drawImage(sampleSrc, 0, 0, 80, 55);
        } else {
          sCtx.drawImage(img, 0, 0, 80, 55);
        }

        // 添加到滤镜引擎
        if (LiteBeautyFilters && LiteBeautyFilters.isInitialized()) {
          LiteBeautyFilters.addCustomFilter(filterId, filterName, lutCanvas, sampleImg);
        }

        // 持久化存储
        saveCustomLUT(filterId, filterName, lutCanvas);

        renderFilterList();
        showToast('自定义滤镜已添加');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  function saveCustomLUT(id, name, lutCanvas) {
    var dataUrl = lutCanvas.toDataURL('image/png');
    var items = storageGet(CUSTOM_LUTS_KEY, []);
    items.push({ id: id, name: name, dataUrl: dataUrl });
    // 限制最多 5 个自定义滤镜
    if (items.length > 5) items = items.slice(-5);
    storageSet(CUSTOM_LUTS_KEY, items);
  }

  function loadCustomLUTs() {
    var items = storageGet(CUSTOM_LUTS_KEY, []);
    if (items.length === 0 || !LiteBeautyFilters || !LiteBeautyFilters.isInitialized()) return;

    items.forEach(function (item) {
      var img = new Image();
      img.onload = function () {
        var lutCanvas = document.createElement('canvas');
        lutCanvas.width = 512;
        lutCanvas.height = 512;
        var lutCtx = lutCanvas.getContext('2d');
        lutCtx.drawImage(img, 0, 0, 512, 512);

        var preview = document.createElement('canvas');
        preview.width = 80; preview.height = 55;
        var pCtx = preview.getContext('2d');
        var sampleSrc = document.createElement('canvas');
        sampleSrc.width = 160; sampleSrc.height = 110;
        var gCtx = sampleSrc.getContext('2d');
        var grad = gCtx.createLinearGradient(0, 0, 160, 0);
        grad.addColorStop(0, '#f4c89a'); grad.addColorStop(0.3, '#87CEEB');
        grad.addColorStop(0.6, '#ffffff'); grad.addColorStop(1, '#7ec850');
        gCtx.fillStyle = grad;
        gCtx.fillRect(0, 0, 160, 110);
        LiteBeautyFilters.applyToContext(gCtx, 160, 110, lutCanvas, 1.0);
        pCtx.drawImage(sampleSrc, 0, 0, 80, 55);

        LiteBeautyFilters.addCustomFilter(item.id, item.name, lutCanvas, preview);
        renderFilterList();
      };
      img.src = item.dataUrl;
    });
  }

  // ================================================================
  //  水印
  // ================================================================
  var watermarkToggle   = document.getElementById('watermarkToggle');
  var watermarkSettings = document.getElementById('watermarkSettings');
  var watermarkText     = document.getElementById('watermarkText');
  var watermarkOpacity  = document.getElementById('watermarkOpacity');
  var watermarkOpacityVal = document.getElementById('watermarkOpacityVal');
  var watermarkPos      = 'br'; // 默认右下

  watermarkToggle.addEventListener('change', function () {
    watermarkSettings.classList.toggle('hidden', !this.checked);
  });

  watermarkOpacity.addEventListener('input', function () {
    watermarkOpacityVal.textContent = this.value + '%';
  });

  var wmPosButtons = document.querySelectorAll('.wm-pos-btn');
  wmPosButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      watermarkPos = btn.dataset.pos;
      wmPosButtons.forEach(function (b) {
        b.classList.remove('bg-violet-600', 'text-white');
        b.classList.add('bg-gray-700', 'text-gray-400');
      });
      btn.classList.remove('bg-gray-700', 'text-gray-400');
      btn.classList.add('bg-violet-600', 'text-white');
    });
  });

  /** 在画布上绘制水印 */
  function drawWatermark(ctx, w, h) {
    if (!watermarkToggle.checked) return;
    var text = watermarkText.value.trim();
    if (!text) return;

    var opacity = (+watermarkOpacity.value) / 100;
    var fontSize = Math.max(16, Math.round(w / 28));
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = fontSize + 'px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = fontSize / 12;
    var metrics = ctx.measureText(text);
    var tw = metrics.width;
    var th = fontSize;
    var padding = Math.round(w * 0.03);

    var x, y;
    switch (watermarkPos) {
      case 'tl': x = padding; y = padding + th; break;
      case 'tr': x = w - tw - padding; y = padding + th; break;
      case 'bl': x = padding; y = h - padding; break;
      case 'br': x = w - tw - padding; y = h - padding; break;
      default:   x = (w - tw) / 2; y = (h + th) / 2; break;
    }
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ── Alt 键橡皮擦模式 ──
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Alt' && liquifyActive) {
      e.preventDefault();
      eraserMode = true;
      brushCursorEl.style.borderColor = 'rgba(59,130,246,0.8)';
      brushCursorEl.style.background = 'rgba(59,130,246,0.1)';
    }
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'Alt') {
      eraserMode = false;
      brushCursorEl.style.borderColor = 'rgba(236,72,153,0.7)';
      brushCursorEl.style.background = 'rgba(236,72,153,0.08)';
    }
  });
  // 窗口失焦时重置橡皮擦状态
  window.addEventListener('blur', function () {
    eraserMode = false;
    if (brushCursorEl) {
      brushCursorEl.style.borderColor = 'rgba(236,72,153,0.7)';
      brushCursorEl.style.background = 'rgba(236,72,153,0.08)';
    }
  });

  // ================================================================
  //  预设管理
  // ================================================================
  function loadPresets() {
    presets = storageGet(PRESETS_KEY, null);
    if (!presets || presets.length === 0) {
      presets = DEFAULT_PRESETS.map(p => ({
        name: p.name,
        settings: { ...p.settings }
      }));
      storageSet(PRESETS_KEY, presets);
    }
    renderPresetList();
  }

  function savePresetsToStorage() {
    storageSet(PRESETS_KEY, presets);
  }

  function renderPresetList() {
    presetListContainer.innerHTML = '';

    if (presets.length === 0) {
      presetListContainer.innerHTML =
        '<span class="text-xs text-gray-600 py-2 whitespace-nowrap">暂无预设</span>';
      return;
    }

    presets.forEach((preset, index) => {
      const card = document.createElement('div');
      card.className =
        'preset-card flex-shrink-0 flex items-center gap-1.5 bg-gray-800 hover:bg-gray-750 ' +
        'rounded-lg pl-3 pr-1.5 py-2 cursor-pointer select-none';
      card.dataset.index = index;
      card.innerHTML = `
        <span class="text-xs font-medium text-gray-200 whitespace-nowrap">${escapeHTML(preset.name)}</span>
        <span class="delete-btn flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full
          text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition"
          title="删除预设">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"
            stroke-linecap="round" stroke-linejoin="round" stroke-width="3">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </span>
      `;
      presetListContainer.appendChild(card);
    });
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  presetListContainer.addEventListener('click', function (e) {
    const card = e.target.closest('.preset-card');
    if (!card) return;
    const index = +card.dataset.index;
    if (isNaN(index) || index < 0 || index >= presets.length) return;

    if (e.target.closest('.delete-btn')) {
      deletePreset(index);
      return;
    }

    applySettings(presets[index].settings);
    // 恢复预设中保存的滤镜状态
    var p = presets[index];
    if (p.filter !== undefined) {
      currentFilter = p.filter;
      filterStrength = p.filterStr !== undefined ? p.filterStr : 100;
      sliderFilterStr.value = filterStrength;
      valFilterStr.textContent = filterStrength + '%';
      renderFilterList();
    }
    scheduleRender();
  });

  function deletePreset(index) {
    if (index < 0 || index >= presets.length) return;
    presets.splice(index, 1);
    savePresetsToStorage();
    renderPresetList();
  }

  // ================================================================
  //  滤镜列表 UI
  // ================================================================
  function renderFilterList() {
    if (!filterList || typeof LiteBeautyFilters === 'undefined') return;
    filterList.innerHTML = '';

    var filters = LiteBeautyFilters.getFilterList();
    filters.forEach(function (f) {
      var card = document.createElement('div');
      card.className = 'filter-card flex-shrink-0 flex flex-col items-center gap-1 cursor-pointer select-none rounded-lg p-1.5';
      card.dataset.filterId = f.id;

      if (f.id === currentFilter) {
        card.classList.add('active');
      }

      // 预览缩略图
      var preview = LiteBeautyFilters.getPreview(f.id);
      var thumb = document.createElement('canvas');
      thumb.width = 72;
      thumb.height = 50;
      thumb.className = 'rounded-md';
      var tCtx = thumb.getContext('2d');
      if (preview) {
        tCtx.drawImage(preview, 0, 0, 72, 50);
      }

      // 名称
      var label = document.createElement('span');
      label.className = 'text-xs text-gray-400 whitespace-nowrap';
      label.textContent = f.name;

      card.appendChild(thumb);
      card.appendChild(label);
      filterList.appendChild(card);
    });

    // 控制强度滑块可见性
    if (filterStrengthRow) {
      filterStrengthRow.classList.toggle('hidden', currentFilter === 'none');
    }
  }

  function selectFilter(filterId) {
    if (currentFilter === filterId) return;
    currentFilter = filterId;
    renderFilterList();
    scheduleRender();
  }

  // 滤镜卡片点击
  if (filterList) {
    filterList.addEventListener('click', function (e) {
      var card = e.target.closest('.filter-card');
      if (!card) return;
      var filterId = card.dataset.filterId;
      if (filterId) selectFilter(filterId);
    });
  }

  // 滤镜强度滑块
  if (sliderFilterStr) {
    sliderFilterStr.addEventListener('input', function () {
      valFilterStr.textContent = this.value + '%';
      scheduleRender();
    });
    sliderFilterStr.addEventListener('change', function () {
      syncCurrentSettings();
      pushHistory();
    });
  }

  savePresetBtn.addEventListener('click', function () {
    syncCurrentSettings();
    const name = (window.prompt('请输入预设名称：') || '').trim();
    if (!name) return;

    if (presets.some(p => p.name === name)) {
      if (!confirm('预设"' + name + '"已存在，是否覆盖？')) return;
      presets = presets.filter(p => p.name !== name);
    }

    presets.push({
      name: name,
      settings: { ...currentSettings },
      filter: currentFilter,
      filterStr: filterStrength
    });
    savePresetsToStorage();
    renderPresetList();
  });

  // ================================================================
  //  高质量图片导出
  // ================================================================
  var savePhotoBtn    = document.getElementById('savePhotoBtn');
  var exportQuality   = document.getElementById('exportQuality');
  var exportQualityVal = document.getElementById('exportQualityVal');
  var exportFormat    = 'jpeg';  // 当前导出格式

  // 导出格式选择
  var fmtButtons = document.querySelectorAll('.export-fmt-btn');
  fmtButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      exportFormat = btn.dataset.fmt;
      fmtButtons.forEach(function (b) {
        b.classList.remove('bg-pink-600', 'text-white');
        b.classList.add('bg-gray-700', 'text-gray-400');
      });
      btn.classList.remove('bg-gray-700', 'text-gray-400', 'hover:bg-gray-600');
      btn.classList.add('bg-pink-600', 'text-white');
      // PNG 不支持质量调节
      exportQuality.disabled = (exportFormat === 'png');
      exportQuality.style.opacity = exportFormat === 'png' ? '0.4' : '1';
      exportQualityVal.textContent = exportFormat === 'png' ? '无损' : exportQuality.value + '%';
    });
  });

  exportQuality.addEventListener('input', function () {
    exportQualityVal.textContent = this.value + '%';
  });

  savePhotoBtn.addEventListener('click', function () {
    if (!sourceImage) {
      showToast('请先选择一张图片');
      return;
    }
    exportImage();
  });

  function exportImage() {
    var srcW = sourceImage.width;
    var srcH = sourceImage.height;
    var MAX  = 4096;

    // 计算导出尺寸：保持原图纵横比，长边不超过 4096px
    var exportW, exportH;
    if (srcW >= srcH && srcW > MAX) {
      exportW = MAX;
      exportH = Math.round(MAX * srcH / srcW);
    } else if (srcH > MAX) {
      exportH = MAX;
      exportW = Math.round(MAX * srcW / srcH);
    } else {
      exportW = srcW;
      exportH = srcH;
    }

    syncCurrentSettings();

    // 创建高分辨率导出画布
    var exportCanvas = document.createElement('canvas');
    exportCanvas.width  = exportW;
    exportCanvas.height = exportH;
    var exCtx = exportCanvas.getContext('2d', { willReadFrequently: true });

    // ── 第一步：基础滤镜 ──
    exCtx.filter = 'brightness(' + currentSettings.brightness + '%) ' +
                   'contrast('   + currentSettings.contrast   + '%) ' +
                   'saturate('   + currentSettings.saturation + '%)';
    exCtx.drawImage(sourceImage, 0, 0, exportW, exportH);
    exCtx.filter = 'none';

    // ── LUT 滤镜 ──
    if (currentFilter !== 'none' && filterStrength > 0 && LiteBeautyFilters.isInitialized()) {
      var expLut = LiteBeautyFilters.getLUT(currentFilter);
      if (expLut) {
        LiteBeautyFilters.applyToContext(exCtx, exportW, exportH, expLut, filterStrength / 100);
      }
    }

    // ── 第二步：智能美颜（仅在开启且检测到人脸时） ──
    if (smartToggle.checked && faceLandmarks) {
      var scale = exportW / sourceImage.width;

      if (currentSettings.smoothness > 0) {
        applyExportSkinSmoothing(exCtx, exportCanvas, scale);
      }
      if (currentSettings.redeye > 0) {
        applyExportRedEye(exCtx, exportCanvas, scale);
      }
      // 导出中应用液化变形
      if (currentSettings.slimFace > 0 || currentSettings.smallHead > 0) {
        var exportPts = getScaledPositions(scale);
        applyFaceWarp(exCtx, exportCanvas.width, exportCanvas.height, exportPts);
      }
      // 导出版大眼
      if (currentSettings.bigEye > 0) {
        var exportPts2 = getScaledPositions(scale);
        applyBigEyeWarp(exCtx, exportCanvas.width, exportCanvas.height, exportPts2, currentSettings.bigEye);
      }
      // 导出版牙齿美白
      if (currentSettings.teethWhiten > 0) {
        applyTeethWhitening(exCtx, exportCanvas.width, exportCanvas.height, getScaledPositions(scale), currentSettings.teethWhiten);
      }
    }

    // ── 导出手动液化效果（最后一步） ──
    if (activeStrokeCount > 0) {
      applyAllLiquifyStrokes(exCtx, exportCanvas.width, exportCanvas.height);
    }

    // ── 水印（导出最顶层） ──
    drawWatermark(exCtx, exportCanvas.width, exportCanvas.height);

    // ── 根据所选格式导出 ──
    var now      = new Date();
    var timeStr  = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');

    var mime, ext, quality;
    if (exportFormat === 'png') {
      mime = 'image/png'; ext = '.png'; quality = undefined;
    } else if (exportFormat === 'webp') {
      mime = 'image/webp'; ext = '.webp'; quality = (+exportQuality.value) / 100;
    } else {
      mime = 'image/jpeg'; ext = '.jpg'; quality = (+exportQuality.value) / 100;
    }

    exportCanvas.toBlob(function (blob) {
      if (!blob) {
        showToast('导出失败（可能浏览器不支持此格式），请重试');
        return;
      }
      var name = 'LiteBeauty_' + timeStr + ext;
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href     = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('保存成功 (' + exportFormat.toUpperCase() + ')');
    }, mime, quality);
  }

  /** 导出级磨皮：与实时渲染算法一致，适配导出分辨率 */
  function applyExportSkinSmoothing(exCtx, exportCanvas, scale) {
    var pts = getScaledPositions(scale);

    // 离屏画布用于模糊
    var blurCanvas = document.createElement('canvas');
    blurCanvas.width  = exportCanvas.width;
    blurCanvas.height = exportCanvas.height;
    var blurCtx = blurCanvas.getContext('2d');

    var blurRadius = (currentSettings.smoothness / 100) * (exportCanvas.width / 28);
    blurCtx.filter = 'blur(' + blurRadius + 'px)';
    blurCtx.drawImage(exportCanvas, 0, 0);
    blurCtx.filter = 'none';

    exCtx.save();
    buildFaceClipPath(exCtx, pts);
    exCtx.clip('evenodd');
    exCtx.globalAlpha = (currentSettings.smoothness / 100) * 0.65;
    exCtx.drawImage(blurCanvas, 0, 0);
    exCtx.restore();
  }

  /** 导出级红眼消除：逐像素处理 */
  function applyExportRedEye(exCtx, exportCanvas, scale) {
    var pts = getScaledPositions(scale);
    [pts.slice(36, 42), pts.slice(42, 48)].forEach(function (eyeRing) {
      var xs = eyeRing.map(function (p) { return p.x; });
      var ys = eyeRing.map(function (p) { return p.y; });
      var box = {
        x: Math.floor(Math.min.apply(null, xs)),
        y: Math.floor(Math.min.apply(null, ys)),
        w: Math.ceil (Math.max.apply(null, xs) - Math.min.apply(null, xs)),
        h: Math.ceil (Math.max.apply(null, ys) - Math.min.apply(null, ys))
      };
      var padX = box.w * 0.25;
      var padY = box.h * 0.25;
      box.x = Math.max(0, Math.floor(box.x - padX));
      box.y = Math.max(0, Math.floor(box.y - padY));
      box.w = Math.min(Math.ceil(box.w + padX * 2), exportCanvas.width  - box.x);
      box.h = Math.min(Math.ceil(box.h + padY * 2), exportCanvas.height - box.y);

      if (box.w <= 0 || box.h <= 0) return;

      var imageData = exCtx.getImageData(box.x, box.y, box.w, box.h);
      var pixels = imageData.data;
      var factor = currentSettings.redeye / 100;

      for (var i = 0; i < pixels.length; i += 4) {
        var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (r > 50 && r > g * 1.4 && r > b * 1.4) {
          var gray = (g + b) / 2;
          pixels[i]     = r - (r - gray) * factor;
          pixels[i + 1] = g + (gray - g) * factor * 0.35;
          pixels[i + 2] = b + (gray - b) * factor * 0.35;
        }
      }
      exCtx.putImageData(imageData, box.x, box.y);
    });
  }

  // ================================================================
  //  Toast 通知
  // ================================================================
  var toastEl   = document.getElementById('toast');
  var toastTimer = null;

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('opacity-100', 'translate-y-0');
    toastEl.classList.remove('opacity-0', 'translate-y-4');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.add('opacity-0', 'translate-y-4');
      toastEl.classList.remove('opacity-100', 'translate-y-0');
    }, 1800);
  }

  // ================================================================
  //  PWA 安装按钮
  // ================================================================
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    installBtn.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async function () {
    if (!installPrompt) return;
    const { outcome } = await installPrompt.prompt();
    if (outcome === 'accepted') {
      installBtn.classList.add('hidden');
    }
    installPrompt = null;
  });

  // 已安装后隐藏按钮
  window.addEventListener('appinstalled', function () {
    installBtn.classList.add('hidden');
    installPrompt = null;
  });

  // ================================================================
  //  打赏（爱发电 + GitHub Star 纯静态链接，无需额外 JS）
  // ================================================================

  // ================================================================
  //  窗口 resize 防抖重绘
  // ================================================================
  let resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  // ================================================================
  //  页面卸载释放资源
  // ================================================================
  window.addEventListener('beforeunload', function () {
    stopCamera();
    stopLiveCamera();
    if (detectWorker) {
      detectWorker.terminate();
      detectWorker = null;
    }
  });

  // ================================================================
  //  初始化
  // ================================================================
  function init() {
    syncCurrentSettings();
    resetHistory();
    loadPresets();

    // 初始化滤镜引擎
    if (typeof LiteBeautyFilters !== 'undefined') {
      LiteBeautyFilters.init();
      renderFilterList();
      loadCustomLUTs(); // 加载用户上传的自定义滤镜
    }

    initWorker(); // 尝试启动 Worker，失败则回退

    // 批量处理初始化
    initBatchProcessing();
  }

  // ================================================================
  //  批量处理
  // ================================================================
  function initBatchProcessing() {
    var batchFileInput = document.getElementById('batchFileInput');
    var batchBtn       = document.getElementById('batchBtn');
    var batchPanel     = document.getElementById('batchPanel');
    var batchThumbList = document.getElementById('batchThumbList');
    var batchCount     = document.getElementById('batchCount');
    var batchClearBtn  = document.getElementById('batchClearBtn');
    var batchExportBtn = document.getElementById('batchExportBtn');
    var batchImages    = []; // [{name, img}]

    batchBtn.addEventListener('click', function () {
      batchFileInput.click();
    });

    batchFileInput.addEventListener('change', function (e) {
      var files = Array.from(e.target.files);
      batchFileInput.value = '';
      if (!files.length) return;

      batchPanel.classList.remove('hidden');
      var loaded = 0;
      files.forEach(function (file) {
        var isHeic = /\.(heic|heif)$/i.test(file.name);
        if (isHeic && typeof heic2any !== 'undefined') {
          showHeicOverlay(true);
          heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 }).then(function (blob) {
            var resultBlob = Array.isArray(blob) ? blob[0] : blob;
            loadBatchImage(resultBlob, file.name);
            loaded++;
            if (loaded === files.length) showHeicOverlay(false);
          }).catch(function () { loaded++; });
        } else {
          loadBatchImage(file, file.name);
          loaded++;
        }
      });
    });

    function loadBatchImage(src, name) {
      var img = new Image();
      var objUrl = (src instanceof Blob || src instanceof File) ? URL.createObjectURL(src) : null;
      img.onload = function () {
        batchImages.push({ name: name.replace(/\.(jpg|jpeg|png|webp|heic|heif)$/i, '.jpg'), img: img, _objUrl: objUrl });
        batchCount.textContent = batchImages.length + ' 张';
        renderBatchThumbs();
      };
      img.src = objUrl || src;
    }

    function renderBatchThumbs() {
      batchThumbList.innerHTML = '';
      batchImages.forEach(function (item, idx) {
        var card = document.createElement('div');
        card.className = 'flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden bg-gray-800 relative';
        var c = document.createElement('canvas');
        c.width = 56; c.height = 56;
        var tCtx = c.getContext('2d');
        var s = Math.min(56 / item.img.width, 56 / item.img.height);
        var dw = item.img.width * s, dh = item.img.height * s;
        tCtx.drawImage(item.img, (56 - dw) / 2, (56 - dh) / 2, dw, dh);
        card.appendChild(c);
        card.title = item.name;
        batchThumbList.appendChild(card);
      });
    }

    batchClearBtn.addEventListener('click', function () {
      // 释放所有 Object URL
      batchImages.forEach(function (item) {
        if (item._objUrl) URL.revokeObjectURL(item._objUrl);
      });
      batchImages = [];
      batchCount.textContent = '0 张';
      batchThumbList.innerHTML = '';
    });

    batchExportBtn.addEventListener('click', function () {
      if (!batchImages.length) { showToast('请先选择图片'); return; }
      if (!sourceImage) {
        // 设置第一张为当前编辑图
        sourceImage = batchImages[0].img;
        resetHistory();
      }
      syncCurrentSettings();
      showToast('开始导出 ' + batchImages.length + ' 张...');
      exportBatchImages();
    });

    function exportBatchImages() {
      var idx = 0;
      function next() {
        if (idx >= batchImages.length) {
          showToast('全部导出完成 (' + batchImages.length + ' 张)');
          return;
        }
        var item = batchImages[idx];
        exportSingleBatchImage(item.img, item.name, function () {
          idx++;
          setTimeout(next, 300); // 间隔 300ms 防止浏览器阻止连续下载
        });
      }
      next();
    }

    function exportSingleBatchImage(img, baseName, callback) {
      var srcW = img.width, srcH = img.height;
      var MAX = 4096;
      var exportW, exportH;
      if (srcW >= srcH && srcW > MAX) {
        exportW = MAX; exportH = Math.round(MAX * srcH / srcW);
      } else if (srcH > MAX) {
        exportH = MAX; exportW = Math.round(MAX * srcW / srcH);
      } else {
        exportW = srcW; exportH = srcH;
      }

      var ec = document.createElement('canvas');
      ec.width = exportW; ec.height = exportH;
      var eCtx = ec.getContext('2d', { willReadFrequently: true });

      eCtx.filter = 'brightness(' + currentSettings.brightness + '%) ' +
                    'contrast('   + currentSettings.contrast   + '%) ' +
                    'saturate('   + currentSettings.saturation + '%)';
      eCtx.drawImage(img, 0, 0, exportW, exportH);
      eCtx.filter = 'none';

      if (currentFilter !== 'none' && filterStrength > 0 && LiteBeautyFilters.isInitialized()) {
        var expLut = LiteBeautyFilters.getLUT(currentFilter);
        if (expLut) LiteBeautyFilters.applyToContext(eCtx, exportW, exportH, expLut, filterStrength / 100);
      }

      // 仅导出基础滤镜 + 水印，不导出 AI 美颜/液化（批量模式下无面部关键点）
      drawWatermark(eCtx, exportW, exportH);

      var now = new Date();
      var timeStr = now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + '_' +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');

      var mime, ext, quality;
      if (exportFormat === 'png') {
        mime = 'image/png'; ext = '.png'; quality = undefined;
      } else if (exportFormat === 'webp') {
        mime = 'image/webp'; ext = '.webp'; quality = (+exportQuality.value) / 100;
      } else {
        mime = 'image/jpeg'; ext = '.jpg'; quality = (+exportQuality.value) / 100;
      }

      ec.toBlob(function (blob) {
        if (!blob) { callback(); return; }
        var name = 'LiteBeauty_' + timeStr + '_' + baseName.replace(/\.[^.]+$/, '') + ext;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        callback();
      }, mime, quality);
    }
  }

  // 注册 Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
        console.log('[App] Service Worker 已注册:', reg.scope);
      }).catch(function (err) {
        console.warn('[App] Service Worker 注册失败:', err.message);
      });
    });
  }

  init();
})();
