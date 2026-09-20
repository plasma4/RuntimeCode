import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The upstream checkout to build from. It is an input, not part of this repo,
 * and it is large, so it stays outside. `../vscode` is the default; set
 * RUNTIMECODE_VSCODE to put it anywhere else.
 */
export const VSCODE_ROOT = process.env.RUNTIMECODE_VSCODE
  ? path.resolve(process.env.RUNTIMECODE_VSCODE)
  : path.resolve(RC_ROOT, "..", "vscode");

/** A RuntimeFS checkout, only used by `serve.mjs --with-rfs`. */
export const RFS_ROOT = process.env.RUNTIMECODE_RFS
  ? path.resolve(process.env.RUNTIMECODE_RFS)
  : path.resolve(RC_ROOT, "..", "rfs");

/**
 * Where `gulp vscode-web` insists on writing: BUILD_ROOT = dirname(REPO_ROOT),
 * hardcoded at build/gulpfile.vscode.web.ts:25. Treat it as scratch. Every build
 * rimrafs and rewrites it, and staticify.mjs moves the result into DIST.
 */
export const GULP_OUT = path.resolve(VSCODE_ROOT, "..", "vscode-web");

export const DIST = path.join(RC_ROOT, "dist");
/** Upload as a RuntimeFS folder, e.g. /n/RC/. */
export const APP_OUT = path.join(DIST, "app");
/**
 * Upload to the RuntimeFS host root. Separate from APP_OUT because these files
 * must be reachable as real files on the origin: service worker scripts bypass
 * service workers, so a copy living only in the virtual tree can never load.
 */
export const HOST_OUT = path.join(DIST, "host-root");
/**
 * The marketing site, and the one part of this repo that is not MIT. It is
 * AGPL-3.0, it is a separate artifact, and it is deployed to a different place
 * than the editor. Keeping it as a sibling of APP_OUT rather than a folder
 * inside it is what makes "the homepage's license does not reach the editor" a
 * fact about the filesystem instead of a promise in a README.
 */
export const HOMEPAGE_OUT = path.join(DIST, "homepage");

/** Node version the vscode checkout pins in .nvmrc. Anything else breaks node-gyp or the build. */
export function requiredNodeVersion() {
  return readFileSync(path.join(VSCODE_ROOT, ".nvmrc"), "utf8").trim();
}

/**
 * node-gyp decides whether a macOS toolchain exists by looking for pkgutil
 * receipts, which some machines lack even with working Command Line Tools, and
 * then fails `npm ci` with "No Xcode or CLT version detected". scripts/shim/
 * xcodebuild answers that probe; the real compiler still does the work. Only
 * macOS has the problem, so only macOS gets the shim.
 */
export function shimmedPath() {
  if (process.platform !== "darwin") {
    return process.env.PATH;
  }
  return `${path.join(RC_ROOT, "scripts", "shim")}${path.delimiter}${process.env.PATH}`;
}

export function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? VSCODE_ROOT,
    env: { ...process.env, PATH: shimmedPath(), ...(opts.env ?? {}) },
    shell: opts.shell ?? false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
}

/**
 * Deep merge for product.overlay.json. `null` deletes a key; keys starting with
 * `_comment` are documentation and are dropped.
 */
export function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (key.startsWith("_comment")) {
      continue;
    }
    if (value === null) {
      delete out[key];
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Matches one allowlist entry in endpoint-allowlist.json against a path relative
 * to DIST. A single `*` stands for part of one segment and never crosses a `/`,
 * which is all the per-locale diagnostic message files need. It lives here, away
 * from check-endpoints.mjs, because that script does its work on import and
 * cannot be loaded by a test.
 */
export function matchesGlob(glob, file) {
  if (!glob.includes("*")) {
    return glob === file;
  }
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(file);
}

/**
 * Upstream strings that name Microsoft's product in UI this build actually
 * shows. The Welcome page is the loudest one: without this, a fresh workspace
 * greets the user with "Get Started with VS Code for the Web".
 *
 * Keys, not offsets: out/nls.keys.json is [module, [key, ...]] pairs and
 * out/nls.messages.json is one flat array in the same order, so a key names a
 * message for as long as upstream keeps the key.
 */
export const BRANDED_NLS_KEYS = [
  "gettingStarted.setupWeb.title",
  "gettingStarted.setupWeb.walkthroughPageTitle",
  "gettingStarted.extensionsWeb.description.interpolated",
  "gettingStarted.commandPalette.description.interpolated",
  "gettingStarted.settingsAndSync.description.interpolated",
  "gettingStarted.setup.OpenFolderWeb.description.interpolated",
  "minWelcomeDescription",
  "workbench.startupEditor.welcomePage",
  "onboarding.a.aria",
  "onboarding.signIn.heroTitle",
  "onboarding.personalize.tip.suffix",
];

/** Longest first, so "VS Code for the Web" never leaves a stray "for the Web". */
const BRAND_NAMES = [
  "VS Code for the Web",
  "Visual Studio Code",
  "VS Code Web",
  "VS Code",
];

/**
 * Rewrites the branded messages in place and returns the new array. Throws when
 * a listed key has stopped mentioning the product, because that means upstream
 * reworded it and the replacement needs looking at rather than skipping.
 */
export function rebrandNlsMessages(keys, messages, productName) {
  const wanted = new Set(BRANDED_NLS_KEYS);
  const unchanged = new Set(BRANDED_NLS_KEYS);
  const out = messages.slice();

  let index = 0;
  for (const [, moduleKeys] of keys) {
    for (const key of moduleKeys) {
      const at = index++;
      if (!wanted.has(key) || typeof out[at] !== "string") {
        continue;
      }

      let message = out[at];
      for (const name of BRAND_NAMES) {
        message = message.replaceAll(name, productName);
      }
      if (message !== out[at]) {
        out[at] = message;
        unchanged.delete(key);
      }
    }
  }

  if (index !== messages.length) {
    throw new Error(
      `nls.keys.json describes ${index} messages, nls.messages has ${messages.length}`,
    );
  }
  if (unchanged.size) {
    throw new Error(
      `These nls keys no longer name the product, so the rebranding missed them: ${[...unchanged].join(", ")}`,
    );
  }
  return out;
}

/**
 * Refuses to build a checkout that prepare.mjs has not been run against.
 *
 * This exists because the failure it catches is silent and expensive. A `git
 * reset --hard` or a `git checkout` in the vscode tree removes the entire
 * divergence, and nothing downstream notices: gulp builds, staticify runs,
 * check-endpoints passes, and `dist/` looks completely normal. What ships is an
 * unpatched workbench — webviews blank because patch 0003 is gone, the Welcome
 * page missing its RuntimeFS entries because patch 0004 is gone — and the only
 * way to find out is to load it and look.
 *
 * Branding is not a usable signal here, because staticify merges the product
 * overlay itself at package time, so an unprepared build is still called
 * RuntimeCode. The patches are the real test, and `git apply --reverse --check`
 * answers it exactly: it succeeds only if the patch is already applied.
 */
export function assertPrepared() {
  const problems = [];

  const overlay = JSON.parse(
    readFileSync(path.join(RC_ROOT, "product.overlay.json"), "utf8"),
  );
  const product = JSON.parse(
    readFileSync(path.join(VSCODE_ROOT, "product.json"), "utf8"),
  );
  if (overlay.nameLong && product.nameLong !== overlay.nameLong) {
    problems.push(
      `product.json still reads nameLong "${product.nameLong}", not "${overlay.nameLong}"`,
    );
  }

  const patchDir = path.join(RC_ROOT, "patches");
  const patches = existsSync(patchDir)
    ? readdirSync(patchDir)
        .filter((file) => file.endsWith(".patch"))
        .sort()
    : [];
  for (const patch of patches) {
    const applied = spawnSync(
      "git",
      ["apply", "--reverse", "--check", path.join(patchDir, patch)],
      { cwd: VSCODE_ROOT, stdio: "ignore" },
    );
    if (applied.status !== 0) {
      problems.push(`patches/${patch} is not applied`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${VSCODE_ROOT} is not prepared:\n  ${problems.join("\n  ")}\n\n` +
        `Run:  node scripts/prepare.mjs\n\n` +
        `Building anyway produces a dist/ that looks right and is missing the\n` +
        `divergence: blank webviews, no RuntimeFS entries on the Welcome page.`,
    );
  }
}

export function assertVscodeCheckout() {
  if (!existsSync(path.join(VSCODE_ROOT, "product.json"))) {
    throw new Error(
      `No vscode checkout at ${VSCODE_ROOT}.\n` +
        `Clone one, or point RUNTIMECODE_VSCODE at an existing checkout:\n` +
        `  git clone https://github.com/microsoft/vscode.git ${VSCODE_ROOT}\n` +
        `  RUNTIMECODE_VSCODE=/path/to/vscode node scripts/build.mjs`,
    );
  }
}
