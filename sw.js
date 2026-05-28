/* ================================================================
   LiteBeauty Service Worker
   缓存策略：Cache First → Network Fallback
   ================================================================ */

const CACHE_NAME = 'litebeauty-v1';

// 需要预缓存的核心文件
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './filters.js',
  './worker.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // face-api.js 库
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
  'https://cdn.tailwindcss.com',
  // 模型权重文件
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/tiny_face_detector_model-shard1',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/tiny_face_detector_model-weights_manifest.json',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/face_landmark_68_model-shard1',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/face_landmark_68_model-weights_manifest.json'
];

// ── Install：预缓存核心资源 ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] 预缓存资源中...');
      return cache.addAll(PRECACHE_URLS).catch(err => {
        // 部分 CDN 资源可能加载失败，不阻塞安装
        console.warn('[SW] 部分预缓存资源加载失败:', err.message);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate：清理旧版本缓存 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// ── Fetch：Cache First 策略 ──
self.addEventListener('fetch', event => {
  // 跳过非 GET 请求和 chrome-extension 请求
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // 缓存未命中 → 网络请求并动态缓存
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clone);
        });
        return response;
      }).catch(() => {
        // 离线 + 未缓存 → 返回占位（对于 HTML 请求返回主页）
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
