These files must sit at the RuntimeFS HOST ROOT, beside RuntimeFS's own
index.html and sw.js. Not inside the RuntimeCode folder.

If RuntimeFS is served from https://example.org/projects/RuntimeFS/, then
rc-webview-sw.js has to be fetchable at
https://example.org/projects/RuntimeFS/rc-webview-sw.js.

Why: a browser fetches a service worker script with serviceWorkers:'none', so
the request bypasses RuntimeFS's own service worker and hits the real server.
A copy that exists only inside a /n/<folder>/ virtual path returns 404, and
every webview (markdown preview, notebooks, settings UI) fails to load.

Verify a deployment with:  node scripts/check-deploy.mjs <url-of-runtimecode>
