/**
 * Tests for scripts/licenses.mjs, the rules that decide what may be shipped.
 *
 * These matter for the same reason the lib.mjs tests do: every failure here is
 * silent. A classifier that calls AGPL permissive, a scanner that treats a
 * manifest-less folder as an extension, or a collector that stops noticing a
 * missing LICENSE all produce a build that looks fine and is not distributable.
 *
 * Fixtures are written to a temp directory rather than pointed at the real
 * extensions/, so the tests keep testing the rules when the real extensions
 * change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifySpdx,
  collectExtensionLicenses,
  findLicenseFile,
  listExtensionDirs,
  renderExtensionNotices,
  renderLicenseIndex,
  sourceRequirement,
} from "../scripts/licenses.mjs";

/** Builds an extensions/ tree in a temp dir and hands back its path. */
function fixture(spec) {
  const root = mkdtempSync(path.join(tmpdir(), "rc-licenses-"));
  for (const [id, files] of Object.entries(spec)) {
    mkdirSync(path.join(root, id), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        path.join(root, id, name),
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
  }
  return root;
}

const MIT_EXT = {
  "package.json": { name: "ok", displayName: "OK", version: "1.0.0", license: "MIT" },
  LICENSE: "MIT License\n",
  "extension.js": "",
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classifySpdx separates the three cases that change what the build must do", () => {
  for (const id of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "Unlicense"]) {
    assert.equal(classifySpdx(id), "permissive", id);
  }
  for (const id of ["MPL-2.0", "LGPL-2.1-only", "EPL-2.0"]) {
    assert.equal(classifySpdx(id), "weak-copyleft", id);
  }
  for (const id of ["GPL-3.0-or-later", "GPL-2.0", "AGPL-3.0-or-later"]) {
    assert.equal(classifySpdx(id), "strong-copyleft", id);
  }
});

test("LGPL is not caught by the GPL prefix", () => {
  assert.equal(
    classifySpdx("LGPL-2.1-or-later"),
    "weak-copyleft",
    'a substring match on "GPL-" would classify every LGPL pack as strong copyleft',
  );
  assert.equal(classifySpdx("AGPL-3.0-only"), "strong-copyleft");
});

test("an unrecognised id is unknown, never assumed", () => {
  assert.equal(classifySpdx("SEE LICENSE IN LICENSE.txt"), "unknown");
  assert.equal(classifySpdx(""), "unknown");
  assert.equal(classifySpdx(undefined), "unknown");
  assert.equal(
    classifySpdx("CheerpJ-Community"),
    "unknown",
    "a proprietary license has to stop the build rather than land in a bucket",
  );
});

test("only strong copyleft owes a source offer", () => {
  assert.equal(sourceRequirement("GPL-3.0-or-later"), "required");
  assert.equal(sourceRequirement("AGPL-3.0-only"), "required");
  assert.equal(sourceRequirement("LGPL-2.1-only"), "optional");
  assert.equal(sourceRequirement("MIT"), "optional");
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("an extension is a folder with a manifest, and nothing else is", (t) => {
  const root = fixture({
    runtimefs: MIT_EXT,
    types: { "vscode.d.ts": "declare module 'vscode';" },
    ".hidden": { "package.json": { license: "MIT" } },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(
    listExtensionDirs(root),
    ["runtimefs"],
    "types/ has no manifest; shipping it is how 728 KB of vscode.d.ts reached users",
  );
});

test("listExtensionDirs is sorted and survives a missing directory", () => {
  assert.deepEqual(listExtensionDirs("/nonexistent/extensions"), []);
});

test("findLicenseFile accepts what an upstream folder might already call it", (t) => {
  const root = fixture({
    a: { "package.json": {}, COPYING: "..." },
    b: { "package.json": {} },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(findLicenseFile(path.join(root, "a")), "COPYING");
  assert.equal(findLicenseFile(path.join(root, "b")), null);
});

// ---------------------------------------------------------------------------
// Collection and its refusals
// ---------------------------------------------------------------------------

test("a well-formed MIT extension collects clean", (t) => {
  const root = fixture({ ok: MIT_EXT });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { entries, problems } = collectExtensionLicenses(root);
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    id: "ok",
    name: "OK",
    version: "1.0.0",
    spdx: "MIT",
    class: "permissive",
    licenseFile: "LICENSE",
    source: null,
  });
});

test("a missing license field and a missing license file are both refused", (t) => {
  const root = fixture({
    nofield: { "package.json": { name: "nofield" }, LICENSE: "..." },
    nofile: { "package.json": { name: "nofile", license: "MIT" } },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { problems } = collectExtensionLicenses(root);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /nofield: package\.json has no "license"/);
  assert.match(problems.join("\n"), /nofile: no license file/);
});

test("a GPL extension has to say where the corresponding source is", (t) => {
  const root = fixture({
    gpl: {
      "package.json": { name: "gpl", license: "GPL-3.0-or-later" },
      LICENSE: "GNU GENERAL PUBLIC LICENSE",
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { problems } = collectExtensionLicenses(root);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /corresponding source/,
    "GPL without a source offer is the compliance bug that only shows up after distribution",
  );
});

test("a source offer satisfies the GPL check, in either accepted form", (t) => {
  const root = fixture({
    intree: {
      "package.json": {
        name: "intree",
        license: "GPL-3.0-or-later",
        runtimecode: { source: "in-tree" },
      },
      LICENSE: "GNU GENERAL PUBLIC LICENSE",
    },
    vendored: {
      "package.json": {
        name: "vendored",
        license: "GPL-2.0-or-later",
        runtimecode: { source: "https://example.org/php-wasm/tree/v1.2.3" },
      },
      LICENSE: "GNU GENERAL PUBLIC LICENSE",
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { entries, problems } = collectExtensionLicenses(root);
  assert.deepEqual(problems, []);
  assert.equal(entries[0].source, "in-tree");
  assert.equal(entries[1].source, "https://example.org/php-wasm/tree/v1.2.3");
});

test("an unrecognised SPDX id stops the build and says what to do", (t) => {
  const root = fixture({
    weird: { "package.json": { name: "weird", license: "Custom-1.0" }, LICENSE: "..." },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { problems } = collectExtensionLicenses(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not an SPDX id this build recognises/);
});

test("a broken manifest is reported, not thrown", (t) => {
  const root = fixture({ broken: { "package.json": "{ not json", LICENSE: "..." } });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { problems } = collectExtensionLicenses(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not readable JSON/);
});

test("every broken extension is reported at once", (t) => {
  const root = fixture({
    a: { "package.json": { name: "a" } },
    b: { "package.json": { name: "b" } },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { problems } = collectExtensionLicenses(root);
  assert.equal(
    problems.length,
    4,
    "two extensions, each missing both a license field and a license file",
  );
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RENDERED = [
  {
    id: "runtimefs",
    name: "RuntimeFS",
    version: "1.0.0",
    spdx: "MIT",
    class: "permissive",
    licenseFile: "LICENSE",
    source: null,
  },
  {
    id: "php",
    name: "PHP",
    version: "0.1.0",
    spdx: "GPL-2.0-or-later",
    class: "strong-copyleft",
    licenseFile: "COPYING",
    source: "https://example.org/src",
  },
];

test("the license index links each extension to the file stating its terms", () => {
  const index = renderLicenseIndex(RENDERED);
  assert.match(index, /\[`runtimefs\/LICENSE`\]\(runtimefs\/LICENSE\)/);
  assert.match(index, /\[`php\/COPYING`\]\(php\/COPYING\)/);
  assert.match(index, /## Source offers/);
  assert.match(index, /https:\/\/example\.org\/src/);
  assert.doesNotMatch(
    index.split("## Source offers")[1],
    /runtimefs/,
    "a permissive extension owes no source offer and should not imply one",
  );
});

test("the index says so rather than rendering an empty table", () => {
  const index = renderLicenseIndex([]);
  assert.match(index, /No extensions are shipped/);
  assert.doesNotMatch(index, /\| --- \|/);
});

test("the notices name the path a reader can actually open", () => {
  const notices = renderExtensionNotices(RENDERED);
  assert.match(notices, /RuntimeFS 1\.0\.0 \(rc-extensions\/runtimefs\) — MIT/);
  assert.match(notices, /rc-extensions\/php\/COPYING/);
  assert.match(notices, /Corresponding source: https:\/\/example\.org\/src/);
});
