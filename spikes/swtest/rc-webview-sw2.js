// Candidate fix, v2. Same as v1 but with an OPFS fallback: anything in scope
// that this SW doesn't specifically handle gets served from RuntimeFS's OPFS
// tree instead of falling through to the network (where it would 404, since
// these files exist only in OPFS).
//
// This is the shape of the patch that would go into VS Code's
// src/vs/workbench/contrib/webview/browser/pre/service-worker.js.

const RFS_PREFIX = 'rfs';
const VIRTUAL_ROOT = '/n/';

const MIME = {
	html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
	css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
	jpg: 'image/jpeg', gif: 'image/gif', wasm: 'application/wasm', txt: 'text/plain',
	woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json'
};

function mimeFor(path) {
	return MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

async function serveFromOpfs(pathname) {
	// /n/<Folder>/<rest> -> OPFS rfs/<Folder>/<rest>
	if (!pathname.startsWith(VIRTUAL_ROOT)) { return null; }
	const parts = pathname.slice(VIRTUAL_ROOT.length).split('/').filter(Boolean);
	if (parts.length < 1) { return null; }

	try {
		const root = await navigator.storage.getDirectory();
		let dir = await (await root.getDirectoryHandle(RFS_PREFIX)).getDirectoryHandle(parts[0]);
		const rest = parts.slice(1);
		if (rest.length === 0) { rest.push('index.html'); }
		for (let i = 0; i < rest.length - 1; i++) {
			dir = await dir.getDirectoryHandle(decodeURIComponent(rest[i]));
		}
		const file = await (await dir.getFileHandle(decodeURIComponent(rest[rest.length - 1]))).getFile();
		return new Response(file.stream(), {
			status: 200,
			headers: { 'content-type': mimeFor(rest[rest.length - 1]), 'x-served-by': 'rc-webview-sw2' }
		});
	} catch (err) {
		return new Response('OPFS fallback miss: ' + err, { status: 404 });
	}
}

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	if (url.pathname.endsWith('/sw-probe')) {
		return event.respondWith(new Response('ROOT-PROBE-OK', {
			headers: { 'content-type': 'text/plain' }
		}));
	}

	// The fix: same-origin in-scope requests get served from OPFS rather than
	// silently falling through to a network that has no such file.
	if (url.origin === self.location.origin && url.pathname.startsWith(VIRTUAL_ROOT)) {
		return event.respondWith(serveFromOpfs(url.pathname));
	}
});
