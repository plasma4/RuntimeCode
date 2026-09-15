// Mimics the shape of VS Code's webview service worker
// (src/vs/workbench/contrib/webview/browser/pre/service-worker.js): it only
// calls respondWith() for a narrow set of requests and silently ignores
// everything else. The question this spike answers is what "ignored" means
// when a broader-scope service worker (RuntimeFS) also exists.

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// The one path we claim, proving the nested SW is genuinely in control.
	if (url.pathname.endsWith('/sw-probe')) {
		return event.respondWith(new Response('PROBE-OK', {
			headers: { 'content-type': 'text/plain' }
		}));
	}

	// Everything else: no respondWith, exactly like the real webview SW does for
	// same-origin requests.
});
