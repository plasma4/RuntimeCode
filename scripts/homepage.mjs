/**
 * Builds the marketing site into dist/homepage/.
 *
 *   node scripts/homepage.mjs
 *
 * There is no build step, on purpose. The homepage is hand-written HTML and one
 * stylesheet with no web fonts and no third-party requests, so "building" it is
 * a copy plus the checks below. A landing page that advertises a static,
 * serverless, telemetry-free editor should not itself need a toolchain or a CDN.
 *
 * It is a separate artifact from dist/app/ for a licensing reason, not a
 * cosmetic one. The homepage is AGPL-3.0; everything else in this repo is MIT.
 * Keeping it in its own output folder, deployed to its own place, means the two
 * licenses never end up describing the same directory. See check-licenses.mjs,
 * which enforces exactly that.
 *
 * This script deliberately does not need the vscode checkout, so the site can
 * be worked on without a 240 MB editor build sitting behind it.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { RC_ROOT, HOMEPAGE_OUT } from "./lib.mjs";

const SRC = path.join(RC_ROOT, "homepage");

/**
 * Not deliverables. README.md documents the folder for whoever edits it; the
 * LICENSE beside it is the part the public needs and is kept.
 */
const SKIP = new Set([".DS_Store", "node_modules", "README.md"]);

if (!existsSync(path.join(SRC, "index.html"))) {
  throw new Error(`No homepage/index.html at ${SRC}.`);
}

// The AGPL is the entire reason this folder is built separately. A missing or
// swapped license file here would silently turn the separation into theatre,
// so it is checked rather than assumed.
const licensePath = path.join(SRC, "LICENSE");
if (!existsSync(licensePath)) {
  throw new Error(
    `No homepage/LICENSE. The homepage is AGPL-3.0 and its terms have to ship with it.`,
  );
}
const license = readFileSync(licensePath, "utf8");
if (!license.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
  throw new Error(
    `homepage/LICENSE is not the AGPL text. Replace it with the verbatim license from\n` +
      `https://www.gnu.org/licenses/agpl-3.0.txt rather than paraphrasing it.`,
  );
}

rmSync(HOMEPAGE_OUT, { recursive: true, force: true });
mkdirSync(HOMEPAGE_OUT, { recursive: true });
cpSync(SRC, HOMEPAGE_OUT, {
  recursive: true,
  filter: (from) => !SKIP.has(path.basename(from)),
});

console.log(`[homepage] wrote ${HOMEPAGE_OUT} (AGPL-3.0, deploy separately)`);
