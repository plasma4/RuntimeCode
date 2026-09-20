/**
 * Type-checks the extensions, which are plain JavaScript on purpose.
 *
 * They cannot become TypeScript. The web extension host loads an extension by
 * wrapping its source in `new Function('module','exports','require', src)`
 * (extHostExtensionService.ts:87), so what ships has to be one CommonJS file
 * with no build step. `// @ts-check` plus JSDoc gets the same checker without
 * one.
 *
 * `vscode.d.ts` is an ambient `declare module 'vscode'`, so simply including it
 * in the program resolves the import. It is copied out of the checkout rather
 * than vendored, which keeps the types pinned to the tag we build against and
 * respects RUNTIMECODE_VSCODE. The copy is gitignored.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { assertVscodeCheckout, run, RC_ROOT, VSCODE_ROOT } from "./lib.mjs";

const TYPES_DIR = path.join(RC_ROOT, "extensions", "types");
// Named explicitly: `tsc --project <dir>` looks for tsconfig.json and will not
// find a jsconfig.json, even though it reads one happily when given the path.
const PROJECTS = [
  path.join(RC_ROOT, "extensions", "runtimefs", "jsconfig.json"),
  path.join(RC_ROOT, "extensions", "python-rc", "jsconfig.json"),
];

assertVscodeCheckout();

const source = path.join(VSCODE_ROOT, "src", "vscode-dts", "vscode.d.ts");
if (!existsSync(source)) {
  throw new Error(
    `No vscode.d.ts at ${source}. Is ${VSCODE_ROOT} a full checkout?`,
  );
}
mkdirSync(TYPES_DIR, { recursive: true });
copyFileSync(source, path.join(TYPES_DIR, "vscode.d.ts"));

const tsc = path.join(VSCODE_ROOT, "node_modules", ".bin", "tsc");
if (!existsSync(tsc)) {
  throw new Error(
    `No TypeScript at ${tsc}. Run npm ci in ${VSCODE_ROOT} first.`,
  );
}

for (const project of PROJECTS) {
  console.log(`[typecheck] ${path.relative(RC_ROOT, path.dirname(project))}`);
  run(tsc, ["--noEmit", "--project", project], { cwd: RC_ROOT });
}

console.log("[typecheck] OK");
