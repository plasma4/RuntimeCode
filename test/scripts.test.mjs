/**
 * Tests for the pure helpers in scripts/lib.mjs.
 *
 * These three decide what a build produces, and all three fail quietly. A
 * deepMerge that stops deleting leaves a Microsoft endpoint in product.json; a
 * matchesGlob that starts crossing `/` turns the endpoint gate into a rubber
 * stamp; a rebrand that silently skips a key ships a Welcome page reading "Get
 * Started with VS Code for the Web".
 *
 * Nothing here needs the vscode checkout, which is the reason they are worth
 * having: the rest of scripts/ cannot run without one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BRANDED_NLS_KEYS,
  deepMerge,
  matchesGlob,
  rebrandNlsMessages,
} from "../scripts/lib.mjs";

// ---------------------------------------------------------------------------
// product.overlay.json
// ---------------------------------------------------------------------------

test("deepMerge overrides scalars and merges objects", () => {
  const base = { nameShort: "Code", nested: { keep: 1, replace: 2 } };
  const merged = deepMerge(base, {
    nameShort: "RuntimeCode",
    nested: { replace: 3, add: 4 },
  });

  assert.deepEqual(merged, {
    nameShort: "RuntimeCode",
    nested: { keep: 1, replace: 3, add: 4 },
  });
  assert.deepEqual(
    base.nested,
    { keep: 1, replace: 2 },
    "the overlay must not mutate what it merges into",
  );
});

test("deepMerge deletes on null, which is how endpoints come out of product.json", () => {
  const merged = deepMerge(
    {
      extensionsGallery: { serviceUrl: "https://marketplace.visualstudio.com" },
      keep: true,
    },
    { extensionsGallery: null },
  );

  assert.deepEqual(merged, { keep: true });
  assert.ok(
    !("extensionsGallery" in merged),
    "a deleted key has to be absent, not undefined",
  );
});

test("deepMerge drops _comment keys and replaces arrays whole", () => {
  const merged = deepMerge(
    { builtInExtensions: ["a", "b"], real: 1 },
    { _comment: "why", _commentMore: "more", builtInExtensions: ["c"] },
  );

  assert.deepEqual(
    merged,
    { builtInExtensions: ["c"], real: 1 },
    "merging arrays element-wise would produce a list nobody wrote",
  );
});

// ---------------------------------------------------------------------------
// endpoint-allowlist.json
// ---------------------------------------------------------------------------

test("matchesGlob allows one star inside a segment and never across one", () => {
  assert.ok(matchesGlob("app/out/nls.messages.js", "app/out/nls.messages.js"));
  assert.ok(!matchesGlob("app/out/nls.messages.js", "app/out/nls.keys.json"));

  assert.ok(
    matchesGlob(
      "app/extensions/typescript-language-features/dist/*.js",
      "app/extensions/typescript-language-features/dist/browser.js",
    ),
  );
  assert.ok(
    !matchesGlob(
      "app/extensions/typescript-language-features/dist/*.js",
      "app/extensions/typescript-language-features/dist/nested/browser.js",
    ),
    "a star that crosses / would allow a whole subtree nobody reviewed",
  );

  // The dot is a literal, or `a.js` would also match `axjs`.
  assert.ok(!matchesGlob("app/*.js", "app/outxjs"));
});

// ---------------------------------------------------------------------------
// Rebranding
// ---------------------------------------------------------------------------

/** nls.keys.json is [module, [key, ...]] pairs; nls.messages.json is one flat array. */
function nlsFixture(message = "Get Started with VS Code for the Web") {
  return {
    keys: [
      ["vs/workbench/contrib/welcome", [...BRANDED_NLS_KEYS]],
      ["vs/other", ["untouched.key"]],
    ],
    messages: [
      ...BRANDED_NLS_KEYS.map(() => message),
      "Nothing to do with the product",
    ],
  };
}

test("rebrandNlsMessages renames every branded key and leaves the rest alone", () => {
  const { keys, messages } = nlsFixture();
  const out = rebrandNlsMessages(keys, messages, "RuntimeCode");

  for (let i = 0; i < BRANDED_NLS_KEYS.length; i++) {
    assert.equal(
      out[i],
      "Get Started with RuntimeCode",
      'longest first, or "VS Code for the Web" leaves a stray "for the Web"',
    );
  }
  assert.equal(out.at(-1), "Nothing to do with the product");
  assert.equal(
    messages[0],
    "Get Started with VS Code for the Web",
    "the input array is not the output",
  );
});

test("rebrandNlsMessages refuses a key that has stopped naming the product", () => {
  const { keys, messages } = nlsFixture();
  messages[0] = "Upstream reworded this one";

  assert.throws(
    () => rebrandNlsMessages(keys, messages, "RuntimeCode"),
    new RegExp(BRANDED_NLS_KEYS[0].replace(/\./g, "\\.")),
    "silently skipping the key is how the Welcome page ships unbranded",
  );
});

test("rebrandNlsMessages refuses keys and messages that have drifted apart", () => {
  const { keys, messages } = nlsFixture();
  messages.push("one message too many");

  assert.throws(
    () => rebrandNlsMessages(keys, messages, "RuntimeCode"),
    /describes \d+ messages/,
    "the two files are matched by position, so a length mismatch means every offset is suspect",
  );
});
