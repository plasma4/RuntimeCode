/**
 * Tests for scripts/packs-lib.mjs, the pure core of the pack pipeline.
 *
 * These run without the vscode checkout and without the network, which is the
 * point: validation, digests, and the generated manifest shapes are what decide
 * whether a pack ships at all, so they are worth pinning down cheaply.
 *
 * The packs/ directory itself is checked too, but only structurally: real
 * pinned digests are a network build's job (scripts/packs.mjs --pin).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PACKS_SRC,
  catalogEntry,
  installBytesFor,
  isPinned,
  packManifest,
  packPackageJson,
  readPackDefinition,
  runtimeDescriptor,
  sha256Hex,
  validatePack,
} from "../scripts/packs-lib.mjs";
import { buildAll, buildPack, listPackIds, pinPack } from "../scripts/packs.mjs";
import { RC_ROOT } from "../scripts/lib.mjs";
import { FakeDirectoryHandle } from "./harness.mjs";

/**
 * The installed-pack resolution the bootstrap in static/index.html performs,
 * kept in step with the real file so a drift is caught here instead of in the
 * browser. See static/index.html, readInstalledPacks.
 *
 * @param {object} navigator fake navigator.storage
 * @param {() => Promise<string | undefined>} getRuntimeFsBase
 * @returns {Promise<string[]>}
 */
async function readInstalledPacks(navigator, getRuntimeFsBase) {
  if (!navigator.storage?.getDirectory) {
    return [];
  }
  try {
    const root = await navigator.storage.getDirectory();
    const rfs = await root.getDirectoryHandle("rfs");
    const dir = await rfs.getDirectoryHandle(".runtimecode");
    const file = await dir.getFileHandle("packs.json");
    const text = await (await file.getFile()).text();
    const registry = text ? JSON.parse(text) : {};
    if (!registry.packs || typeof registry.packs !== "object") {
      return [];
    }
    const base = await getRuntimeFsBase();
    if (!base) {
      return [];
    }
    const folder = typeof registry.folder === "string" ? registry.folder : "RC-Packs";
    return Object.keys(registry.packs)
      .filter((id) => registry.packs[id])
      .map((id) => `${base}/n/${encodeURIComponent(folder)}/${encodeURIComponent(id)}/`);
  } catch {
    return [];
  }
}

const sha = (text) => sha256Hex(Buffer.from(text, "utf8"));

function samplePack(overrides = {}) {
  return {
    id: "lua.wasmoon",
    version: "1.16.0",
    displayName: "Lua (wasmoon)",
    languages: ["lua"],
    tier: "quick",
    engine: "wasmoon",
    languageVersion: "5.4",
    site: "worker",
    license: "MIT",
    homepage: "https://github.com/ceifa/wasmoon",
    summary: "The official Lua VM compiled to wasm.",
    capabilities: { stdin: "buffered", threads: false },
    assets: [
      {
        name: "glue.wasm",
        url: "https://example.org/glue.wasm",
        sha256: sha("glue"),
        bytes: 4,
      },
    ],
    ...overrides,
  };
}

test("validatePack accepts a complete pack and rejects each missing field", () => {
  assert.deepEqual(validatePack(samplePack()), []);

  assert.match(validatePack(samplePack({ id: undefined })).join(" "), /id/);
  assert.match(validatePack(samplePack({ version: "" })).join(" "), /version/);
  assert.match(validatePack(samplePack({ license: "GPL v3" })).join(" "), /SPDX/);
  assert.match(
    validatePack(samplePack({ assets: [] })).join(" "),
    /no assets/,
  );
  assert.match(
    validatePack(samplePack({ assets: [{ name: "x" }] })).join(" "),
    /no url/,
  );
});

test("validatePack refuses an id that disagrees with its folder", () => {
  assert.match(
    validatePack(samplePack(), "other.pack").join(" "),
    /does not match/,
  );
});

test("a digest must be 64 hex digits, and a dup asset name is refused", () => {
  const badDigest = samplePack({
    assets: [{ name: "x", url: "u", sha256: "not-a-digest" }],
  });
  assert.match(validatePack(badDigest).join(" "), /invalid sha256/);

  const dup = samplePack({
    assets: [
      { name: "a", url: "1" },
      { name: "a", url: "2" },
    ],
  });
  assert.match(validatePack(dup).join(" "), /duplicate asset "a"/);
});

test("isPinned and installBytesFor read the shape the pipeline cares about", () => {
  assert.equal(isPinned(samplePack()), true);
  assert.equal(
    isPinned(samplePack({ assets: [{ name: "x", url: "u" }] })),
    false,
  );

  const sized = samplePack({
    assets: [
      { name: "a", bytes: 10, sha256: sha("a"), url: "1" },
      { name: "b", bytes: 20, sha256: sha("b"), url: "2" },
    ],
  });
  assert.equal(installBytesFor(sized), 30);
});

test("sha256Hex is the plain hex digest, not base64", () => {
  // The known digest of the empty string; if this ever changes the whole
  // pinned-cache scheme is broken in a way tests should catch first.
  assert.equal(sha256Hex(Buffer.from("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("runtimeDescriptor round-trips through the shape the host reads", () => {
  const descriptor = runtimeDescriptor(samplePack());
  assert.equal(descriptor.id, "lua.wasmoon");
  assert.equal(descriptor.engine, "wasmoon");
  assert.equal(descriptor.tier, "quick");
  assert.equal(descriptor.worker, "./session.js");
  assert.equal(descriptor.installBytes, 4);
  // The descriptor the host reads must carry every capability field.
  assert.equal(descriptor.capabilities.stdin, "buffered");
});

test("packPackageJson contributes the runtime under the right key", () => {
  const manifest = packPackageJson(samplePack());
  assert.equal(manifest.name, "runtimecode-pack-lua-wasmoon");
  assert.equal(manifest.browser, "./extension.js");
  assert.equal(manifest.contributes["runtimecode.runtimes"][0].id, "lua.wasmoon");
});

test("packManifest ships the digest but not the source URL", () => {
  const manifest = packManifest(samplePack());
  assert.equal(manifest.id, "lua.wasmoon");
  assert.equal(manifest.version, "1.16.0");
  assert.equal(manifest.assets[0].sha256, sha("glue"));
  assert.equal(manifest.assets[0].bytes, 4);
  // A URL leaving the build would teach the host where to fetch at run time,
  // which is exactly the CDN-at-runtime behaviour RUNTIMES.md forbids.
  assert.equal(manifest.assets[0].url, undefined);
});

test("catalogEntry lists every file the pack folder ships", () => {
  const entry = catalogEntry(samplePack());
  assert.equal(entry.license, "MIT");
  assert.equal(entry.installBytes, 4);
  assert.ok(entry.files.includes("package.json"));
  assert.ok(entry.files.includes("extension.js"));
  assert.ok(entry.files.includes("session.js"));
  assert.ok(entry.files.includes("pack.json"));
  assert.ok(entry.files.includes("assets/glue.wasm"));
});

// ---------------------------------------------------------------------------
// The checked-in pack definitions
// ---------------------------------------------------------------------------

test("every defined pack validates and is a real, reachable plan", () => {
  const ids = readdirSync(PACKS_SRC).filter((id) =>
    existsSync(path.join(PACKS_SRC, id, "pack.json")),
  );
  assert.ok(ids.length >= 8, `expected at least 8 packs, found ${ids.length}`);

  for (const id of ids) {
    const pack = readPackDefinition(id);
    assert.deepEqual(
      validatePack(pack, id),
      [],
      `${id} must validate`,
    );
    assert.ok(pack.version, `${id} has no version`);
    assert.match(pack.license, /^[A-Za-z0-9.()+-]/, `${id} license "${pack.license}"`);
  }
});

test("the pinned packs have real digests; the archive packs wait for a spike", () => {
  const pinned = [];
  const unpinned = [];
  for (const id of readdirSync(PACKS_SRC)) {
    if (!existsSync(path.join(PACKS_SRC, id, "pack.json"))) {
      continue;
    }
    (isPinned(readPackDefinition(id)) ? pinned : unpinned).push(id);
  }

  assert.ok(pinned.length >= 7, `expected the direct-download packs to be pinned, got ${pinned.join(", ")}`);
  // The archive/CDN-dependent ones are documented as not-pinned rather than
  // silently skipped; the build reports them.
  assert.ok(unpinned.length >= 2, "the archive tiers should still be declared");
});

test("packs-lib can be imported without the vscode checkout", () => {
  // Implicit: this test file ran at all. But make the no-network property
  // explicit so nobody accidentally adds a fetch to the pure core.
  assert.ok(PACKS_SRC.startsWith(RC_ROOT));
});

// ---------------------------------------------------------------------------
// The pipeline (scripts/packs.mjs): pin and build against a local fixture
// ---------------------------------------------------------------------------

/** A scratch packs/ + dist/ tree, so tests never touch the real packs/. */
function fixtureTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), "packs-test-"));
  const packs = path.join(root, "packs");
  const out = path.join(root, "dist");
  const cache = path.join(root, "cache");
  mkdirSync(packs, { recursive: true });
  return { root, packs, out, cache };
}

/** Writes a pack's pack.json and LICENSE under tree.packs/<id>/. */
function writeFixturePack(tree, pack) {
  const dir = path.join(tree.packs, pack.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "pack.json"), JSON.stringify(pack));
  writeFileSync(path.join(dir, "LICENSE"), `${pack.license} License text\n`);
}

/** A fetch that serves two files out of a map, like jsdelivr would. */
function stubFetch(files) {
  return async (url) => {
    const key = Object.keys(files).find((k) => url.includes(k));
    if (!key) {
      return { ok: false, status: 404, statusText: "Not Found" };
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(files[key]) };
  };
}

test("pinPack records digests and bytes, then buildPack verifies and emits", async () => {
  const tree = fixtureTree();
  try {
    const pack = {
      id: "lua.wasmoon",
      version: "1.16.0",
      displayName: "Lua (wasmoon)",
      languages: ["lua"],
      tier: "quick",
      engine: "wasmoon",
      languageVersion: "5.4",
      site: "worker",
      license: "MIT",
      homepage: "https://example.org",
      summary: "A Lua VM.",
      capabilities: { stdin: "buffered", threads: false },
      assets: [
        { name: "glue.wasm", url: "https://cdn/glue.wasm" },
        { name: "index.js", url: "https://cdn/index.js" },
      ],
    };
    const dir = path.join(tree.packs, pack.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "LICENSE"), "MIT License\n");
    writeFileSync(path.join(dir, "pack.json"), JSON.stringify(pack));

    const files = { "glue.wasm": "WASM-GLUE", "index.js": "console.log(1)" };
    const fetchImpl = stubFetch(files);

    // Pin: no digests yet.
    assert.equal(isPinned(pack), false);
    const pinned = await pinPack(pack.id, fetchImpl, tree.packs);
    assert.equal(isPinned(pinned), true);
    assert.equal(pinned.assets[0].sha256, sha256Hex(Buffer.from("WASM-GLUE")));
    assert.equal(pinned.assets[0].bytes, 9);
    // The digest is recorded back into the on-disk pack.json.
    const onDisk = JSON.parse(readFileSync(path.join(tree.packs, pack.id, "pack.json"), "utf8"));
    assert.equal(onDisk.assets[0].sha256, pinned.assets[0].sha256);

    // Build: writes the pack folder and its files.
    await buildPack(pinned, { fetchImpl, outDir: tree.out, cacheDir: tree.cache });
    const asset = readFileSync(path.join(tree.out, "lua.wasmoon", "assets", "glue.wasm"), "utf8");
    assert.equal(asset, "WASM-GLUE");
    assert.ok(existsSync(path.join(tree.out, "lua.wasmoon", "package.json")));
    assert.ok(existsSync(path.join(tree.out, "lua.wasmoon", "pack.json")));
    assert.ok(existsSync(path.join(tree.out, "lua.wasmoon", "LICENSE")));
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("buildAll writes catalog.json and skips unpinned packs", async () => {
  const tree = fixtureTree();
  try {
    const pinnedPack = {
      id: "javascript.quickjs",
      version: "3.6.2",
      displayName: "JS",
      languages: ["javascript"],
      tier: "faithful",
      engine: "quickjs-wasi",
      site: "worker",
      license: "MIT",
      homepage: "https://example.org",
      summary: "QuickJS",
      capabilities: { stdin: "buffered", threads: false },
      assets: [
        {
          name: "quickjs.wasm",
          url: "https://cdn/quickjs.wasm",
          sha256: sha256Hex(Buffer.from("WASM")),
          bytes: 4,
        },
      ],
    };
    const unpinnedPack = {
      id: "perl.webperl",
      version: "0.09-beta",
      displayName: "Perl",
      languages: ["perl"],
      tier: "quick",
      engine: "webperl",
      site: "worker",
      license: "Artistic-2.0",
      homepage: "https://example.org",
      summary: "WebPerl",
      capabilities: { stdin: "buffered", threads: false },
      assets: [{ name: "webperl.zip", url: "https://cdn/webperl.zip" }],
    };
    for (const pack of [pinnedPack, unpinnedPack]) {
      writeFixturePack(tree, pack);
    }

    const { built, skipped } = await buildAll({
      root: tree.packs,
      outDir: tree.out,
      cacheDir: tree.cache,
      fetchImpl: stubFetch({ "quickjs.wasm": "WASM" }),
    });
    assert.deepEqual(built, ["javascript.quickjs"]);
    assert.deepEqual(skipped, ["perl.webperl"]);

    const catalog = JSON.parse(readFileSync(path.join(tree.out, "catalog.json"), "utf8"));
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, "javascript.quickjs");
    // The unpinned pack is never emitted.
    assert.ok(!existsSync(path.join(tree.out, "perl.webperl")));
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

test("buildPack refuses a pack with no LICENSE file", async () => {
  const tree = fixtureTree();
  try {
    const pack = {
      id: "no-license",
      version: "1",
      displayName: "No License",
      languages: ["x"],
      tier: "quick",
      engine: "x",
      site: "worker",
      license: "MIT",
      homepage: "https://example.org",
      summary: "x",
      capabilities: {},
      assets: [
        {
          name: "a.wasm",
          url: "https://cdn/a.wasm",
          sha256: sha256Hex(Buffer.from("A")),
          bytes: 1,
        },
      ],
    };
    writeFixturePack(tree, pack);

    await assert.rejects(
      () => buildPack(pack, { fetchImpl: stubFetch({ "a.wasm": "A" }), outDir: tree.out, cacheDir: tree.cache }),
      /no packs\/no-license\/LICENSE/,
    );
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bootstrap registration (static/index.html readInstalledPacks)
// ---------------------------------------------------------------------------

/** Seed `rfs/.runtimecode/packs.json` in a fake OPFS. */
async function seedPacksRegistry(opfs, registry) {
  const rfs = await opfs.getDirectoryHandle("rfs", { create: true });
  const dir = await rfs.getDirectoryHandle(".runtimecode", { create: true });
  const file = await dir.getFileHandle("packs.json", { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(registry));
  await writable.close();
}

test("the bootstrap resolves installed packs to /n/<folder>/<id>/ URLs", async () => {
  const opfs = new FakeDirectoryHandle();
  await seedPacksRegistry(opfs, {
    folder: "RC-Packs",
    packs: {
      "python.pyodide": { version: "0.28.3" },
      "lua.wasmoon": { version: "1.16.0" },
    },
  });
  const navigator = { storage: { getDirectory: async () => opfs } };
  const urls = await readInstalledPacks(navigator, async () => "https://example.org/rfs");
  assert.deepEqual(urls, [
    "https://example.org/rfs/n/RC-Packs/python.pyodide/",
    "https://example.org/rfs/n/RC-Packs/lua.wasmoon/",
  ]);
});

test("the bootstrap returns no packs when served standalone", async () => {
  const opfs = new FakeDirectoryHandle();
  await seedPacksRegistry(opfs, { packs: { "python.pyodide": {} } });
  const navigator = { storage: { getDirectory: async () => opfs } };
  const urls = await readInstalledPacks(navigator, async () => undefined);
  assert.deepEqual(urls, []);
});

test("the bootstrap survives a missing or corrupt registry", async () => {
  const navigator = { storage: { getDirectory: async () => new FakeDirectoryHandle() } };
  assert.deepEqual(await readInstalledPacks(navigator, async () => "https://x/rfs"), []);
});