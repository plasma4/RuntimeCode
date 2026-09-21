/**
 * Move RuntimeCode to a newer upstream release:
 *   node scripts/upgrade.mjs 1.132.0
 *   node scripts/upgrade.mjs 1.132.0 --min      # release build
 *
 * Writes the new pin, re-applies the divergence, and reports conflicts loudly
 * rather than building something half-patched. Dependencies are reinstalled
 * because they move between tags. Anything after the tag goes to build.mjs.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { RC_ROOT, run, VSCODE_ROOT } from "./lib.mjs";

const [tag, ...buildArgs] = process.argv.slice(2);
if (!tag) {
  console.error(
    "usage: node scripts/upgrade.mjs <tag> [build flags]   e.g. 1.132.0 --min",
  );
  process.exit(1);
}

run("git", ["fetch", "--tags"], { cwd: VSCODE_ROOT });

const known = execFileSync("git", ["tag", "-l", tag], {
  cwd: VSCODE_ROOT,
  encoding: "utf8",
}).trim();
if (known !== tag) {
  console.error(`No such upstream tag: ${tag}`);
  process.exit(1);
}

writeFileSync(path.join(RC_ROOT, "vscode.pin"), tag + "\n");
console.log(`[upgrade] pinned to ${tag}`);

try {
  run("node", [path.join(RC_ROOT, "scripts", "prepare.mjs")]);
} catch (err) {
  console.error(
    `\n[upgrade] prepare failed on ${tag}. This is usually a patch that no longer applies.\n` +
      `Fix the conflict by hand in ${VSCODE_ROOT}, then regenerate that patch from\n` +
      `the working tree, keeping the prose header, which git apply ignores:\n` +
      `  cd ${VSCODE_ROOT}\n` +
      `  { sed '/^diff --git /q' p.patch | sed '$d'; git diff HEAD -- <paths>; } > p.patch.new\n` +
      `Never hand-edit a .patch file: a patch whose index lines do not match real\n` +
      `blobs cannot 3-way merge, and one written that way silently lost four of its\n` +
      `hunks between 1.131.0 and 1.137.0.\n`,
  );
  throw err;
}

console.log("[upgrade] dependencies move between tags, reinstalling");
run("npm", ["ci"], { cwd: VSCODE_ROOT });

// A tag bump invalidates the incremental compile cache.
run("node", [
  path.join(RC_ROOT, "scripts", "build.mjs"),
  "--full",
  ...buildArgs,
]);

console.log(`[upgrade] done: now on ${tag}`);
