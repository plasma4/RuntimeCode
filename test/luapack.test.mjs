/**
 * Tests for extensions/lua-wasmoon/.
 *
 * These run the real vendored wasmoon and the real Lua VM in Node. The glue is
 * evaluated the same way the extension evaluates it, with worker-shaped globals
 * passed as function parameters (there is no browser here), and the two asset
 * fetches are served from disk. That makes this the strongest verification
 * available without a built editor: real Lua source in, terminal-shaped
 * callbacks out.
 *
 * The digest test is the other half. Vendored binaries rot silently; a mismatch
 * means the asset and pack.json disagree, and the pack must not ship that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadExtension, readManifest } from "./harness.mjs";

const RC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_DIR = path.join(RC_ROOT, "extensions", "lua-wasmoon");
const INTERNALS = ["setEnvironment", "assetUrl", "createSession"];
const BASE = "https://rc.test/rc-extensions/lua-wasmoon/";

const readAsset = (name) => readFileSync(path.join(PACK_DIR, "assets", name));

/** Serves the two vendored assets and records every URL it was asked for. */
function assetFetch(requests) {
  return async (url) => {
    const target = String(url);
    requests.push(target);
    if (target.endsWith("wasmoon-1.16.0.js")) {
      return new Response(readAsset("wasmoon-1.16.0.js"), {
        headers: { "content-type": "text/javascript" },
      });
    }
    if (target.endsWith("glue-1.16.0.wasm")) {
      return new Response(readAsset("glue-1.16.0.wasm"), {
        headers: { "content-type": "application/wasm" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

/**
 * The globals that put emscripten's glue on its worker branch, plus the fetch
 * it uses for glue.wasm. They travel through setEnvironment() as function
 * parameters, which is the only way to shadow globals inside `new Function`.
 */
function workerEnvironment(requests) {
  const href = `${BASE}assets/wasmoon-1.16.0.js`;
  return {
    process: undefined,
    window: undefined,
    document: undefined,
    location: { href },
    self: { location: { href } },
    importScripts: () => {},
    fetch: assetFetch(requests),
  };
}

function loadPack(requests = []) {
  const loaded = loadExtension({
    extensionDir: "lua-wasmoon",
    internals: INTERNALS,
    fetch: assetFetch(requests),
  });
  loaded.internals.setEnvironment(workerEnvironment(requests));
  loaded.exports.activate({
    subscriptions: [],
    extensionUri: loaded.vscode.Uri.parse(BASE),
  });
  return loaded;
}

/** Runs `source` as the entry file and returns the terminal-shaped callbacks. */
function runSource(loaded, source) {
  loaded.vscode.workspace.fs.readFile = async () =>
    new TextEncoder().encode(source);
  const stdout = [];
  const stderr = [];
  const io = {
    stdout: (data) => stdout.push(String(data)),
    stderr: (data) => stderr.push(String(data)),
    diag() {},
    ready() {},
  };
  const spec = {
    runtimeId: "lua.wasmoon",
    entry: loaded.vscode.Uri.parse("rfs:/Demo/main.lua"),
    argv: [],
    env: {},
    cwd: loaded.vscode.Uri.parse("rfs:/Demo"),
    mounts: [],
    stdinMode: "none",
  };
  return { stdout, stderr, io, spec };
}

// ---------------------------------------------------------------------------
// Vendoring record and manifest
// ---------------------------------------------------------------------------

test("every vendored asset matches the digest recorded in pack.json", () => {
  const pack = JSON.parse(readFileSync(path.join(PACK_DIR, "pack.json"), "utf8"));
  for (const asset of pack.assets) {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(PACK_DIR, asset.path)))
      .digest("hex");
    assert.equal(digest, asset.sha256, `${asset.path} does not match pack.json`);
  }
  const total = pack.assets.reduce(
    (sum, asset) => sum + readFileSync(path.join(PACK_DIR, asset.path)).length,
    0,
  );
  assert.equal(
    pack.installBytes,
    total,
    "installBytes has to be what the assets actually weigh",
  );
});

test("the runtime host accepts this pack's contribution", () => {
  const host = loadExtension({
    extensionDir: "runtime-host",
    internals: ["collectRuntimes"],
  });
  const manifest = readManifest("lua-wasmoon");
  const { runtimes, problems } = host.internals.collectRuntimes([
    { id: "lua-wasmoon", packageJSON: manifest },
  ]);

  assert.deepEqual(problems, []);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].id, "lua.wasmoon");
  assert.equal(runtimes[0].site, "host");
  assert.equal(runtimes[0].capabilities.stdin, "none");
});

// ---------------------------------------------------------------------------
// Real Lua, in the pack
// ---------------------------------------------------------------------------

test("a Lua file runs and print lands on stdout with exit code 0", async () => {
  const requests = [];
  const loaded = loadPack(requests);
  const { stdout, stderr, io, spec } = runSource(
    loaded,
    'print("hello", 1 + 1)\nprint(_VERSION)',
  );

  const session = await loaded.exports.createSession(spec, io);
  assert.equal(await session.exit, 0);

  assert.deepEqual(stdout, ["hello\t2\n", "Lua 5.4\n"]);
  assert.deepEqual(stderr, []);
  assert.deepEqual(requests, [
    `${BASE}assets/wasmoon-1.16.0.js`,
    `${BASE}assets/glue-1.16.0.wasm`,
  ]);
});

test("a Lua error goes to stderr and exits non-zero", async () => {
  const loaded = loadPack();
  const { stdout, stderr, io, spec } = runSource(loaded, 'error("boom")');

  const session = await loaded.exports.createSession(spec, io);
  assert.equal(await session.exit, 1);

  assert.deepEqual(stdout, []);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /boom/);
});

test("warn() is the stderr channel", async () => {
  const loaded = loadPack();
  const { stderr, io, spec } = runSource(loaded, 'warn("careful")');

  const session = await loaded.exports.createSession(spec, io);
  assert.equal(await session.exit, 0);
  assert.deepEqual(stderr, ["careful\n"]);
});

test("an unreadable entry file is an error, not a crash", async () => {
  const loaded = loadPack();
  const { stderr, io, spec } = runSource(loaded, "print('never')");
  loaded.vscode.workspace.fs.readFile = async () => {
    throw new Error("nope");
  };

  const session = await loaded.exports.createSession(spec, io);
  assert.equal(await session.exit, 1);
  assert.match(stderr[0], /Could not read rfs:\/Demo\/main\.lua/);
});

test("each session gets its own Lua state", async () => {
  const loaded = loadPack();

  const first = runSource(loaded, "x = 42");
  const firstSession = await loaded.exports.createSession(first.spec, first.io);
  assert.equal(await firstSession.exit, 0);

  const second = runSource(loaded, "print(x)");
  const secondSession = await loaded.exports.createSession(second.spec, second.io);
  assert.equal(await secondSession.exit, 0);
  assert.deepEqual(second.stdout, ["nil\n"], "globals must not leak between runs");
});

test("the session shape is the contract the host wires", async () => {
  const loaded = loadPack();
  const { io, spec } = runSource(loaded, "");
  const session = await loaded.exports.createSession(spec, io);

  assert.equal(typeof session.write, "function");
  assert.equal(typeof session.signal, "function");
  assert.equal(typeof session.resize, "function");
  assert.equal(typeof session.dispose, "function");
  assert.ok(session.exit instanceof Promise);
  assert.equal(await session.exit, 0);

  session.dispose();
  session.dispose();
});
