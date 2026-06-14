const CACHE = "orbit-v7";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-32.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.hostname.endsWith("supabase.co")) return;
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((res) => { if (res && res.status === 200 && url.origin === self.location.origin) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); } return res; }).catch(() => cached);
    return cached || net;
  }));
});
