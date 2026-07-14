const CACHE_NAME = "trove-shell-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/trove-mark.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/"))));
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json?.() ?? {};
  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Trove", {
      body: payload.body ?? "기다리던 일정에 새로운 소식이 있어요.",
      icon: "/trove-mark.svg",
      badge: "/trove-mark.svg",
      data: { url: payload.url ?? "/trove" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? "/trove";
  event.waitUntil(self.clients.openWindow(targetUrl));
});
