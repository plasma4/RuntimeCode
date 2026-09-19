/**
 * Applies RuntimeCode's divergence to the vscode checkout, in the order that
 * keeps upgrades cheap: overlay files first, then the product.json merge, then
 * the patch series last (smallest surface, most likely to conflict).
 *
 * Everything it touches is reset from git first, so the checkout is always
 * recoverable with `git -C ../vscode reset --hard` even though it is not
 * literally untouched while a build is in flight.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertVscodeCheckout,
  deepMerge,
  RC_ROOT,
  run,
  VSCODE_ROOT,
} from "./lib.mjs";

/**
 * Build from the pinned release tag, never from main. Upstream main is not
 * always buildable: at d49227af15b the mangler rejected the tree outright
 * ("Protected fields have been made PUBLIC"), which has nothing to do with our
 * changes and cannot be worked around from here.
 */
function checkoutPin() {
  const pin = readFileSync(path.join(RC_ROOT, "vscode.pin"), "utf8").trim();

  let current;
  try {
    current = execFileSync("git", ["describe", "--tags", "--exact-match"], {
      cwd: VSCODE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    current = "(not on a tag)"; // detached or ahead of tags, e.g. main
  }

  if (current === pin) {
    console.log(`[prepare] already on ${pin}`);
    return;
  }
  console.log(`[prepare] checking out ${pin} (was ${current})`);
  run("git", ["checkout", pin], { cwd: VSCODE_ROOT });
  console.log(
    "[prepare] NOTE: dependencies may differ across tags. Rerun `npm ci` if the build fails",
  );
}

function resetTouchedFiles() {
  // Must be `reset --hard`, not `checkout -- .`: `git apply --3way` stages its
  // result, and `checkout -- .` restores the working tree FROM the index, so it
  // would happily preserve a previous patch application and make this script
  // non-idempotent. For the same reason this has to run BEFORE the tag
  // checkout, which would otherwise carry that staged application across.
  // Untracked files are left alone so out-build/ and .build/ survive. Losing
  // them turns a 33s rebuild into a 15 minute one.
  run("git", ["reset", "--hard", "HEAD"], { cwd: VSCODE_ROOT });
}

function applyOverlay() {
  const overlayDir = path.join(RC_ROOT, "overlay");
  if (!existsSync(overlayDir) || readdirSync(overlayDir).length === 0) {
    console.log("[prepare] overlay/ is empty, skipping");
    return;
  }
  cpSync(overlayDir, VSCODE_ROOT, { recursive: true });
  console.log("[prepare] copied overlay/ into the checkout");
}

function mergeProduct() {
  const productPath = path.join(VSCODE_ROOT, "product.json");
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  const overlay = JSON.parse(
    readFileSync(path.join(RC_ROOT, "product.overlay.json"), "utf8"),
  );
  const merged = deepMerge(product, overlay);
  writeFileSync(productPath, JSON.stringify(merged, null, "\t") + "\n");
  console.log(
    `[prepare] merged product.overlay.json -> product.json (${merged.nameLong})`,
  );
}

function applyPatches() {
  const patchDir = path.join(RC_ROOT, "patches");
  const patches = existsSync(patchDir)
    ? readdirSync(patchDir)
        .filter((f) => f.endsWith(".patch"))
        .sort()
    : [];

  if (patches.length === 0) {
    console.log("[prepare] no patches to apply");
    return;
  }

  for (const patch of patches) {
    console.log(`[prepare] applying ${patch}`);
    // --3way gives a useful conflict instead of a bare rejection when upstream moves.
    run("git", ["apply", "--3way", path.join(patchDir, patch)], {
      cwd: VSCODE_ROOT,
    });
  }
}

assertVscodeCheckout();
resetTouchedFiles();
checkoutPin();
applyOverlay();
mergeProduct();
applyPatches();
console.log("[prepare] done");
