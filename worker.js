/* ================================================================
   LiteBeauty Web Worker —— 人脸检测（独立线程，避免界面卡顿）
   通过 OffscreenCanvas + face-api.js 在 Worker 中完成检测
   ================================================================ */

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';

let ready = false;
let initError = null;

// ── 加载 face-api.js 库 ──
try {
  importScripts('https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js');
} catch (e) {
  initError = 'face-api.js 加载失败: ' + e.message;
  // 无法加载库，Worker 不可用
}

// ── 初始化模型 ──
async function init() {
  if (initError) {
    self.postMessage({ type: 'ready', success: false, error: initError });
    return;
  }
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)
    ]);
    ready = true;
    self.postMessage({ type: 'ready', success: true });
  } catch (e) {
    self.postMessage({ type: 'ready', success: false, error: e.message });
  }
}

init();

// ── 处理主线程发来的检测请求 ──
self.onmessage = async function (e) {
  const { type, imageBitmap } = e.data;

  if (type !== 'detect' || !ready) return;

  try {
    // OffscreenCanvas 在 Worker 中可用（Chrome 69+, Firefox 105+, Safari 16.4+）
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas 不可用');
    }

    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');

    ctx.drawImage(imageBitmap, 0, 0);

    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.5
    });

    const result = await faceapi
      .detectSingleFace(canvas, options)
      .withFaceLandmarks();

    // 序列化结果（不能直接 transfer face-api 对象）
    if (result && result.landmarks && result.landmarks.positions) {
      const positions = result.landmarks.positions.map(p => ({
        x: p._x !== undefined ? p._x : p.x,
        y: p._y !== undefined ? p._y : p.y
      }));
      self.postMessage({ type: 'result', success: true, positions });
    } else {
      self.postMessage({ type: 'result', success: true, positions: null });
    }

    imageBitmap.close();
  } catch (err) {
    self.postMessage({ type: 'result', success: false, error: err.message });
  }
};
