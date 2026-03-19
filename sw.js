const CACHE_NAME = 'fire-dashboard-v2';
const ASSETS = [
  '/',
  '/app.html',
  '/stock-api.js',
  '/manifest.json',
  '/financial_data.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

// 行情 API 相关的域名，使用 network-first 策略
const NETWORK_FIRST_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.allorigins.win',
  'corsproxy.io',
  'finnhub.io',
  'supabase',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // 行情API和Supabase: network-first，失败后回退缓存
  if (NETWORK_FIRST_HOSTS.some(host => url.includes(host))) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // 缓存成功的响应
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 静态资源: cache-first，不在缓存中就走网络
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return resp;
    }))
  );
});
