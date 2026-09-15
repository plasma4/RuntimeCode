// Served as a REAL file from the origin root (not from RuntimeFS's virtual
// tree), then registered with an explicit narrower scope pointing into a
// virtual folder. This is the candidate fix for the fact that service worker
// script requests bypass service workers.
//
// Mirrors VS Code's webview SW: respondWith() for its own magic path, silent
// fall-through for everything else.

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	if (url.pathname.endsWith('/sw-probe')) {
		return event.respondWith(new Response('ROOT-PROBE-OK', {
			headers: { 'content-type': 'text/plain' }
		}));
	}

	// No respondWith. Does this reach RuntimeFS's SW, or the network?
});
