/**
 * Serves the built static folder for local testing, and optionally serves a
 * RuntimeFS checkout at the same origin so RuntimeCode can be exercised the way
 * it will actually be deployed:
 *
 *   node scripts/serve.mjs                 # dist/app at /
 *   node scripts/serve.mjs --with-rfs      # RuntimeFS at /, dist/app at /rc/
 *   node scripts/serve.mjs --simulate-rfs  # dist/app at /n/RuntimeCode/, fixtures at /n/<name>/
 *   node scripts/serve.mjs --coi           # ...and COOP+COEP on every response
 *
 * dist/host-root is always served at /, in every mode, because that is where it
 * lives in production. Getting that wrong locally is how a missing host-root
 * deployment stays invisible until webviews break on the real site.
 *
 * --simulate-rfs mimics RuntimeFS's virtual path layout without RuntimeFS, so
 * the live-preview URL derivation can be exercised locally. It does NOT
 * exercise RuntimeFS's service worker. Test that in a real deployment.
 *
 * Otherwise deliberately dumb: no rewriting, and no headers beyond the two
 * --coi adds. If the build needs a server to do something clever for it, it is
 * not actually static.
 *
 * --coi is off by default and exists for one reason: crossOriginIsolated, and
 * therefore SharedArrayBuffer, is a property of the document's response headers,
 * and in production those come from RuntimeFS Custom Headers on the folder. That
 * is not something a static file can ask for, so there is no way to measure what
 * isolation costs, or what it breaks, without a server that sets them. See
 * RUNTIMES.md, "Cross-origin isolation".
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { RC_ROOT, RFS_ROOT, APP_OUT, HOST_OUT } from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 8099);
const withRfs = process.argv.includes("--with-rfs");
const simulateRfs = process.argv.includes("--simulate-rfs");
const coi = process.argv.includes("--coi");
const rfsFolderArg = process.argv.indexOf("--rfs-folder");
const simulatedFolder =
  rfsFolderArg !== -1
    ? process.argv[rfsFolderArg + 1]
    : (process.env.RUNTIMEFS_FOLDER ?? "RuntimeCode");
const simulatedFolderPrefix = `/n/${encodeURIComponent(simulatedFolder)}`;
/** Fixture folders served at /n/<name>/ in --simulate-rfs mode. */
const FIXTURES = path.join(RC_ROOT, "fixtures");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".mp3": "audio/mpeg",
  ".scm": "text/plain",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

function resolveFile(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  // Contain traversal to the served root. The separator matters: comparing
  // against a bare `root` also accepts sibling directories that merely share
  // its name as a prefix, and `..` segments can reach them.
  const candidate = path.join(
    root,
    path.normalize(decoded).replace(/^(\.\.[/\\])+/, ""),
  );
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const index = path.join(candidate, "index.html");
    return existsSync(index) ? index : null;
  }
  return existsSync(candidate) ? candidate : null;
}

createServer((req, res) => {
  let file = null;

  // The redirect has to be tested before the two prefix branches below: both
  // of them also match `/n/RuntimeCode`, and would 404 it instead.
  if (
    simulateRfs &&
    (req.url === simulatedFolderPrefix ||
      req.url.startsWith(`${simulatedFolderPrefix}?`))
  ) {
    const query = req.url.slice(simulatedFolderPrefix.length);
    res.writeHead(302, { location: `${simulatedFolderPrefix}/${query}` });
    res.end();
    return;
  } else if (simulateRfs && req.url.startsWith(`${simulatedFolderPrefix}/`)) {
    file = resolveFile(APP_OUT, req.url.slice(simulatedFolderPrefix.length));
  } else if (simulateRfs && req.url.startsWith("/n/")) {
    file = resolveFile(FIXTURES, req.url.slice("/n".length));
  } else if (withRfs && req.url.startsWith("/rc/")) {
    file = resolveFile(APP_OUT, req.url.slice("/rc".length));
  } else if (withRfs) {
    file = resolveFile(HOST_OUT, req.url) ?? resolveFile(RFS_ROOT, req.url);
  } else if (simulateRfs) {
    file = resolveFile(HOST_OUT, req.url);
  } else {
    file = resolveFile(HOST_OUT, req.url) ?? resolveFile(APP_OUT, req.url);
  }

  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`404 ${req.url}`);
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
    // Service workers may only claim scopes at or below their own path
    // unless this says otherwise.
    "service-worker-allowed": "/",
    // Everything served here is same-origin, so require-corp costs nothing
    // locally. That is the point: what breaks under isolation is the
    // cross-origin subresources, and locally there are none to hide them.
    ...(coi
      ? {
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        }
      : {}),
  });
  createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[serve] http://127.0.0.1:${PORT}/`);
  console.log(`[serve] host-root: ${HOST_OUT} -> /`);
  if (coi) {
    console.log(
      "[serve] coi:       COOP+COEP on every response (crossOriginIsolated, SharedArrayBuffer)",
    );
  }
  if (simulateRfs) {
    console.log(`[serve] app:       ${APP_OUT} -> ${simulatedFolderPrefix}/`);
    console.log(`[serve] fixtures:  ${FIXTURES} -> /n/<name>/`);
  } else if (withRfs) {
    console.log(`[serve] runtimefs: ${RFS_ROOT} -> /`);
    console.log(`[serve] app:       ${APP_OUT} -> /rc/`);
  } else {
    console.log(`[serve] app:       ${APP_OUT} -> /`);
  }
});
