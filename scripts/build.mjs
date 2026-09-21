/**
 * One command from a clean checkout to a servable static folder.
 *
 *   node scripts/build.mjs            # fast: unminified, reuses out-build
 *   node scripts/build.mjs --min      # release: minified
 *   node scripts/build.mjs --full     # force a full recompile
 *
 * Build-speed notes, measured on an M5/48GB (see the README for the numbers):
 *  - the `-ci` gulp variants skip compileBuildWithManglingTask and reuse
 *    out-build/, which is the difference between a cold and a warm build
 *  - the unminified target skips the esbuild minify pass entirely
 * So the default here is deliberately the fast path; use --min for release.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  assertPrepared,
  assertVscodeCheckout,
  requiredNodeVersion,
  run,
  RC_ROOT,
  VSCODE_ROOT,
  DIST,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const minified = args.has("--min");
const full = args.has("--full");

function checkNode() {
  const required = requiredNodeVersion();
  const actual = process.version.replace(/^v/, "");
  if (actual !== required) {
    throw new Error(
      `Node ${required} is required (vscode/.nvmrc), but this is ${actual}.\n` +
        `Run:  nvm use ${required}`,
    );
  }
}

/**
 * Is there a usable out-build/ we can package straight from?
 *
 * A failed or interrupted compile leaves an out-build/ holding only the nls
 * artifacts, and packaging on top of that silently produces nothing, so probe
 * for a real compiled entry point rather than just the directory.
 */
function haveWarmCompile() {
  const marker = path.join(
    VSCODE_ROOT,
    "out-build",
    "vs",
    "workbench",
    "workbench.web.main.internal.js",
  );
  const warm = existsSync(marker);
  if (!warm && existsSync(path.join(VSCODE_ROOT, "out-build"))) {
    console.log("[build] out-build/ present but incomplete, recompiling");
  }
  return warm;
}

assertVscodeCheckout();
assertPrepared();
checkNode();

// Go through the repo's own `gulp` script rather than `npx gulp`: it sets
// --experimental-strip-types and --max-old-space-size=8192, without which the
// build dies with ERR_WORKER_OUT_OF_MEMORY. NODE_OPTIONS raises the ceiling
// further for the worker threads the bundler spawns, which do not inherit the
// parent's heap setting.
const gulpEnv = {
  NODE_OPTIONS:
    `--max-old-space-size=16384 ${process.env.NODE_OPTIONS ?? ""}`.trim(),
};
const gulp = (target) =>
  run("npm", ["run", "gulp", "--", target], { env: gulpEnv });

const started = Date.now();

// Compile and package are run as separate steps so we can choose the compile.
//
// The `vscode-web` / `vscode-web-min` targets hardcode compileBuildWithMangling,
// and the mangler miscompiles this tree: it renames members into collisions and
// then fails typechecking with 55 errors in mangled identifier space (e.g.
// `Property 'trace' does not exist on type '(idToken: string, ...)'`, where the
// logger and an unrelated method were both assigned `h`). Upstream's desktop
// build already uses the non-mangling compile for non-minified output
// (gulpfile.vscode.ts:738); only the web gulpfile insists on mangling.
//
// Mangling is a property-renaming optimization on top of minification, which
// esbuild still does in the -min package step. Skipping it costs some output
// size and buys a build that works.
if (full || !haveWarmCompile()) {
  gulp("compile-build-without-mangling");
}
gulp(minified ? "vscode-web-min-ci" : "vscode-web-ci");
run("node", [path.join(RC_ROOT, "scripts", "staticify.mjs")]);
// After staticify, which rimrafs dist/ before it moves gulp's output in.
run("node", [path.join(RC_ROOT, "scripts", "homepage.mjs")]);
// Runtime packs are a third artifact beside app/ and host-root/. They are built
// from pinned, verified sources; unpinned packs are reported and skipped, never
// a build failure. See scripts/packs.mjs.
run("node", [path.join(RC_ROOT, "scripts", "packs.mjs"), "--build"]);
run("node", [path.join(RC_ROOT, "scripts", "check-endpoints.mjs")]);
run("node", [path.join(RC_ROOT, "scripts", "check-licenses.mjs")]);

console.log(
  `[build] done in ${Math.round((Date.now() - started) / 1000)}s -> ${DIST}`,
);
