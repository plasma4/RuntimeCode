/**
 * Build gate: the artifact has to be able to explain its own terms.
 *
 * Three failures this catches, all of which are invisible at runtime and only
 * become expensive after the thing has been distributed:
 *
 *  1. An extension that never stated its license. The source tree is checked by
 *     staticify before it moves anything; this re-checks the *output*, because
 *     the output is what gets uploaded and the two can drift.
 *  2. An extension whose license file did not survive the copy into dist/. A
 *     license that stayed behind in the repo is not a license the recipient has.
 *  3. Copyleft leaking into the MIT core. The workbench is MIT and the homepage
 *     is AGPL-3.0, and the only thing keeping those apart is that they are
 *     different folders. That is easy to break by accident and impossible to
 *     notice by eye, so it is asserted: no strong-copyleft license text may
 *     appear under dist/app/ outside rc-extensions/, where extensions are
 *     allowed their own terms by design.
 *
 * Runs after staticify and homepage, like check-endpoints, and like it does its
 * work on import. The reusable parts live in scripts/licenses.mjs so the tests
 * can load them without a build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { APP_OUT, DIST, HOMEPAGE_OUT, RC_ROOT } from "./lib.mjs";
import { collectExtensionLicenses } from "./licenses.mjs";

const EXTENSIONS_SRC = path.join(RC_ROOT, "extensions");
const SHIPPED_EXTENSIONS = path.join(APP_OUT, "rc-extensions");

/**
 * Phrases that only appear in a strong-copyleft license grant. Matched against
 * license files rather than all source, because "GPL" shows up in ordinary prose
 * (this file included) and a substring search over a whole build would be noise.
 */
const COPYLEFT_MARKERS = [
  "GNU AFFERO GENERAL PUBLIC LICENSE",
  "GNU GENERAL PUBLIC LICENSE",
];

/** Files that state terms, by name. */
const LICENSE_FILE = /^(LICENSE|LICENCE|COPYING)(\.(txt|md))?$/i;

const failures = [];

if (!existsSync(DIST)) {
  console.error(`[check-licenses] no ${DIST}. Run scripts/build.mjs first.`);
  process.exit(1);
}

// -- 1 & 2: every shipped extension declares terms, and they arrived ---------

const { entries, problems } = collectExtensionLicenses(EXTENSIONS_SRC);
failures.push(...problems);

for (const entry of entries) {
  const shipped = path.join(SHIPPED_EXTENSIONS, entry.id);
  if (!existsSync(shipped)) {
    failures.push(
      `${entry.id}: declared in extensions/ but absent from ${path.relative(DIST, shipped)}.`,
    );
    continue;
  }
  if (!existsSync(path.join(shipped, entry.licenseFile))) {
    failures.push(
      `${entry.id}: ${entry.licenseFile} did not make it into ` +
        `${path.relative(DIST, shipped)}. The terms have to travel with the code.`,
    );
  }
}

const index = path.join(SHIPPED_EXTENSIONS, "LICENSES.md");
if (entries.length > 0 && !existsSync(index)) {
  failures.push(
    `No ${path.relative(DIST, index)}. staticify writes the per-extension index; its absence means the copy step did not run.`,
  );
}

if (!existsSync(path.join(APP_OUT, "LICENSE"))) {
  failures.push("dist/app/LICENSE is missing: the build shipped no license.");
}
if (!existsSync(path.join(APP_OUT, "ThirdPartyNotices.txt"))) {
  failures.push("dist/app/ThirdPartyNotices.txt is missing.");
}

// -- 3: the AGPL homepage stays out of the MIT editor ------------------------

function* licenseFiles(dir) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* licenseFiles(full);
    } else if (LICENSE_FILE.test(entry)) {
      yield full;
    }
  }
}

for (const file of licenseFiles(APP_OUT)) {
  // rc-extensions/ is the aggregation boundary: an extension there may be
  // licensed however its author licensed it, including copyleft. Everywhere
  // else under app/ is the MIT workbench and its permissive dependencies.
  if (file.startsWith(SHIPPED_EXTENSIONS + path.sep)) {
    continue;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const marker = COPYLEFT_MARKERS.find((needle) => text.includes(needle));
  if (marker) {
    failures.push(
      `${path.relative(DIST, file)} contains "${marker}", inside the MIT part of the app.\n` +
        `    Copyleft belongs in rc-extensions/<id>/ (aggregated) or dist/homepage/ (separate artifact),\n` +
        `    never mixed into the workbench.`,
    );
  }
}

if (existsSync(HOMEPAGE_OUT)) {
  if (HOMEPAGE_OUT.startsWith(APP_OUT + path.sep)) {
    failures.push(
      "dist/homepage is inside dist/app. The AGPL homepage has to be a separate artifact.",
    );
  }
  const homepageLicense = path.join(HOMEPAGE_OUT, "LICENSE");
  if (!existsSync(homepageLicense)) {
    failures.push("dist/homepage/LICENSE is missing.");
  } else if (
    !readFileSync(homepageLicense, "utf8").includes(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    )
  ) {
    failures.push("dist/homepage/LICENSE is not the AGPL text.");
  }
}

// -- report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n[check-licenses] FAIL: ${failures.length} problem(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure}\n`);
  }
  process.exit(1);
}

for (const entry of entries) {
  console.log(
    `[check-licenses] rc-extensions/${entry.id}: ${entry.spdx} (${entry.class})`,
  );
}
console.log(
  `[check-licenses] OK: app/ is MIT${existsSync(HOMEPAGE_OUT) ? ", homepage/ is AGPL-3.0" : ""}, every extension states its own terms`,
);
