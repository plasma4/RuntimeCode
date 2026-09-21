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
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  deepMerge,
  rebrandNlsMessages,
  VSCODE_ROOT,
  GULP_OUT,
  APP_OUT,
  HOST_OUT,
  DIST,
  RC_ROOT,
} from "./lib.mjs";
import {
  collectExtensionLicenses,
  NON_SHIPPING_ENTRIES,
  renderExtensionNotices,
  renderLicenseIndex,
} from "./licenses.mjs";

const WEBVIEW_SW_NAME = "rc-webview-sw.js";
const EXTENSIONS_SRC = path.join(RC_ROOT, "extensions");

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
const ERUDA_URL = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js";
const ERUDA_SHA256 =
  "332f95b14b1dc53cdbe6042e0ea95ac6025ac691c285d51b647c64360fe939e2";

/**
 * The config lands in a quoted HTML attribute, so it has to be attribute-encoded
 * on the way in. Upstream splits that across two places: asJSON
 * (webClientServer.ts:361) is a bare JSON.stringify, and renderWorkbenchTemplate
 * (webClientServer.ts:122) runs every substituted value through
 * htmlAttributeEncodeValue (base/common/strings.ts:58). We do both here, and
 * encode the same five characters upstream does. Encoding only `"` is not
 * enough: an `&` or a `<` anywhere in product.json then reaches the attribute
 * raw, and the HTML parser mangles the JSON before the workbench ever sees it.
 */
function asAttribute(value) {
  return JSON.stringify(value).replace(
    /[<>"'&]/g,
    (ch) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
        "&": "&amp;",
      })[ch],
  );
}

function buildProductConfiguration() {
  const product = JSON.parse(
    readFileSync(path.join(VSCODE_ROOT, "product.json"), "utf8"),
  );
  const overlay = JSON.parse(
    readFileSync(path.join(RC_ROOT, "product.overlay.json"), "utf8"),
  );
  const merged = deepMerge(product, overlay);

  // Mirrors webClientServer.ts:397 so telemetry-related code can tell how it was embedded.
  merged.embedderIdentifier = "runtimecode-static";
  return merged;
}

/**
 * Defaults, not locks. The user keeps every setting. Telemetry is already inert
 * in an OSS build (no aiConfig.ariaKey for telemetryUtils.ts:125 to gate on);
 * these make the intent explicit and switch off the remaining network chatter.
 */
const configurationDefaults = {
  // A default, not a lock. The user can change it in Settings like any other.
  // `Dark 2026` is the theme id contributed by extensions/theme-defaults.
  "workbench.colorTheme": "Dark 2026",

  // Copilot is not bundled and cannot be installed here: Open VSX has no
  // GitHub.copilot or GitHub.copilot-chat, so the built-in setup flow would ask
  // the gallery for an extension that is not in it. Leaving the chat UI visible
  // therefore only offers a status bar entry and a sign-in that go nowhere.
  // `sentiment.hidden` follows this setting (chatEntitlementService.ts:1507),
  // which removes the entry. It stays a default, not a lock: point
  // extensionsGallery at a registry that carries Copilot, set this to false,
  // and the whole UI comes back.
  "chat.disableAIFeatures": true,

  "telemetry.telemetryLevel": "off",
  "telemetry.feedback.enabled": false,
  "update.mode": "none",
  "update.showReleaseNotes": false,
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "workbench.enableExperiments": false,
  "workbench.settings.enableNaturalLanguageSearch": false,
  "npm.fetchOnlinePackageInfo": false,
  "git.autofetch": false,
};

function buildWorkbenchConfiguration() {
  return {
    // Deliberately absent vs. webClientServer.ts:416, because there is no
    // server: no remoteAuthority, connectionToken, callbackRoute or
    // serverBasePath.

    productConfiguration: buildProductConfiguration(),

    // NOTE: webviewEndpoint is intentionally NOT set here. It must be an
    // ABSOLUTE url: webviewElement.ts:585 does URI.parse(endpoint) and compares
    // scheme://authority against the origin of incoming webview messages. A
    // relative endpoint parses to "://" , so every webview message is silently
    // dropped and webviews never initialise. static/index.html computes the
    // absolute value from window.location so the folder still works at any path.

    configurationDefaults,

    // Paints dark before settings resolve, so first load does not flash white
    // on its way to the configured theme.
    initialColorTheme: { themeType: "dark" },

    enableWorkspaceTrust: true,
  };
}

/**
 * The webview host page pins the sha256 of its own inline module script in a
 * CSP `script-src`. Any patch to that script invalidates the hash and the
 * browser then blocks the script *silently*: no error event, no console entry
 * reachable from the page, just a webview that never hands-shakes and renders
 * blank. That failure mode cost a lot to diagnose once; recompute the hash here
 * so it cannot recur.
 */
function repairWebviewCspHash() {
  const file = path.join(
    APP_OUT,
    "out",
    "vs",
    "workbench",
    "contrib",
    "webview",
    "browser",
    "pre",
    "index.html",
  );
  if (!existsSync(file)) {
    console.warn(
      "[staticify] WARNING: webview host page missing, cannot verify CSP hash",
    );
    return;
  }

  const html = readFileSync(file, "utf8");
  const script = html.match(
    /<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/,
  );
  const csp = html.match(/'sha256-([A-Za-z0-9+/=]+)'/);
  if (!script || !csp) {
    console.warn(
      "[staticify] WARNING: could not locate webview inline script or CSP hash",
    );
    return;
  }

  const actual = createHash("sha256")
    .update(script[1], "utf8")
    .digest("base64");
  if (actual === csp[1]) {
    console.log("[staticify] webview CSP hash already correct");
    return;
  }

  writeFileSync(file, html.replace(`'sha256-${csp[1]}'`, `'sha256-${actual}'`));
  console.log(`[staticify] repaired webview CSP hash -> sha256-${actual}`);
}

/**
 * Renames the product in the handful of built-in strings that name it on screen,
 * the Welcome page above all. The workbench reads nls.messages.js at startup;
 * nls.messages.json is the same array as data, and the two are kept in step so
 * nothing downstream reads a stale copy.
 */
function rebrandWelcomeStrings(productName) {
  const out = path.join(APP_OUT, "out");
  const keys = JSON.parse(
    readFileSync(path.join(out, "nls.keys.json"), "utf8"),
  );
  const messages = rebrandNlsMessages(
    keys,
    JSON.parse(readFileSync(path.join(out, "nls.messages.json"), "utf8")),
    productName,
  );

  writeFileSync(path.join(out, "nls.messages.json"), JSON.stringify(messages));

  const scriptPath = path.join(out, "nls.messages.js");
  const script = readFileSync(scriptPath, "utf8");
  const marker = "globalThis._VSCODE_NLS_MESSAGES=";
  const at = script.indexOf(marker);
  if (at === -1) {
    throw new Error(
      `No ${marker} in nls.messages.js; the workbench would start unbranded.`,
    );
  }
  writeFileSync(
    scriptPath,
    `${script.slice(0, at + marker.length)}${JSON.stringify(messages)};\n`,
  );
  console.log(
    `[staticify] rebranded built-in welcome strings to ${productName}`,
  );
}

async function vendorEruda() {
  const response = await fetch(ERUDA_URL);
  if (!response.ok) {
    throw new Error(
      `Could not download Eruda (${response.status} ${response.statusText}).`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== ERUDA_SHA256) {
    throw new Error(
      `Eruda checksum mismatch: expected ${ERUDA_SHA256}, got ${digest}.`,
    );
  }
  const target = path.join(APP_OUT, "rc-assets", "eruda.js");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, { flag: "w" });
  console.log("[staticify] vendored Eruda 3.4.3 for opt-in preview inspection");
}

/**
 * RuntimeCode's own extensions ship alongside the workbench and are wired up as
 * additionalBuiltinExtensions by the bootstrap. They are plain CommonJS with no
 * build step, because the web extension host loads them with
 * `new Function('module','exports','require', src)`.
 *
 * Copied folder by folder rather than as one `cpSync(extensions/)`, for two
 * reasons. The obvious one is that `extensions/types/` holds the gitignored
 * 728 KB `vscode.d.ts` that typecheck.mjs drops there, and a wholesale copy
 * shipped it to every user along with whatever else happened to be sitting in
 * the directory. The one that matters more is that this loop and the license
 * gate agree on what an extension is: a folder with a manifest. A folder that
 * cannot declare its terms cannot be shipped by accident.
 */
function copyExtensions(entries) {
  const dest = path.join(APP_OUT, "rc-extensions");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  for (const entry of entries) {
    cpSync(path.join(EXTENSIONS_SRC, entry.id), path.join(dest, entry.id), {
      recursive: true,
      filter: (src) => !NON_SHIPPING_ENTRIES.has(path.basename(src)),
    });
  }

  writeFileSync(
    path.join(dest, "LICENSES.md"),
    `${renderLicenseIndex(entries).trimEnd()}\n`,
  );
  console.log(
    `[staticify] copied rc-extensions/ (${entries.map((e) => e.id).join(", ") || "none"})`,
  );
}

/**
 * Attribution travels with the artifact.
 *
 * Upstream's `vscode-web` package step copies only `remote/LICENSE`, which does
 * not exist, so a naive build redistributes VS Code, its bundled dependencies
 * and its built-in extensions with no notice at all (`dist/app` shipped no
 * license file before this). The upstream texts live at the checkout root and
 * change with every release, so they are read from there at build time rather
 * than duplicated into this repo, where they would go stale.
 *
 * `dist/app/LICENSE` is the MIT license of the workbench and everything in this
 * repo that built it. It is deliberately not the license of `rc-extensions/*`,
 * which each carry their own; the notices file says so, and points at them.
 */
function emitLicenses(entries) {
  copyFileSync(path.join(RC_ROOT, "LICENSE"), path.join(APP_OUT, "LICENSE"));

  const rule = "=".repeat(78);
  const banner = (title) => `${rule}\n${title}\n${rule}`;
  const parts = [
    readFileSync(path.join(RC_ROOT, "THIRD_PARTY_NOTICES.md"), "utf8").trim(),
    banner("RuntimeCode extensions (rc-extensions/)"),
    "Each extension below is a separate work under its own license, aggregated\n" +
      "with the workbench rather than combined into it. See rc-extensions/LICENSES.md.\n\n" +
      renderExtensionNotices(entries),
    banner("VS Code LICENSE.txt (upstream)"),
    readFileSync(path.join(VSCODE_ROOT, "LICENSE.txt"), "utf8").trim(),
    banner("VS Code ThirdPartyNotices.txt (upstream)"),
    readFileSync(path.join(VSCODE_ROOT, "ThirdPartyNotices.txt"), "utf8").trim(),
  ];
  writeFileSync(
    path.join(APP_OUT, "ThirdPartyNotices.txt"),
    `${parts.join("\n\n")}\n`,
  );
  console.log("[staticify] emitted LICENSE and ThirdPartyNotices.txt");
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
    if (error.code !== "EXDEV") {
      throw error;
    }
    cpSync(GULP_OUT, APP_OUT, { recursive: true });
    rmSync(GULP_OUT, { recursive: true, force: true });
  }
  mkdirSync(HOST_OUT, { recursive: true });
}

async function main() {
  if (!existsSync(GULP_OUT)) {
    throw new Error(
      `No build output at ${GULP_OUT}. Run scripts/build.mjs first.`,
    );
  }

  // Before anything is moved. collectGulpOutput rimrafs dist/ and renames half
  // a gigabyte into it, so an extension missing its license should stop the
  // build here rather than after the expensive part, leaving a dist/ that looks
  // finished and is not shippable.
  const { entries: extensions, problems } = collectExtensionLicenses(
    EXTENSIONS_SRC,
  );
  if (problems.length > 0) {
    throw new Error(
      `Extensions cannot be shipped without stating their terms:\n\n  ${problems.join("\n\n  ")}\n`,
    );
  }

  collectGulpOutput();

  // We ship our own bootstrap rather than substituting upstream's
  // workbench.html. That file loads vs/code/browser/workbench/workbench.js,
  // the "browser shell", which the `web` build target deliberately does not
  // emit. See build/next/index.ts:181-186 ("web workbench only (no browser
  // shell)"); only server-web builds it. The vscode-web bundle is designed to
  // be driven by an embedder calling create() directly, so static/index.html
  // does that.
  const templatePath = path.join(RC_ROOT, "static", "index.html");
  let html = readFileSync(templatePath, "utf8");

  const values = {
    WORKBENCH_WEB_CONFIGURATION: asAttribute(buildWorkbenchConfiguration()),
  };

  for (const [key, value] of Object.entries(values)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }

  const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(
      `Unsubstituted placeholders remain: ${[...new Set(leftover)].join(", ")}`,
    );
  }

  writeFileSync(path.join(APP_OUT, "index.html"), html);
  copyFileSync(
    path.join(RC_ROOT, "static", "rc-preview.html"),
    path.join(APP_OUT, "rc-preview.html"),
  );

  // Sanity-check the bundle the bootstrap depends on, so a target change
  // upstream surfaces here rather than as a blank page in the browser.
  const webMain = path.join(
    APP_OUT,
    "out",
    "vs",
    "workbench",
    "workbench.web.main.internal.js",
  );
  if (!existsSync(webMain)) {
    throw new Error(
      `Missing ${path.relative(APP_OUT, webMain)}: the web entry point did not build.`,
    );
  }

  rebrandWelcomeStrings(buildProductConfiguration().nameLong);

  copyExtensions(extensions);
  emitLicenses(extensions);

  await vendorEruda();

  repairWebviewCspHash();

  // The webview service worker has to be reachable as a REAL file: service
  // worker script requests bypass service workers entirely (spec: the request
  // carries serviceWorkers:'none'), so a copy living only inside RuntimeFS's
  // virtual tree can never register. Verified in spikes/swtest. It goes to
  // host-root/ rather than app/ because app/ IS the virtual tree.
  const builtSw = path.join(
    APP_OUT,
    "out",
    "vs",
    "workbench",
    "contrib",
    "webview",
    "browser",
    "pre",
    "service-worker.js",
  );
  if (!existsSync(builtSw)) {
    throw new Error(
      `No webview service worker at ${builtSw}. Webviews cannot work without it.`,
    );
  }
  copyFileSync(builtSw, path.join(HOST_OUT, WEBVIEW_SW_NAME));
  writeFileSync(path.join(HOST_OUT, "README.txt"), HOST_ROOT_README);
  console.log(`[staticify] emitted host-root/${WEBVIEW_SW_NAME}`);

  console.log(
    `[staticify] wrote ${path.join(APP_OUT, "index.html")} (template: ${path.relative(VSCODE_ROOT, templatePath)})`,
  );
  console.log(
    `[staticify] deploy: app/ -> a RuntimeFS folder, host-root/ -> the RuntimeFS host root`,
  );
}

await main();
