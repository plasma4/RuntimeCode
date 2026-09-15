/**
 * Turns gulp's raw vscode-web output into the two folders you actually deploy:
 *
 *   dist/app/        upload as a RuntimeFS folder, e.g. /n/RC/
 *   dist/host-root/  upload to the RuntimeFS host root
 *
 * The split is not cosmetic. Service worker scripts bypass service workers, so
 * anything in host-root/ has to be a real file on the origin or webviews break.
 * Keeping it in its own folder makes that a deploy step you cannot skip by
 * accident, which is exactly how it was skipped before.
 *
 * Upstream's out/vs/code/browser/workbench/workbench.html is a server template:
 * src/vs/server/node/webClientServer.ts substitutes {{WORKBENCH_*}} per request.
 * We do the same substitution once, at build time, and write index.html.
 *
 * This runs entirely on the build output, so it costs no patch against upstream.
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { deepMerge, VSCODE_ROOT, GULP_OUT, APP_OUT, HOST_OUT, DIST, RC_ROOT } from './lib.mjs';

const WEBVIEW_SW_NAME = 'rc-webview-sw.js';

const HOST_ROOT_README = `These files must sit at the RuntimeFS HOST ROOT, beside RuntimeFS's own
index.html and sw.js. Not inside the RuntimeCode folder.

If RuntimeFS is served from https://example.org/projects/RuntimeFS/, then
rc-webview-sw.js has to be fetchable at
https://example.org/projects/RuntimeFS/rc-webview-sw.js.

Why: a browser fetches a service worker script with serviceWorkers:'none', so
the request bypasses RuntimeFS's own service worker and hits the real server.
A copy that exists only inside a /n/<folder>/ virtual path returns 404, and
every webview (markdown preview, notebooks, settings UI) fails to load.

Verify a deployment with:  node scripts/check-deploy.mjs <url-of-runtimecode>
`;
const ERUDA_URL = 'https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js';
const ERUDA_SHA256 = '332f95b14b1dc53cdbe6042e0ea95ac6025ac691c285d51b647c64360fe939e2';

/** Matches webClientServer.ts:320 — the config lands in an HTML attribute. */
function asJSON(value) {
	return JSON.stringify(value).replace(/"/g, '&quot;');
}

function buildProductConfiguration() {
	const product = JSON.parse(readFileSync(path.join(VSCODE_ROOT, 'product.json'), 'utf8'));
	const overlay = JSON.parse(readFileSync(path.join(RC_ROOT, 'product.overlay.json'), 'utf8'));
	const merged = deepMerge(product, overlay);

	// Mirrors webClientServer.ts:356 so telemetry-related code can tell how it was embedded.
	merged.embedderIdentifier = 'runtimecode-static';
	return merged;
}

/**
 * Defaults, not locks — the user keeps every setting. Telemetry is already inert
 * in an OSS build (no aiConfig.ariaKey for telemetryUtils.ts:125 to gate on);
 * these make the intent explicit and switch off the remaining network chatter.
 */
const configurationDefaults = {
	// A default, not a lock — the user can change it in Settings like any other.
	// `Dark 2026` is the theme id contributed by extensions/theme-defaults.
	'workbench.colorTheme': 'Dark 2026',

	'telemetry.telemetryLevel': 'off',
	'telemetry.feedback.enabled': false,
	'update.mode': 'none',
	'update.showReleaseNotes': false,
	'extensions.autoUpdate': false,
	'extensions.autoCheckUpdates': false,
	'workbench.enableExperiments': false,
	'workbench.settings.enableNaturalLanguageSearch': false,
	'npm.fetchOnlinePackageInfo': false,
	'git.autofetch': false
};

function buildWorkbenchConfiguration() {
	return {
		// Deliberately absent vs. webClientServer.ts:375 — there is no server:
		// no remoteAuthority, no connectionToken, no callbackRoute, no serverBasePath.

		productConfiguration: buildProductConfiguration(),

		// NOTE: webviewEndpoint is intentionally NOT set here. It must be an
		// ABSOLUTE url: webviewElement.ts:584 does URI.parse(endpoint) and compares
		// scheme://authority against the origin of incoming webview messages. A
		// relative endpoint parses to "://" , so every webview message is silently
		// dropped and webviews never initialise. static/index.html computes the
		// absolute value from window.location so the folder still works at any path.

		configurationDefaults,

		// Paints dark before settings resolve, so first load does not flash white
		// on its way to the configured theme.
		initialColorTheme: { themeType: 'dark' },

		enableWorkspaceTrust: true
	};
}

/**
 * The webview host page pins the sha256 of its own inline module script in a
 * CSP `script-src`. Any patch to that script invalidates the hash and the
 * browser then blocks the script *silently* — no error event, no console entry
 * reachable from the page, just a webview that never hands-shakes and renders
 * blank. That failure mode cost a lot to diagnose once; recompute the hash here
 * so it cannot recur.
 */
function repairWebviewCspHash() {
	const file = path.join(APP_OUT, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'index.html');
	if (!existsSync(file)) {
		console.warn('[staticify] WARNING: webview host page missing, cannot verify CSP hash');
		return;
	}

	const html = readFileSync(file, 'utf8');
	const script = html.match(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/);
	const csp = html.match(/'sha256-([A-Za-z0-9+/=]+)'/);
	if (!script || !csp) {
		console.warn('[staticify] WARNING: could not locate webview inline script or CSP hash');
		return;
	}

	const actual = createHash('sha256').update(script[1], 'utf8').digest('base64');
	if (actual === csp[1]) {
		console.log('[staticify] webview CSP hash already correct');
		return;
	}

	writeFileSync(file, html.replace(`'sha256-${csp[1]}'`, `'sha256-${actual}'`));
	console.log(`[staticify] repaired webview CSP hash -> sha256-${actual}`);
}

async function vendorEruda() {
	const response = await fetch(ERUDA_URL);
	if (!response.ok) {
		throw new Error(`Could not download Eruda (${response.status} ${response.statusText}).`);
	}
	const body = Buffer.from(await response.arrayBuffer());
	const digest = createHash('sha256').update(body).digest('hex');
	if (digest !== ERUDA_SHA256) {
		throw new Error(`Eruda checksum mismatch: expected ${ERUDA_SHA256}, got ${digest}.`);
	}
	const target = path.join(APP_OUT, 'rc-assets', 'eruda.js');
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, body, { flag: 'w' });
	console.log('[staticify] vendored Eruda 3.4.3 for opt-in preview inspection');
}

/**
 * Move gulp's output into dist/app. A move, not a copy: every build rimrafs and
 * rewrites GULP_OUT anyway, so copying would just leave a stale half-gigabyte
 * sitting next to the checkout pretending to be a deliverable. renameSync is
 * instant on the same filesystem and falls back to copy when it is not.
 */
function collectGulpOutput() {
	rmSync(DIST, { recursive: true, force: true });
	mkdirSync(DIST, { recursive: true });
	try {
		renameSync(GULP_OUT, APP_OUT);
	} catch (error) {
		if (error.code !== 'EXDEV') { throw error; }
		cpSync(GULP_OUT, APP_OUT, { recursive: true });
		rmSync(GULP_OUT, { recursive: true, force: true });
	}
	mkdirSync(HOST_OUT, { recursive: true });
}

async function main() {
	if (!existsSync(GULP_OUT)) {
		throw new Error(`No build output at ${GULP_OUT}. Run scripts/build.mjs first.`);
	}

	collectGulpOutput();

	// We ship our own bootstrap rather than substituting upstream's
	// workbench.html. That file loads vs/code/browser/workbench/workbench.js,
	// the "browser shell", which the `web` build target deliberately does not
	// emit — see build/next/index.ts:179-185 ("web workbench only (no browser
	// shell)"); only server-web builds it. The vscode-web bundle is designed to
	// be driven by an embedder calling create() directly, so static/index.html
	// does that.
	const templatePath = path.join(RC_ROOT, 'static', 'index.html');
	let html = readFileSync(templatePath, 'utf8');

	const values = {
		WORKBENCH_WEB_CONFIGURATION: asJSON(buildWorkbenchConfiguration())
	};

	for (const [key, value] of Object.entries(values)) {
		html = html.replaceAll(`{{${key}}}`, value);
	}

	const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
	if (leftover) {
		throw new Error(`Unsubstituted placeholders remain: ${[...new Set(leftover)].join(', ')}`);
	}

	writeFileSync(path.join(APP_OUT, 'index.html'), html);
	copyFileSync(path.join(RC_ROOT, 'static', 'rc-preview.html'), path.join(APP_OUT, 'rc-preview.html'));

	// Sanity-check the bundle the bootstrap depends on, so a target change
	// upstream surfaces here rather than as a blank page in the browser.
	const webMain = path.join(APP_OUT, 'out', 'vs', 'workbench', 'workbench.web.main.internal.js');
	if (!existsSync(webMain)) {
		throw new Error(`Missing ${path.relative(APP_OUT, webMain)} — the web entry point did not build.`);
	}

	// RuntimeCode's own extensions ship alongside the workbench and are wired up
	// as additionalBuiltinExtensions by the bootstrap. They are plain CommonJS
	// with no build step — the web extension host loads them with
	// `new Function('module','exports','require', src)`.
	const extensionsSrc = path.join(RC_ROOT, 'extensions');
	if (existsSync(extensionsSrc)) {
		const dest = path.join(APP_OUT, 'rc-extensions');
		rmSync(dest, { recursive: true, force: true });
		cpSync(extensionsSrc, dest, { recursive: true });
		console.log('[staticify] copied rc-extensions/');
	}

	await vendorEruda();

	repairWebviewCspHash();

	// The webview service worker has to be reachable as a REAL file: service
	// worker script requests bypass service workers entirely (spec: the request
	// carries serviceWorkers:'none'), so a copy living only inside RuntimeFS's
	// virtual tree can never register. Verified in spikes/swtest. It goes to
	// host-root/ rather than app/ because app/ IS the virtual tree.
	const builtSw = path.join(APP_OUT, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'service-worker.js');
	if (!existsSync(builtSw)) {
		throw new Error(`No webview service worker at ${builtSw}. Webviews cannot work without it.`);
	}
	copyFileSync(builtSw, path.join(HOST_OUT, WEBVIEW_SW_NAME));
	writeFileSync(path.join(HOST_OUT, 'README.txt'), HOST_ROOT_README);
	console.log(`[staticify] emitted host-root/${WEBVIEW_SW_NAME}`);

	console.log(`[staticify] wrote ${path.join(APP_OUT, 'index.html')} (template: ${path.relative(VSCODE_ROOT, templatePath)})`);
	console.log(`[staticify] deploy: app/ -> a RuntimeFS folder, host-root/ -> the RuntimeFS host root`);
}

await main();
