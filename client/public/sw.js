/*
 * Play Routine deliberately keeps no caches or user data in the service worker.
 * Only document navigations get a fixed generic offline response; every other
 * request, including auth and API requests, goes directly to the network.
 */
self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          "<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Play Routine</title><body><main><h1>인터넷 연결을 확인해 주세요</h1><p>연결되면 Play Routine을 다시 열어 주세요.</p></main></body></html>",
          {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          },
        ),
    ),
  );
});
