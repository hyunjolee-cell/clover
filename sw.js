/* CLOVER 서비스워커
 * 항상 네트워크를 먼저 본다. 최신 코드가 캐시에 갇히지 않게 하기 위함이다.
 * 네트워크가 끊겼을 때만 마지막으로 받아둔 화면을 보여준다.
 * 버전을 올리면 기존 캐시는 전부 지워진다. */

const CACHE = 'clover-v4';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase 요청은 건드리지 않는다

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw new Error('offline');
    }
  })());
});
