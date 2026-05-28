/* ================================================================
   LiteBeauty — LUT 滤镜引擎 (HALD CLUT)
   基于 512x512 身份查找表 + CSS 滤镜生成风格化 LUT
   ================================================================ */

(function () {
  'use strict';

  var LUT_SIZE = 512;
  var LUT_LEVEL = 64; // 每通道 64 级 (6-bit)

  // 缓存：{ filterId: HTMLCanvasElement (LUT), previewCanvas, ... }
  var lutCache = {};
  var identityLUT = null;
  var initialized = false;

  // 预览用的样本渐变小图
  var sampleImage = null;

  // ================================================================
  //  滤镜定义（id / 名称 / CSS 滤镜组合）
  //  CSS 滤镜作用于身份 LUT，生成对应的风格 LUT
  // ================================================================
  var FILTERS = [
    { id: 'none',    name: '原图',   css: '' },
    { id: 'warm',    name: '暖色',   css: 'sepia(0.3) saturate(1.4) hue-rotate(-15deg)' },
    { id: 'cool',    name: '冷色',   css: 'saturate(0.7) hue-rotate(15deg) brightness(1.05)' },
    { id: 'vintage', name: '复古',   css: 'sepia(0.5) saturate(0.65) contrast(0.85) brightness(0.9)' },
    { id: 'film',    name: '胶片',   css: 'contrast(1.15) saturate(1.2) sepia(0.15) brightness(0.92)' },
    { id: 'bw',      name: '黑白',   css: 'grayscale(1) contrast(1.15) brightness(1.05)' },
    { id: 'fade',    name: '日系',   css: 'brightness(1.2) saturate(0.7) contrast(0.85)' },
    { id: 'teal',    name: '青橙',   css: 'sepia(0.2) saturate(1.5) hue-rotate(150deg) brightness(1.1) contrast(1.05)' },
    { id: 'sunset',  name: '落日',   css: 'sepia(0.35) saturate(1.5) hue-rotate(-30deg) brightness(1.08) contrast(0.95)' }
  ];

  // ================================================================
  //  生成身份 LUT（512x512，每像素存自身颜色）
  //  布局: 64x64 格，每格 8x8 像素
  //  cellX 编码 G, cellY 编码 R, 格内 (bx,by) 编码 B
  // ================================================================
  function generateIdentityLUT() {
    var canvas = document.createElement('canvas');
    canvas.width = LUT_SIZE;
    canvas.height = LUT_SIZE;
    var ctx = canvas.getContext('2d');
    var imageData = ctx.createImageData(LUT_SIZE, LUT_SIZE);
    var data = imageData.data;

    for (var y = 0; y < LUT_SIZE; y++) {
      var cellY = (y / 8) | 0;
      var by = y % 8;

      for (var x = 0; x < LUT_SIZE; x++) {
        var cellX = (x / 8) | 0;
        var bx = x % 8;

        var r = Math.round(cellY * 255 / (LUT_LEVEL - 1));
        var g = Math.round(cellX * 255 / (LUT_LEVEL - 1));
        var b = Math.round((by * 8 + bx) * 255 / (LUT_LEVEL - 1));

        var idx = (y * LUT_SIZE + x) * 4;
        data[idx]     = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // ================================================================
  //  通过 CSS 滤镜作用于身份 LUT 生成风格 LUT
  // ================================================================
  function createFilterLUT(cssFilter) {
    if (!cssFilter) return identityLUT; // 原图直接返回身份 LUT

    var canvas = document.createElement('canvas');
    canvas.width = LUT_SIZE;
    canvas.height = LUT_SIZE;
    var ctx = canvas.getContext('2d');
    ctx.filter = cssFilter;
    ctx.drawImage(identityLUT, 0, 0);
    ctx.filter = 'none';
    return canvas;
  }

  // ================================================================
  //  将 LUT 应用到 ImageData
  //  strength: 0-1，0=原图，1=完全滤镜
  // ================================================================
  function applyLUTToImageData(imageData, lutCanvas, strength) {
    if (!lutCanvas || strength <= 0) return;

    var pixels = imageData.data;
    var w = imageData.width;
    var h = imageData.height;
    var len = pixels.length;

    // 读取 LUT 像素数据
    var lutCtx = lutCanvas.getContext('2d');
    var lutImageData = lutCtx.getImageData(0, 0, LUT_SIZE, LUT_SIZE);
    var lut = lutImageData.data;

    if (strength >= 1) {
      // 全覆盖 - 直接替换
      for (var i = 0; i < len; i += 4) {
        var r = pixels[i];
        var g = pixels[i + 1];
        var b = pixels[i + 2];

        var rIdx = clamp(Math.round(r / 255 * (LUT_LEVEL - 1)), 0, 63);
        var gIdx = clamp(Math.round(g / 255 * (LUT_LEVEL - 1)), 0, 63);
        var bIdx = clamp(Math.round(b / 255 * (LUT_LEVEL - 1)), 0, 63);

        var lutX = gIdx * 8 + (bIdx % 8);
        var lutY = rIdx * 8 + ((bIdx / 8) | 0);
        var li = (lutY * LUT_SIZE + lutX) * 4;

        pixels[i]     = lut[li];
        pixels[i + 1] = lut[li + 1];
        pixels[i + 2] = lut[li + 2];
      }
    } else {
      // 混合模式
      for (var i = 0; i < len; i += 4) {
        var r = pixels[i];
        var g = pixels[i + 1];
        var b = pixels[i + 2];

        var rIdx = clamp(Math.round(r / 255 * (LUT_LEVEL - 1)), 0, 63);
        var gIdx = clamp(Math.round(g / 255 * (LUT_LEVEL - 1)), 0, 63);
        var bIdx = clamp(Math.round(b / 255 * (LUT_LEVEL - 1)), 0, 63);

        var lutX = gIdx * 8 + (bIdx % 8);
        var lutY = rIdx * 8 + ((bIdx / 8) | 0);
        var li = (lutY * LUT_SIZE + lutX) * 4;

        pixels[i]     = lerp(r, lut[li],     strength);
        pixels[i + 1] = lerp(g, lut[li + 1], strength);
        pixels[i + 2] = lerp(b, lut[li + 2], strength);
      }
    }
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // ================================================================
  //  对 Canvas 上下文指定区域应用 LUT
  // ================================================================
  function applyLUTToContext(ctx, w, h, lutCanvas, strength) {
    if (!lutCanvas || strength <= 0 || w <= 0 || h <= 0) return;

    var imageData = ctx.getImageData(0, 0, w, h);
    applyLUTToImageData(imageData, lutCanvas, strength);
    ctx.putImageData(imageData, 0, 0);
  }

  // ================================================================
  //  生成样本预览图（渐变色条用于滤镜卡片）
  // ================================================================
  function createSampleImage() {
    var canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 110;
    var ctx = canvas.getContext('2d');

    // 左上: 肤色渐变
    var skinGrad = ctx.createLinearGradient(0, 0, 160, 0);
    skinGrad.addColorStop(0,   '#f4c89a');
    skinGrad.addColorStop(0.3, '#e8b48c');
    skinGrad.addColorStop(0.6, '#d4a574');
    skinGrad.addColorStop(1,   '#c4956a');
    ctx.fillStyle = skinGrad;
    ctx.fillRect(0, 0, 160, 30);

    // 中上: 天空蓝
    var skyGrad = ctx.createLinearGradient(0, 0, 160, 0);
    skyGrad.addColorStop(0,   '#87CEEB');
    skyGrad.addColorStop(0.4, '#5ba3d9');
    skyGrad.addColorStop(0.7, '#4a90c4');
    skyGrad.addColorStop(1,   '#3b7db5');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 30, 160, 20);

    // 中部: 灰度
    var grayGrad = ctx.createLinearGradient(0, 0, 160, 0);
    grayGrad.addColorStop(0,   '#ffffff');
    grayGrad.addColorStop(0.3, '#bbbbbb');
    grayGrad.addColorStop(0.6, '#777777');
    grayGrad.addColorStop(1,   '#333333');
    ctx.fillStyle = grayGrad;
    ctx.fillRect(0, 50, 160, 30);

    // 下部: 绿植
    var greenGrad = ctx.createLinearGradient(0, 0, 160, 0);
    greenGrad.addColorStop(0,   '#7ec850');
    greenGrad.addColorStop(0.4, '#5a9e3a');
    greenGrad.addColorStop(0.7, '#3d7a28');
    greenGrad.addColorStop(1,   '#2d5c1a');
    ctx.fillStyle = greenGrad;
    ctx.fillRect(0, 80, 160, 30);

    return canvas;
  }

  // ================================================================
  //  生成单个滤镜的预览缩略图 (80x55)
  // ================================================================
  function createPreview(lutCanvas, filterId) {
    if (filterId === 'none') {
      // 原图 - 缩放到 80x55
      var preview = document.createElement('canvas');
      preview.width = 80;
      preview.height = 55;
      var pCtx = preview.getContext('2d');
      pCtx.drawImage(sampleImage, 0, 0, 80, 55);
      return preview;
    }

    // 应用 LUT 到样本图
    var temp = document.createElement('canvas');
    temp.width = sampleImage.width;
    temp.height = sampleImage.height;
    var tCtx = temp.getContext('2d');
    tCtx.drawImage(sampleImage, 0, 0);

    var imageData = tCtx.getImageData(0, 0, temp.width, temp.height);
    applyLUTToImageData(imageData, lutCanvas, 1.0);
    tCtx.putImageData(imageData, 0, 0);

    // 缩放到预览尺寸
    var preview = document.createElement('canvas');
    preview.width = 80;
    preview.height = 55;
    var pCtx = preview.getContext('2d');
    pCtx.drawImage(temp, 0, 0, 80, 55);
    return preview;
  }

  // ================================================================
  //  初始化：生成身份 LUT + 所有滤镜 LUT + 预览
  // ================================================================
  function init() {
    if (initialized) return;
    initialized = true;

    identityLUT = generateIdentityLUT();
    sampleImage = createSampleImage();

    for (var i = 0; i < FILTERS.length; i++) {
      var f = FILTERS[i];
      var lutCanvas = createFilterLUT(f.css);
      var preview = createPreview(lutCanvas, f.id);

      lutCache[f.id] = {
        lut: lutCanvas,
        preview: preview
      };
    }
  }

  // ================================================================
  //  公开 API
  // ================================================================
  window.LiteBeautyFilters = {
    init: init,
    getFilterList: function () { return FILTERS; },
    getLUT: function (filterId) {
      var entry = lutCache[filterId];
      return entry ? entry.lut : null;
    },
    getPreview: function (filterId) {
      var entry = lutCache[filterId];
      return entry ? entry.preview : null;
    },
    addCustomFilter: function (id, name, lutCanvas, previewCanvas) {
      // 防止重复
      if (lutCache[id]) return;
      FILTERS.push({ id: id, name: name, css: '' });
      lutCache[id] = { lut: lutCanvas, preview: previewCanvas };
    },
    applyToContext: applyLUTToContext,
    applyToImageData: applyLUTToImageData,
    isInitialized: function () { return initialized; }
  };

})();
