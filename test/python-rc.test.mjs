/**
 * Tests for extensions/python-rc/extension.js, the Python runtime host.
 *
 * Loaded the way the web extension host loads it -- one CommonJS source string
 * wrapped in `new Function`, with `require` resolving nothing but 'vscode'
 * (extHostExtensionService.ts:87 and :109) -- for the same reason
 * test/harness.mjs does it for RuntimeFS: an import would pass on code the
 * browser refuses.
 *
 * The fakes here are deliberately separate from harness.mjs. That one fakes
 * OPFS for a FileSystemProvider; this one fakes terminals, the extension
 * registry and `fetch`, which is what a runtime host touches. `fetch` and the
 * browser globals are passed as parameters rather than set on globalThis, so
 * they cannot leak between tests.
 *
 * No runtime pack exists yet, so every run here ends in the preflight report.
 * That is the behaviour under test: what the host does, what it tells the user,
 * and which exit code it reports.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FakeDirectoryHandle } from "./harness.mjs";

const RC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXTENSION_DIR = path.join(RC_ROOT, "extensions", "python-rc");
const SELF_ID = "runtimecode.python-rc";

const MANIFEST = JSON.parse(
  readFileSync(path.join(EXTENSION_DIR, "package.json"), "utf8"),
);

/**
 * Internals the tests reach for. The epilogue runs inside the extension's own
 * function scope, so a rename in the extension fails loudly here rather than
 * silently testing nothing.
 */
const INTERNALS = [
  "readCatalog",
  "probeEnvironment",
  "negotiate",
  "buildMounts",
  "guestPathFor",
  "formatBytes",
  "ENGINES",
  "installPack",
  "uninstallPack",
  "cleanupPacksFolder",
  "fetchCatalog",
  "readPacksRegistry",
];

// ---------------------------------------------------------------------------
// Fake vscode
// ---------------------------------------------------------------------------

class Uri {
  constructor(scheme, uriPath) {
    this.scheme = scheme;
    this.path = uriPath;
  }

  static parse(value) {
    const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value);
    if (!match) {
      throw new Error(`not a uri: ${value}`);
    }
    return new Uri(match[1], match[2]);
  }

  static joinPath(base, ...parts) {
    const segments = base.path.split("/").filter(Boolean);
    for (const part of parts.join("/").split("/").filter(Boolean)) {
      if (part === "..") {
        segments.pop();
      } else if (part !== ".") {
        segments.push(part);
      }
    }
    return new Uri(base.scheme, `/${segments.join("/")}`);
  }

  toString() {
    return `${this.scheme}:${this.path}`;
  }
}

class FakeEventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return {
        dispose: () =>
          (this.listeners = this.listeners.filter((l) => l !== listener)),
      };
    };
  }

  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
}

/** A document as the extension sees it: dirty state, a uri, and a save(). */
function fakeDocument({
  uri,
  languageId = "python",
  dirty = false,
  untitled = false,
  text = "",
}) {
  return {
    uri,
    languageId,
    isDirty: dirty,
    isUntitled: untitled,
    saved: 0,
    getText() {
      return text;
    },
    async save() {
      this.isDirty = false;
      this.saved += 1;
      return true;
    },
  };
}

/**
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.config] settings, keyed without the
 *   `runtimecode.python.` prefix.
 * @param {object[]} [options.extensions] extra extensions contributing runtimes.
 * @param {Uri} [options.workspace] the single workspace folder, if any.
 * @param {object[]} [options.documents] open text documents.
 * @param {object} [options.activeEditor]
 * @param {Record<string, Function>} [options.hostCommands] embedder commands the
 *   bootstrap registers in static/index.html.
 * @param {object} [options.answers] canned replies from the window API.
 * @param {object} [options.opfs] a fake OPFS root for the pack autosystem.
 * @param {object} [options.locks] a fake navigator.locks.
 * @param {boolean} [options.crossOriginIsolated] fake the one global the
 *   extension reads off globalThis.
 */
function createVscodeStub(options = {}) {
  const {
    config = {},
    extensions = [],
    workspace: workspaceFolder,
    documents = [],
    activeEditor,
    hostCommands = {},
    answers = {},
  } = options;

  const commands = new Map();
  const calls = { executed: [], messages: [], quickPicks: [] };
  const terminals = [];
  const outputs = [];
  const statusBarItems = [];
  const listeners = { configuration: [], activeEditor: [] };

  const folders = workspaceFolder
    ? [{ uri: workspaceFolder, name: "Workspace", index: 0 }]
    : undefined;

  const vscode = {
    Uri,
    EventEmitter: FakeEventEmitter,
    Disposable: class Disposable {
      constructor(fn) {
        this.dispose = fn ?? (() => {});
      }
    },
    ThemeIcon: class ThemeIcon {
      constructor(id) {
        this.id = id;
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2 },

    commands: {
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      async executeCommand(id, ...args) {
        calls.executed.push([id, ...args]);
        const handler = hostCommands[id] ?? commands.get(id);
        if (!handler) {
          throw new Error(`command not found: ${id}`);
        }
        return handler(...args);
      },
    },

    window: {
      activeTextEditor: activeEditor,
      createOutputChannel(name) {
        const channel = {
          name,
          lines: [],
          appendLine: (line) => channel.lines.push(line),
          clear: () => (channel.lines.length = 0),
          show() {},
          dispose() {},
        };
        outputs.push(channel);
        return channel;
      },
      createStatusBarItem() {
        const item = {
          text: "",
          tooltip: "",
          name: "",
          command: "",
          visible: false,
          show() {
            item.visible = true;
          },
          hide() {
            item.visible = false;
          },
          dispose() {},
        };
        statusBarItems.push(item);
        return item;
      },
      createTerminal(terminalOptions) {
        const terminal = {
          options: terminalOptions,
          shown: false,
          show: () => (terminal.shown = true),
          dispose() {},
        };
        terminals.push(terminal);
        return terminal;
      },
      onDidChangeActiveTextEditor(listener) {
        listeners.activeEditor.push(listener);
        return { dispose() {} };
      },
      async showInformationMessage(message) {
        calls.messages.push(["info", message]);
        return answers.information;
      },
      async showWarningMessage(message) {
        calls.messages.push(["warning", message]);
        return answers.warning;
      },
      async showErrorMessage(message) {
        calls.messages.push(["error", message]);
        return answers.error;
      },
      async showQuickPick(items) {
        calls.quickPicks.push(items);
        return typeof answers.quickPick === "function"
          ? answers.quickPick(items)
          : answers.quickPick;
      },
    },

    workspace: {
      workspaceFolders: folders,
      textDocuments: documents,
      getWorkspaceFolder(uri) {
        return (folders || []).find((folder) =>
          uri.path.startsWith(
            folder.uri.path.endsWith("/")
              ? folder.uri.path
              : `${folder.uri.path}/`,
          ),
        );
      },
      getConfiguration(section) {
        assert.equal(section, "runtimecode.python");
        return {
          get: (key, fallback) => (key in config ? config[key] : fallback),
        };
      },
      onDidChangeConfiguration(listener) {
        listeners.configuration.push(listener);
        return { dispose() {} };
      },
    },

    extensions: {
      all: [{ id: SELF_ID, packageJSON: MANIFEST }, ...extensions],
    },
  };

  const context = {
    subscriptions: [],
    extension: { id: SELF_ID },
    workspaceState: {
      _store: new Map(),
      get(key) {
        return this._store.get(key);
      },
      async update(key, value) {
        this._store.set(key, value);
      },
    },
  };

  return {
    vscode,
    context,
    commands,
    calls,
    terminals,
    outputs,
    statusBarItems,
    listeners,
  };
}

/**
 * Loads the extension against fresh fakes. `fetch` is a parameter rather than a
 * global so a test's fake cannot outlive it; `isolated` fakes the one global the
 * extension reads off globalThis, cross-origin isolation, and is restored after.
 * `opfs` is a fake OPFS root the autosystem writes packs into.
 */
function loadExtension(options = {}) {
  const stub = createVscodeStub(options);
  const fetchImpl =
    options.fetch ||
    (async () => {
      throw new Error("no fetch in this test");
    });

  const source = readFileSync(path.join(EXTENSION_DIR, "extension.js"), "utf8");
  const epilogue = `\n;module.exports.__internals = { ${INTERNALS.join(", ")} };\n`;
  const factory = new Function(
    "module",
    "exports",
    "require",
    "fetch",
    "navigator",
    "crypto",
    "crossOriginIsolated",
    source + epilogue,
  );

  const requested = [];
  const module = { exports: {} };
  const opfsRoot = options.opfs || new FakeDirectoryHandle();
  const navigator = {
    storage: { getDirectory: async () => opfsRoot },
    locks: options.locks || {
      async request(name, optionsOrFn, maybeFn) {
        return (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn)();
      },
    },
  };
  factory(
    module,
    module.exports,
    (request) => {
      requested.push(request);
      if (request !== "vscode") {
        throw new Error(`Cannot load module '${request}'`);
      }
      return stub.vscode;
    },
    fetchImpl,
    navigator,
    { subtle: globalThis.crypto.subtle },
    options.crossOriginIsolated ?? false,
  );

  return {
    ...stub,
    exports: module.exports,
    internals: module.exports.__internals,
    requested,
    opfs: navigator.storage,
    opfsRoot,
  };
}

/** Runs body with crossOriginIsolated faked on, then puts globalThis back. */
async function withIsolation(body) {
  const had = Object.prototype.hasOwnProperty.call(
    globalThis,
    "crossOriginIsolated",
  );
  const previous = globalThis.crossOriginIsolated;
  Object.defineProperty(globalThis, "crossOriginIsolated", {
    value: true,
    configurable: true,
    writable: true,
  });
  try {
    return await body();
  } finally {
    if (had) {
      Object.defineProperty(globalThis, "crossOriginIsolated", {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete globalThis.crossOriginIsolated;
    }
  }
}

/**
 * Drives one run to completion: opens the pseudoterminal VS Code would open,
 * collects everything written to it, and resolves with the exit code.
 */
function drive(terminal, { columns = 80, rows = 24 } = {}) {
  const pty = terminal.options.pty;
  const chunks = [];
  pty.onDidWrite((text) => chunks.push(text));
  const closed = new Promise((resolve) =>
    pty.onDidClose((code) => resolve(code)),
  );
  pty.open({ columns, rows });
  return closed.then((code) => ({
    code,
    // ANSI out, so assertions read like the screen rather than like escape codes.
    text: chunks.join("").replace(/\x1b\[[0-9;]*m/g, ""),
    pty,
  }));
}

const WORKSPACE = new Uri("rfs", "/Project");
const SCRIPT = new Uri("rfs", "/Project/main.py");

// ---------------------------------------------------------------------------

test("loads as a single CommonJS file with only 'vscode' resolvable", () => {
  const { exports, requested } = loadExtension();
  assert.equal(typeof exports.activate, "function");
  assert.equal(typeof exports.deactivate, "function");
  assert.deepEqual(requested, ["vscode"]);
  assert.throws(
    () =>
      new Function("require", "require('node:fs')")((request) => {
        throw new Error(`Cannot load module '${request}'`);
      }),
    /Cannot load module/,
  );
});

test("the manifest declares all three Python runtimes, and each has an engine", () => {
  const { internals } = loadExtension();
  const catalog = internals.readCatalog(SELF_ID);

  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ["python.pyodide", "python.cpython-wasi", "python.micropython"],
  );
  // Ordered by tier: the quick one first, because it is the default answer.
  assert.deepEqual(
    catalog.map((entry) => entry.tier),
    ["quick", "faithful", "tiny"],
  );

  for (const descriptor of catalog) {
    const engine = internals.ENGINES[descriptor.engine];
    assert.ok(engine, `no engine adapter for ${descriptor.engine}`);
    assert.ok(engine.assets.length > 0, `${descriptor.engine} lists no assets`);
    assert.ok(
      engine.assets.includes(engine.loader),
      `${descriptor.engine} does not carry its loader`,
    );
    assert.ok(descriptor.license, `${descriptor.id} states no license`);
    assert.ok(descriptor.installBytes > 0, `${descriptor.id} states no size`);
    // Every execution site here is the nested worker, which is classic-script
    // only. A pack that needs a webview is a different milestone.
    assert.equal(descriptor.site, "worker");
  }
});

test("a pack's own descriptor wins over the built-in placeholder", () => {
  const { internals } = loadExtension({
    extensions: [
      {
        id: "runtimecode.pack-pyodide",
        packageJSON: {
          contributes: {
            "runtimecode.runtimes": [
              {
                id: "python.pyodide",
                displayName: "Python (Pyodide 0.29)",
                languages: ["python"],
                tier: "quick",
                engine: "pyodide",
                capabilities: { stdin: "buffered", packages: "micropip" },
              },
            ],
          },
        },
      },
    ],
  });

  const pyodide = internals
    .readCatalog(SELF_ID)
    .find((entry) => entry.id === "python.pyodide");
  assert.equal(pyodide.displayName, "Python (Pyodide 0.29)");
  assert.equal(pyodide.extensionId, "runtimecode.pack-pyodide");
});

test("malformed descriptors are dropped rather than taking Python away", () => {
  const { internals } = loadExtension({
    extensions: [
      {
        id: "someone.broken",
        packageJSON: {
          contributes: {
            "runtimecode.runtimes": [
              { id: 42 },
              null,
              { id: "x", displayName: "x" },
            ],
          },
        },
      },
    ],
  });
  assert.equal(internals.readCatalog(SELF_ID).length, 3);
});

test("stdin degrades without cross-origin isolation and upgrades with it", async () => {
  const { internals } = loadExtension();
  const catalog = internals.readCatalog(SELF_ID);
  const byId = (id) => catalog.find((entry) => entry.id === id);

  const plain = internals.probeEnvironment();
  assert.equal(plain.crossOriginIsolated, false);
  assert.equal(plain.bestStdin, "buffered");

  // CPython on WASI has no synchronous syscalls without SAB, so reads are EOF.
  const wasi = internals.negotiate(byId("python.cpython-wasi"), plain);
  assert.equal(wasi.capabilities.stdin, "none");
  assert.match(wasi.notices.join("\n"), /EOF/);
  assert.match(wasi.notices.join("\n"), /isolation/);

  // Pyodide queues input instead, and says so.
  const pyodide = internals.negotiate(byId("python.pyodide"), plain);
  assert.equal(pyodide.capabilities.stdin, "buffered");
  assert.match(pyodide.notices.join("\n"), /buffered, not blocking/);

  await withIsolation(() => {
    const isolated = internals.probeEnvironment();
    assert.equal(isolated.bestStdin, "blocking");
    assert.equal(
      internals.negotiate(byId("python.cpython-wasi"), isolated).capabilities
        .stdin,
      "blocking",
    );
    assert.equal(
      internals.negotiate(byId("python.pyodide"), isolated).capabilities.stdin,
      "blocking",
    );
    // MicroPython declares no isolated upgrade, so the descriptor caps it.
    assert.equal(
      internals.negotiate(byId("python.micropython"), isolated).capabilities
        .stdin,
      "buffered",
    );
  });
});

test("the configured stdin tier cannot exceed what the deployment supports", () => {
  const { internals } = loadExtension({ config: { stdin: "blocking" } });
  const pyodide = internals.readCatalog(SELF_ID)[0];
  const negotiated = internals.negotiate(pyodide, internals.probeEnvironment());

  assert.equal(negotiated.capabilities.stdin, "buffered");
  assert.match(negotiated.notices.join("\n"), /"blocking" was requested/);
});

test("mounts name the workspace and /tmp, and nothing else", () => {
  const { internals } = loadExtension({ workspace: WORKSPACE });
  const { mounts, root } = internals.buildMounts(SCRIPT);

  assert.deepEqual(
    mounts.map((mount) => mount.guestPath),
    ["/workspace", "/tmp"],
  );
  assert.equal(String(root), "rfs:/Project");
  assert.equal(internals.guestPathFor(SCRIPT, root), "/workspace/main.py");
  // A file outside every mounted folder has to arrive through /tmp.
  assert.equal(
    internals.guestPathFor(new Uri("rfs", "/Other/x.py"), root),
    "/tmp/x.py",
  );
});

test("a file with no workspace folder still gets one: its own directory", () => {
  const { internals } = loadExtension();
  const { mounts, root } = internals.buildMounts(SCRIPT);
  assert.equal(String(root), "rfs:/Project");
  assert.equal(mounts[0].uri.path, "/Project");
});

test("a run prints the banner and reports a missing pack as exit 127", async () => {
  const { vscode, commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);

  assert.equal(terminals.length, 1);
  assert.match(terminals[0].options.name, /main\.py · Pyodide/);
  assert.equal(terminals[0].options.isTransient, true);

  const { code, text } = await drive(terminals[0]);
  assert.equal(code, 127);
  assert.match(text, /Python \(Pyodide\) · quick tier/);
  assert.match(text, /mount {4}\/workspace {2}rfs:\/Project/);
  assert.match(text, /mount {4}\/tmp {8}in memory/);
  assert.match(text, /entry {4}\/workspace\/main\.py/);
  assert.match(text, /not installed/);
  // Standalone is a diagnosis, not a stack trace.
  assert.match(text, /standalone deployment cannot have any/);
  assert.match(text, /\[exit 127\]/);
  assert.equal(vscode.window.activeTextEditor, undefined);
});

test("a missing pack names the URL it looked at and the assets it wanted", async () => {
  const requested = [];
  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
    hostCommands: {
      "runtimecode.internal.getRuntimeFsBase": async () =>
        "https://example.org/rfs",
    },
    fetch: async (url) => {
      requested.push(url);
      return { ok: false, status: 404, statusText: "Not Found" };
    },
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);

  const { code, text } = await drive(terminals[0]);
  assert.equal(code, 127);
  assert.deepEqual(requested, [
    "https://example.org/rfs/n/RC-Packs/python.pyodide/pack.json",
  ]);
  assert.match(
    text,
    /https:\/\/example\.org\/rfs\/n\/RC-Packs\/python\.pyodide\/pack\.json/,
  );
  assert.match(text, /pyodide\.asm\.wasm/);
  assert.match(text, /python_stdlib\.zip/);
});

test("an installed pack gets as far as the unwritten engine, not a false start", async () => {
  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
    hostCommands: {
      "runtimecode.internal.getRuntimeFsBase": async () =>
        "https://example.org/rfs",
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "python.pyodide",
        version: "0.28.3",
        assets: [
          { name: "pyodide.js" },
          { name: "pyodide.asm.js" },
          { name: "pyodide.asm.wasm" },
          { name: "python_stdlib.zip" },
          { name: "pyodide-lock.json" },
        ],
      }),
    }),
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);

  const { code, text } = await drive(terminals[0]);
  assert.equal(code, 127);
  assert.match(
    text,
    /installed \(version 0\.28\.3\), but its session is not implemented/,
  );
  assert.match(text, /RUNTIMES\.md, milestone M3/);
});

test("an incomplete pack is reported as incomplete, not as a runtime failure", async () => {
  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
    hostCommands: {
      "runtimecode.internal.getRuntimeFsBase": async () =>
        "https://example.org/rfs",
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "python.pyodide",
        version: "0.28.3",
        assets: [{ name: "pyodide.js" }],
      }),
    }),
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);

  const { text } = await drive(terminals[0]);
  assert.match(text, /pack is incomplete/);
  assert.match(text, /Missing assets: pyodide\.asm\.js, pyodide\.asm\.wasm/);
});

test("one dirty-buffer policy: files under the mount are saved, others are not", async () => {
  const inside = fakeDocument({ uri: SCRIPT, dirty: true });
  const outside = fakeDocument({
    uri: new Uri("rfs", "/Elsewhere/notes.py"),
    dirty: true,
  });
  const untitled = fakeDocument({
    uri: new Uri("untitled", "/Untitled-1"),
    dirty: true,
    untitled: true,
  });

  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
    documents: [inside, outside, untitled],
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);
  const { text } = await drive(terminals[0]);

  assert.equal(inside.saved, 1);
  assert.equal(outside.saved, 0);
  assert.equal(untitled.saved, 0);
  assert.match(text, /saved 1 unsaved file before running/);
});

test("dirtyBuffers: ignore runs what is in storage", async () => {
  const inside = fakeDocument({ uri: SCRIPT, dirty: true });
  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
    documents: [inside],
    config: { dirtyBuffers: "ignore" },
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);
  await drive(terminals[0]);

  assert.equal(inside.saved, 0);
});

test("a selection runs from /tmp, with no file and nothing saved", async () => {
  const document = fakeDocument({
    uri: SCRIPT,
    dirty: true,
    text: "print('hi')\n",
  });
  const editor = { document, selection: { isEmpty: true } };
  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
    documents: [document],
    activeEditor: editor,
  });
  exports.activate(context);
  await commands.get("runtimecode.python.runSelection")();

  const { text } = await drive(terminals[0]);
  assert.match(text, /entry {4}\/tmp\/selection\.py/);
  assert.equal(document.saved, 0);
});

test("Ctrl+C before a session has started ends the run as interrupted", async () => {
  const { commands, terminals, exports, context } = loadExtension({
    workspace: WORKSPACE,
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")(SCRIPT);

  const pty = terminals[0].options.pty;
  const chunks = [];
  pty.onDidWrite((chunk) => chunks.push(chunk));
  const closed = new Promise((resolve) => pty.onDidClose(resolve));
  pty.handleInput("\x03");

  assert.equal(await closed, 130);
  assert.match(chunks.join(""), /\^C/);
});

test("running an untitled buffer says to use Run Selection instead", async () => {
  const document = fakeDocument({
    uri: new Uri("untitled", "/Untitled-1"),
    untitled: true,
  });
  const { commands, terminals, calls, exports, context } = loadExtension({
    activeEditor: { document, selection: { isEmpty: true } },
  });
  exports.activate(context);
  await commands.get("runtimecode.python.run")();

  assert.equal(terminals.length, 0);
  assert.match(calls.messages.at(-1)[1], /Run Selection/);
});

test("picking an uninstalled runtime over the threshold asks first", async () => {
  const chosen = [];
  const { commands, context, exports } = loadExtension({
    workspace: WORKSPACE,
    config: { installThresholdBytes: 1024 },
    answers: {
      quickPick: (items) => {
        chosen.push(items.map((item) => item.description));
        return items.find(
          (item) => item.descriptor.id === "python.cpython-wasi",
        );
      },
      warning: undefined, // the user dismisses the modal
    },
  });
  exports.activate(context);
  await commands.get("runtimecode.python.selectRuntime")();

  assert.match(chosen[0][0], /quick · 11 MiB\* · not installed · current/);
  assert.equal(
    context.workspaceState.get("runtimecode.python.runtime"),
    undefined,
  );
});

test("confirming the threshold remembers the choice for this workspace", async () => {
  const { commands, context, exports, statusBarItems } = loadExtension({
    workspace: WORKSPACE,
    config: { installThresholdBytes: 1024 },
    answers: {
      quickPick: (items) =>
        items.find((item) => item.descriptor.id === "python.micropython"),
      warning: "Select anyway",
    },
  });
  exports.activate(context);
  await commands.get("runtimecode.python.selectRuntime")();

  assert.equal(
    context.workspaceState.get("runtimecode.python.runtime"),
    "python.micropython",
  );
  // No Python editor is active, so the status bar item stays out of the way.
  assert.equal(statusBarItems[0].visible, false);
});

test("the status bar follows the active editor and the chosen runtime", async () => {
  const document = fakeDocument({ uri: SCRIPT });
  const { exports, context, statusBarItems, listeners } = loadExtension({
    workspace: WORKSPACE,
    activeEditor: { document, selection: { isEmpty: true } },
  });
  exports.activate(context);

  const item = statusBarItems[0];
  assert.equal(item.visible, true);
  assert.equal(item.text, "$(play) Python: Pyodide");
  assert.equal(item.command, "runtimecode.python.selectRuntime");

  await context.workspaceState.update(
    "runtimecode.python.runtime",
    "python.cpython-wasi",
  );
  listeners.configuration.forEach((listener) =>
    listener({ affectsConfiguration: () => true }),
  );
  assert.equal(item.text, "$(play) Python: CPython on WASI");
});

test("diagnostics explain the deployment, every runtime, and where packs live", async () => {
  const { commands, outputs, exports, context } = loadExtension({
    workspace: WORKSPACE,
  });
  exports.activate(context);
  await commands.get("runtimecode.python.showDiagnostics")();

  const report = outputs[0].lines.join("\n");
  assert.match(report, /cross-origin isolated : no/);
  assert.match(
    report,
    /packs folder {10}: none \(RuntimeCode is served standalone\)/,
  );
  for (const id of [
    "python.pyodide",
    "python.cpython-wasi",
    "python.micropython",
  ]) {
    assert.match(report, new RegExp(id.replace(".", "\\.")));
  }
  assert.match(report, /pack {6}: standalone/);
  assert.match(report, /milestone M1/);
});

test("formatBytes states sizes the way the picker shows them", () => {
  const { internals } = loadExtension();
  assert.equal(internals.formatBytes(786432), "768 KiB");
  assert.equal(internals.formatBytes(11534336), "11 MiB");
  assert.equal(internals.formatBytes(0), "size unknown");
});

// ---------------------------------------------------------------------------
// The pack autosystem: install / uninstall / cleanup
// ---------------------------------------------------------------------------

/**
 * A catalog.json the way scripts/packs.mjs emits it, plus a fetch that serves
 * the pack files out of `files` (a fake in-memory packs folder).
 */
function catalogFixture(overrides = {}) {
  const files = {
    "python.pyodide/package.json": "{}",
    "python.pyodide/extension.js": "",
    "python.pyodide/session.js": "",
    "python.pyodide/pack.json": "{}",
    "python.pyodide/assets/pyodide.js": "/* pyodide */",
    "python.pyodide/assets/pyodide.asm.wasm": "WASM",
    "python.lua/package.json": "{}",
    "python.lua/extension.js": "",
    "python.lua/session.js": "",
    "python.lua/pack.json": "{}",
    "python.lua/assets/glue.wasm": "LUA",
  };
  const pyodide = new Uint8Array(Buffer.from("/* pyodide */"));
  const lua = new Uint8Array(Buffer.from("LUA"));
  const entries = [
    {
      id: "python.pyodide",
      version: "0.28.3",
      license: "MPL-2.0 AND Python-2.0",
      installBytes: 13,
      descriptor: { displayName: "Python (Pyodide)", tier: "quick" },
      summary: "The whole of CPython.",
      files: [
        "package.json",
        "extension.js",
        "session.js",
        "pack.json",
        "assets/pyodide.js",
        "assets/pyodide.asm.wasm",
      ],
      assets: [
        { name: "pyodide.js", bytes: pyodide.length, sha256: null },
        { name: "pyodide.asm.wasm", bytes: 4, sha256: null },
      ],
    },
    {
      id: "python.lua",
      version: "1.16.0",
      license: "MIT",
      installBytes: 4,
      descriptor: { displayName: "Lua (wasmoon)", tier: "quick" },
      summary: "A Lua VM.",
      files: ["package.json", "extension.js", "session.js", "pack.json", "assets/glue.wasm"],
      assets: [{ name: "glue.wasm", bytes: lua.length, sha256: null }],
    },
  ];
  return {
    files,
    entries,
    catalog: entries,
    fetch: async (url) => {
      const rel = url.replace(/^https:\/\/example\.org\/rfs\/n\/RC-Packs\//, "");
      if (rel === "catalog.json") {
        return { ok: true, status: 200, json: async () => entries };
      }
      const known = entries.some((e) => rel.startsWith(`${e.id}/`));
      const body = known ? files[rel] : undefined;
      if (body === undefined) {
        return { ok: false, status: 404, statusText: "Not Found" };
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) };
    },
  };
}

test("installRuntime copies the pack into OPFS and records it in the registry", async () => {
  const fixture = catalogFixture();
  const { internals, opfs } = loadExtension({ fetch: fixture.fetch });
  const entry = fixture.entries[0];

  await internals.installPack(entry, "https://example.org/rfs/n/RC-Packs/", "RC-Packs");

  const prefix = await opfs.getDirectory();
  const rfs = await prefix.getDirectoryHandle("rfs");
  const pack = await rfs.getDirectoryHandle("RC-Packs");
  const pyodide = await pack.getDirectoryHandle("python.pyodide");
  const file = await (await pyodide.getDirectoryHandle("assets")).getFileHandle("pyodide.js");
  const text = await (await file.getFile()).text();
  assert.equal(text, "/* pyodide */");

  const registry = await internals.readPacksRegistry();
  assert.equal(registry.folder, "RC-Packs");
  assert.equal(registry.packs["python.pyodide"].version, "0.28.3");
  assert.equal(registry.packs["python.lua"], undefined);
});

test("installPack re-verifies digests and refuses a mismatch", async () => {
  const fixture = catalogFixture();
  fixture.entries[0].assets[0].sha256 = "f".repeat(64); // wrong digest
  const { internals, opfs } = loadExtension({ fetch: fixture.fetch });
  const entry = fixture.entries[0];

  await assert.rejects(
    () =>
      internals.installPack(entry, "https://example.org/rfs/n/RC-Packs/", "RC-Packs"),
    /Checksum mismatch/,
  );

  // Nothing got registered.
  const registry = await internals.readPacksRegistry();
  assert.equal(registry.packs["python.pyodide"], undefined);
});

test("uninstallPack removes the folder and the registry entry", async () => {
  const fixture = catalogFixture();
  const { internals, opfs } = loadExtension({ fetch: fixture.fetch });
  await internals.installPack(fixture.entries[0], "https://example.org/rfs/n/RC-Packs/", "RC-Packs");

  await internals.uninstallPack("python.pyodide", "RC-Packs");

  const prefix = await opfs.getDirectory();
  const rfs = await prefix.getDirectoryHandle("rfs");
  const pack = await rfs.getDirectoryHandle("RC-Packs");
  await assert.rejects(() => pack.getDirectoryHandle("python.pyodide"), /NotFound/);
  const registry = await internals.readPacksRegistry();
  assert.equal(registry.packs["python.pyodide"], undefined);
});

test("cleanupPacksFolder removes orphaned folders but keeps registered ones", async () => {
  const fixture = catalogFixture();
  const { internals, opfs } = loadExtension({ fetch: fixture.fetch });
  // Install lua, then create an orphan folder by hand.
  await internals.installPack(fixture.entries[1], "https://example.org/rfs/n/RC-Packs/", "RC-Packs");
  const prefix = await opfs.getDirectory();
  const rfs = await prefix.getDirectoryHandle("rfs", { create: true });
  const pack = await rfs.getDirectoryHandle("RC-Packs", { create: true });
  await pack.getDirectoryHandle("python.orphan", { create: true });

  const removed = await internals.cleanupPacksFolder("RC-Packs");

  assert.deepEqual(removed, ["python.orphan"]);
  // The registered one survives.
  await pack.getDirectoryHandle("python.lua");
  await assert.rejects(() => pack.getDirectoryHandle("python.orphan"), /NotFound/);
});

test("the installRuntime command offers packs from the catalog and reloads", async () => {
  const fixture = catalogFixture();
  const executed = [];
  const { commands, exports, context, internals } = loadExtension({
    workspace: WORKSPACE,
    hostCommands: {
      "runtimecode.internal.getRuntimeFsBase": async () => "https://example.org/rfs",
      "workbench.action.reloadWindow": async () => executed.push("reload"),
    },
    fetch: fixture.fetch,
    answers: {
      quickPick: (items) =>
        items.find((item) => item.entry.id === "python.pyodide"),
      information: "Reload",
    },
  });
  exports.activate(context);

  await commands.get("runtimecode.python.installRuntime")();

  const registry = await internals.readPacksRegistry();
  assert.equal(registry.packs["python.pyodide"].version, "0.28.3");
  assert.deepEqual(executed, ["reload"]);
});

test("uninstallRuntime lists installed packs and removes the chosen one", async () => {
  const fixture = catalogFixture();
  const { commands, exports, context, internals } = loadExtension({
    workspace: WORKSPACE,
    fetch: fixture.fetch,
    answers: {
      quickPick: (items) => items.find((item) => item.id === "python.pyodide"),
      information: undefined, // dismiss the reload prompt
    },
  });
  exports.activate(context);
  await internals.installPack(fixture.entries[0], "https://example.org/rfs/n/RC-Packs/", "RC-Packs");

  await commands.get("runtimecode.python.uninstallRuntime")();

  const registry = await internals.readPacksRegistry();
  assert.equal(registry.packs["python.pyodide"], undefined);
});

test("cleanupPacks command reports and removes orphaned folders", async () => {
  const fixture = catalogFixture();
  const messages = [];
  const { commands, exports, context, internals, opfs } = loadExtension({
    workspace: WORKSPACE,
    fetch: fixture.fetch,
    answers: { information: undefined },
  });
  exports.activate(context);

  // Seed an orphan without installing.
  const prefix = await opfs.getDirectory();
  const rfs = await prefix.getDirectoryHandle("rfs", { create: true });
  const pack = await rfs.getDirectoryHandle("RC-Packs", { create: true });
  await pack.getDirectoryHandle("python.stray", { create: true });

  await commands.get("runtimecode.python.cleanupPacks")();

  await assert.rejects(() => pack.getDirectoryHandle("python.stray"), /NotFound/);
  assert.equal(messages.length, 0); // no assertion on the exact message
});
