/**
 * Tests for extensions/runtime-host/.
 *
 * The host is loaded the way the web extension host loads it — one CommonJS
 * source string through `new Function`, with `require` resolving only 'vscode'
 * — against the fake in test/harness.mjs. What is under test here is the M1
 * contract from RUNTIMES.md: a file runs, output lands in a pseudoterminal, a
 * non-zero exit code propagates, and a capability that needs isolation says so
 * by name instead of failing obliquely.
 *
 * No vscode checkout and no wasm: the pack is a fake provider, which is the
 * point. The host is what is being tested, not the guest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fakeContext,
  fakeDocument,
  loadExtension,
  readManifest,
  settle,
} from "./harness.mjs";

const RC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = "runtime-host";

const INTERNALS = [
  "collectRuntimes",
  "runtimeProblems",
  "formatBytes",
  "capabilitySummary",
  "runtimeDetail",
  "runtimesFor",
  "chooseRuntime",
  "isolationRequired",
  "stdinMode",
  "RuntimePty",
  "specFor",
];

function loadHost(options = {}) {
  return loadExtension({
    extensionDir: EXTENSION_DIR,
    internals: INTERNALS,
    ...options,
  });
}

function runtimeEntry(overrides = {}) {
  return {
    id: "runtime.test",
    displayName: "Test Runtime",
    languages: ["plaintext"],
    tier: "quick",
    site: "worker",
    worker: "./dist/session.js",
    installBytes: 1024 * 1024,
    capabilities: { stdin: "buffered" },
    ...overrides,
  };
}

function testPack(entries = [runtimeEntry()], id = "pack.test") {
  return {
    id,
    packageJSON: { contributes: { "runtimecode.runtimes": entries } },
  };
}

/**
 * A loaded host with `packs` registered and activate() already called. The
 * provider is what `activate()` on the pack resolves to.
 */
function activateHost({
  packs = [testPack()],
  provider = {
    async createSession() {
      return {
        write() {},
        signal() {},
        resize() {},
        dispose() {},
        exit: Promise.resolve(0),
      };
    },
  },
  crossOriginIsolated = false,
} = {}) {
  const loaded = loadHost({ crossOriginIsolated });
  const context = fakeContext();
  const activated = [];
  loaded.vscode.extensions.all = packs.map((pack) => ({
    ...pack,
    async activate() {
      activated.push(pack.id);
      return provider;
    },
  }));
  loaded.exports.activate(context);
  return { ...loaded, context, activated, provider };
}

/** Replaces the quick pick so the test can answer with a known item. */
function answerQuickPick(loaded, index) {
  loaded.vscode.window.showQuickPick = async (items, options) => {
    loaded.calls.messages.push(["quickPick", items, options]);
    return items[index];
  };
}

const warningOf = (loaded) =>
  loaded.calls.messages.find(([kind]) => kind === "warning")?.[1] ?? "";

// ---------------------------------------------------------------------------
// Manifest and loader
// ---------------------------------------------------------------------------

test("the extension loads as one CommonJS file that requires only vscode", () => {
  const { requested, exports } = loadHost();
  assert.deepEqual(requested, ["vscode"]);
  assert.equal(typeof exports.activate, "function");
  assert.equal(typeof exports.deactivate, "function");
});

test("the manifest states MIT and ships the license file with it", () => {
  const manifest = readManifest(EXTENSION_DIR);
  assert.equal(manifest.license, "MIT");
  assert.ok(manifest.browser, "a web extension needs a browser entry point");
  assert.ok(
    manifest.contributes.commands.some((c) => c.command === "runtimecode.run"),
    "Run has to be contributed or nothing can invoke it",
  );
  assert.ok(
    existsSync(path.join(RC_ROOT, "extensions", EXTENSION_DIR, "LICENSE")),
    "check-licenses refuses an extension without a LICENSE beside its code",
  );
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("collectRuntimes reads valid entries and ties them to their extension", () => {
  const { internals } = loadHost();
  const { runtimes, problems } = internals.collectRuntimes([
    testPack([runtimeEntry()], "pack.good"),
  ]);

  assert.deepEqual(problems, []);
  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].id, "runtime.test");
  assert.equal(runtimes[0].extensionId, "pack.good");
});

test("collectRuntimes reports malformed entries instead of using them", () => {
  const { internals } = loadHost();
  const { runtimes, problems } = internals.collectRuntimes([
    testPack([
      runtimeEntry({ id: "runtime.bad-tier", tier: "fast" }),
      runtimeEntry({ id: "runtime.no-languages", languages: [] }),
      runtimeEntry({ id: "runtime.no-worker", worker: "" }),
      "not an object",
    ]),
  ]);

  assert.equal(runtimes.length, 0);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.includes("tier")));
  assert.ok(problems.some((p) => p.includes("languages")));
  assert.ok(problems.some((p) => p.includes("worker")));
  assert.ok(problems.some((p) => p.includes("not an object")));
});

test("a duplicate runtime id is a problem, not a last-one-wins", () => {
  const { internals } = loadHost();
  const { runtimes, problems } = internals.collectRuntimes([
    testPack([runtimeEntry()], "pack.one"),
    testPack([runtimeEntry({ displayName: "Copy" })], "pack.two"),
  ]);

  assert.equal(runtimes.length, 1);
  assert.equal(runtimes[0].extensionId, "pack.one");
  assert.ok(problems.some((p) => p.includes("already provided")));
});

test("collectRuntimes ignores extensions with no runtime contribution", () => {
  const { internals } = loadHost();
  const { runtimes, problems } = internals.collectRuntimes([
    { id: "pack.runtimefs", packageJSON: { contributes: { commands: [] } } },
  ]);
  assert.deepEqual(runtimes, []);
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

test("formatBytes is honest about unknown sizes and rounds like a human reads it", () => {
  const { internals } = loadHost();
  assert.equal(internals.formatBytes(512), "512 B");
  assert.equal(internals.formatBytes(1024), "1.0 KB");
  assert.equal(internals.formatBytes(11 * 1024 * 1024), "11 MB");
  assert.equal(internals.formatBytes(100 * 1024 * 1024), "100 MB");
  assert.equal(internals.formatBytes(undefined), "size unknown");
});

test("capabilitySummary advertises the facts RUNTIMES.md says not to hide", () => {
  const { internals } = loadHost();
  const summary = internals.capabilitySummary({
    stdin: "buffered",
    threads: false,
    packages: "micropip",
  });
  assert.match(summary, /stdin: buffered/);
  assert.match(summary, /threads: no/);
  assert.match(summary, /packages: micropip/);
});

// ---------------------------------------------------------------------------
// Choosing a runtime
// ---------------------------------------------------------------------------

test("runtimesFor keeps the language match and falls back to all", () => {
  const { internals } = loadHost();
  const lua = { ...runtimeEntry({ id: "lua", languages: ["lua"] }) };
  const py = { ...runtimeEntry({ id: "py", languages: ["python"] }) };
  assert.deepEqual(
    internals.runtimesFor([lua, py], "lua").map((r) => r.id),
    ["lua"],
  );
  assert.deepEqual(
    internals.runtimesFor([lua, py], "cobol").map((r) => r.id),
    ["lua", "py"],
  );
});

test("the configured default wins over the last used runtime", async () => {
  const { internals } = loadHost();
  const a = runtimeEntry({ id: "a" });
  const b = runtimeEntry({ id: "b" });
  const picked = await internals.chooseRuntime([a, b], "plaintext", "b");
  assert.equal(picked.id, "b");
});

test("a single candidate is used without asking", async () => {
  const loaded = loadHost();
  let asked = false;
  loaded.vscode.window.showQuickPick = async () => {
    asked = true;
    return undefined;
  };
  const picked = await loaded.internals.chooseRuntime(
    [runtimeEntry()],
    "plaintext",
    "",
  );
  assert.equal(picked.id, "runtime.test");
  assert.equal(asked, false);
});

test("two candidates ask, and the answer is what runs", async () => {
  const loaded = loadHost();
  answerQuickPick(loaded, 1);
  const picked = await loaded.internals.chooseRuntime(
    [runtimeEntry({ id: "a" }), runtimeEntry({ id: "b" })],
    "plaintext",
    "",
  );
  assert.equal(picked.id, "b");
  assert.equal(loaded.calls.messages.filter(([k]) => k === "quickPick").length, 1);
});

// ---------------------------------------------------------------------------
// Isolation and stdin
// ---------------------------------------------------------------------------

test("a pack that needs isolation is refused by name, not obliquely", () => {
  const { internals } = loadHost();
  const message = internals.isolationRequired(
    runtimeEntry({ requires: { crossOriginIsolated: true } }),
    false,
  );
  assert.match(message, /runtimecode\.sameOrigin\.enabled/);
  assert.equal(
    internals.isolationRequired(runtimeEntry(), false),
    undefined,
    "a pack that does not need isolation must not be blocked",
  );
  assert.equal(
    internals.isolationRequired(
      runtimeEntry({ requires: { crossOriginIsolated: true } }),
      true,
    ),
    undefined,
  );
});

test("blocking stdin degrades to buffered with a note when not isolated", () => {
  const { internals } = loadHost();
  const degraded = internals.stdinMode(
    runtimeEntry({ capabilities: { stdin: "blocking" } }),
    false,
  );
  assert.equal(degraded.mode, "buffered");
  assert.match(degraded.note, /runtimecode\.sameOrigin\.enabled/);

  const real = internals.stdinMode(
    runtimeEntry({ capabilities: { stdin: "blocking" } }),
    true,
  );
  assert.equal(real.mode, "blocking");
  assert.equal(real.note, undefined);
});

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

test("Run activates the pack only when chosen, then wires the terminal", async () => {
  const { internals } = loadHost();
  const document = fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" });
  const spec = internals.specFor(
    runtimeEntry(),
    document,
    [{ uri: { scheme: "rfs", path: "/Test" } }],
    "buffered",
  );
  assert.equal(spec.runtimeId, "runtime.test");
  assert.equal(spec.entry.toString(), "rfs:/Test/main.lua");
  assert.equal(spec.stdinMode, "buffered");
  assert.deepEqual(
    spec.mounts.map((mount) => mount.path),
    ["/workspace", "/tmp"],
  );
  assert.equal(spec.cwd.path, "/Test");
});

test("Run pipes stdout, stderr and the exit code through the pseudoterminal", async () => {
  const sessions = [];
  const provider = {
    async createSession(spec, io) {
      sessions.push({ spec, io });
      io.stdout("hello\n");
      io.stderr("oops\n");
      return {
        write() {},
        signal() {},
        resize() {},
        dispose() {},
        exit: Promise.resolve(3),
      };
    },
  };
  const loaded = activateHost({ provider });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();
  await settle();

  assert.deepEqual(loaded.activated, ["pack.test"], "the pack activates at Run time");
  assert.equal(loaded.calls.terminals.length, 1);

  const terminal = loaded.calls.terminals[0];
  assert.equal(terminal.name, "Test Runtime");
  assert.equal(terminal.shown, true);

  const output = [];
  terminal.options.pty.onDidWrite((chunk) => output.push(chunk));
  terminal.options.pty.open(undefined);
  await settle();

  const text = output.join("");
  assert.match(text, /hello\n/);
  assert.match(text, /oops\n/);
  assert.match(text, /\[exited with code 3\]/);
  assert.equal(sessions[0].spec.runtimeId, "runtime.test");
});

test("stdin typed into the terminal reaches the session", async () => {
  const writes = [];
  const provider = {
    async createSession() {
      return {
        write: (data) => writes.push(data),
        signal() {},
        resize() {},
        dispose() {},
        exit: new Promise(() => {}),
      };
    },
  };
  const loaded = activateHost({ provider });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();
  const terminal = loaded.calls.terminals[0];
  terminal.options.pty.open(undefined);
  terminal.options.pty.handleInput("print(1)\n");

  assert.deepEqual(writes, ["print(1)\n"]);
});

test("closing the terminal disposes the session", async () => {
  const disposed = [];
  const provider = {
    async createSession() {
      return {
        write() {},
        signal() {},
        resize() {},
        dispose: () => disposed.push(true),
        exit: new Promise(() => {}),
      };
    },
  };
  const loaded = activateHost({ provider });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();
  loaded.calls.terminals[0].options.pty.close(undefined);
  assert.deepEqual(disposed, [true]);
});

test("a pack that needs isolation never starts a terminal", async () => {
  const loaded = activateHost({
    packs: [testPack([runtimeEntry({ requires: { crossOriginIsolated: true } })])],
  });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();

  assert.equal(loaded.calls.terminals.length, 0);
  assert.match(warningOf(loaded), /runtimecode\.sameOrigin\.enabled/);
});

test("blocking stdin runs buffered and says so in the terminal", async () => {
  const loaded = activateHost({
    packs: [
      testPack([runtimeEntry({ capabilities: { stdin: "blocking" } })]),
    ],
  });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();
  const terminal = loaded.calls.terminals[0];
  const output = [];
  terminal.options.pty.onDidWrite((chunk) => output.push(chunk));
  terminal.options.pty.open(undefined);

  assert.match(output.join(""), /stdin: buffered/);
  assert.match(output.join(""), /runtimecode\.sameOrigin\.enabled/);
});

test("Run with no packs warns instead of opening a dead terminal", async () => {
  const loaded = activateHost({ packs: [] });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();

  assert.equal(loaded.calls.terminals.length, 0);
  assert.match(warningOf(loaded), /No runtime packs/);
});

test("a pack without createSession is a terminal error, not a crash", async () => {
  const loaded = activateHost({ provider: {} });
  loaded.vscode.window.activeTextEditor = {
    document: fakeDocument("rfs:/Test/main.lua", { languageId: "plaintext" }),
    selection: { isEmpty: true },
  };

  await loaded.commands.get("runtimecode.run")();
  const output = [];
  const pty = loaded.calls.terminals[0].options.pty;
  pty.onDidWrite((chunk) => output.push(chunk));
  pty.open(undefined);
  await settle();

  assert.match(output.join(""), /does not export createSession/);
});

test("saveBeforeRun saves dirty documents first, and can be turned off", async () => {
  const loaded = activateHost();
  loaded.vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) =>
      key === "saveBeforeRun" ? false : fallback,
  });
  const document = fakeDocument("rfs:/Test/main.lua", {
    languageId: "plaintext",
    isDirty: true,
  });
  loaded.vscode.window.activeTextEditor = { document, selection: { isEmpty: true } };
  loaded.vscode.workspace.textDocuments = [document];

  await loaded.commands.get("runtimecode.run")();

  assert.match(
    loaded.outputChannels[0].lines.join("\n"),
    /saveBeforeRun is off/,
  );

  loaded.vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (key === "saveBeforeRun" ? true : fallback),
  });
  loaded.calls.terminals.length = 0;
  let saved = false;
  loaded.vscode.workspace.saveAll = async () => {
    saved = true;
    return true;
  };

  await loaded.commands.get("runtimecode.run")();
  assert.equal(saved, true);
});

// ---------------------------------------------------------------------------
// Status bar, picker and registry refresh
// ---------------------------------------------------------------------------

test("the status bar names the runtime, or says there is none", () => {
  const loaded = activateHost();
  assert.equal(loaded.statusItems[0].text, "$(play) Run");
  assert.equal(loaded.statusItems[0].visible, true);
  assert.match(String(loaded.statusItems[0].tooltip), /Test Runtime/);

  const empty = activateHost({ packs: [] });
  assert.equal(empty.statusItems[0].text, "$(play) No runtime");
});

test("a registry change refreshes the status bar", () => {
  const loaded = activateHost({ packs: [] });
  assert.equal(loaded.statusItems[0].text, "$(play) No runtime");

  loaded.vscode.extensions.all = [testPack()];
  for (const listener of loaded.listeners.extensions) {
    listener();
  }
  assert.equal(loaded.statusItems[0].text, "$(play) Run");
});

test("Select Runtime remembers the choice", async () => {
  const loaded = activateHost({
    packs: [testPack([runtimeEntry({ displayName: "Lua" })])],
  });
  answerQuickPick(loaded, 0);

  await loaded.commands.get("runtimecode.pickRuntime")();

  assert.equal(
    loaded.context.globalState.get("runtimecode.runtime.last"),
    "runtime.test",
  );
  assert.match(loaded.calls.messages.at(-1)[1], /Selected Lua/);
});

test("Show Installed Runtimes prints the capability line", () => {
  const loaded = activateHost();
  loaded.commands.get("runtimecode.showRuntimes")();

  const lines = loaded.outputChannels[0].lines.join("\n");
  assert.match(lines, /runtime\.test/);
  assert.match(lines, /stdin: buffered/);
  assert.equal(loaded.outputChannels[0].shown, true);
});
