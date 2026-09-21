/**
 * Checks a deployed RuntimeCode against the two things that silently break it:
 *
 *   node scripts/check-deploy.mjs https://example.org/projects/RuntimeFS/n/RC/
 *
 * Both failures look identical from the browser (a webview that never appears),
 * and neither produces a useful console message, so check them directly.
 */
import { APP_OUT, HOST_OUT } from "./lib.mjs";
import { PACKS_OUT } from "./packs.mjs";
import { existsSync } from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error(
    "usage: node scripts/check-deploy.mjs <url of the deployed RuntimeCode folder>",
  );
  process.exit(1);
}

const base = new URL(target.endsWith("/") ? target : `${target}/`);

/** Everything before the `/n/` segment is the RuntimeFS root, per the bootstrap. */
function runtimeFsRoot(url) {
  const index = url.pathname.indexOf("/n/");
  return index === -1
    ? undefined
    : new URL(url.pathname.slice(0, index + 1), url.origin);
}

async function head(url) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    return {
      ok: response.ok,
      status: response.status,
      type: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    return { ok: false, status: 0, type: "", error: String(error) };
  }
}

const problems = [];
const root = runtimeFsRoot(base);

if (root) {
  // A /n/<folder>/ path only exists inside a browser that has RuntimeFS's
  // service worker installed. Fetching it from here always 404s, which says
  // nothing about the deployment, so do not pretend to check it.
  console.log(
    `[check-deploy] SKIP app          ${base} is a RuntimeFS virtual path, not fetchable from outside a browser`,
  );
} else {
  const app = await head(new URL("index.html", base));
  if (app.ok) {
    console.log(
      `[check-deploy] OK   app          ${new URL("index.html", base)}`,
    );
  } else {
    problems.push(
      `The RuntimeCode folder is not reachable at ${base} (HTTP ${app.status}).`,
    );
  }
}

if (!root) {
  console.log(
    "[check-deploy] SKIP host-root   no /n/ segment, so this is a standalone deployment",
  );
  console.log(
    "[check-deploy] standalone builds use the in-folder service worker and need no host-root file",
  );
} else {
  const worker = new URL("rc-webview-sw.js", root);
  const result = await head(worker);
  if (result.ok && result.type.includes("javascript")) {
    console.log(`[check-deploy] OK   host-root    ${worker}`);
  } else if (result.ok) {
    problems.push(
      `${worker} responded ${result.status} but as "${result.type}", not JavaScript. ` +
        `A server that rewrites unknown paths to index.html will do this, and registration still fails.`,
    );
  } else {
    problems.push(
      `${worker} is not reachable (HTTP ${result.status}). Every webview will fail to load.\n` +
        `  Upload ${path.join(HOST_OUT, "rc-webview-sw.js")} to ${root}\n` +
        `  Service worker scripts bypass service workers, so a copy inside the RuntimeFS\n` +
        `  virtual tree cannot be fetched. It has to be a real file at that path.`,
    );
  }
}

if (!existsSync(path.join(APP_OUT, "index.html"))) {
  console.log(
    "[check-deploy] note: no local build in dist/, so nothing was compared against it",
  );
}

// The packs folder is a third artifact, optional: no packs means no runtimes,
// which is a supported state (the host says so), not a broken deployment. But
// when packs exist they have to be reachable, because a catalog that 404s is a
// silent "no runtimes" where the user asked for one.
const packsIndex = path.join(PACKS_OUT, "catalog.json");
if (existsSync(packsIndex)) {
  if (root) {
    const catalogUrl = new URL(`n/RC-Packs/catalog.json`, root);
    const catalog = await head(catalogUrl);
    if (catalog.ok) {
      console.log(`[check-deploy] OK   packs        ${catalogUrl}`);
    } else {
      problems.push(
        `${catalogUrl} is not reachable (HTTP ${catalog.status}). ` +
          `Upload ${PACKS_OUT} as a RuntimeFS folder named RC-Packs, or every runtime reads as not installed.`,
      );
    }
  } else {
    console.log(
      "[check-deploy] NOTE packs       local build has packs, but this is a standalone deployment with no /n/ path to serve them",
    );
  }
} else {
  console.log(
    "[check-deploy] note: no packs built in dist/, so no pack catalog to check",
  );
}

if (problems.length > 0) {
  console.error(`\n[check-deploy] FAIL: ${problems.length} problem(s):\n`);
  for (const problem of problems) {
    console.error(`  ${problem}\n`);
  }
  process.exit(1);
}

console.log("[check-deploy] OK: both halves of the deployment are in place");
