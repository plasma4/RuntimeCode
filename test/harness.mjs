/**
 * Loads extensions/runtimefs/extension.js the way the web extension host loads
 * it: one CommonJS source string, wrapped in `new Function`, with `require`
 * resolving nothing but 'vscode' (extHostExtensionService.ts:87 and :109).
 *
 * Running the real loader is the point. A test that imported the file as a
 * module would pass on code the browser refuses, which is the only failure mode
 * that matters for an unbundled web extension.
 *
 * The browser globals the extension touches (navigator, setTimeout) are passed
 * as extra parameters rather than assigned onto globalThis, so the fakes are
 * scoped to the loaded extension and cannot leak between tests.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_EXTENSION_DIR = path.join(RC_ROOT, "extensions", "runtimefs");

export const MANIFEST = JSON.parse(
  readFileSync(path.join(DEFAULT_EXTENSION_DIR, "package.json"), "utf8"),
);

/** The manifest of any extension, for tests that read contributed fields. */
export function readManifest(extensionDir) {
  return JSON.parse(
    readFileSync(path.join(RC_ROOT, "extensions", extensionDir, "package.json"), "utf8"),
  );
}

/**
 * Internals the tests reach for. The epilogue runs inside the extension's own
 * function scope, so a rename upstream in the file fails loudly here instead of
 * silently testing nothing.
 */
const INTERNALS = [
  "parseUri",
  "toFileSystemError",
  "errorName",
  "isPreviewable",
  "previewUrlFor",
  "previewWrapperUrl",
  "hasSameOriginHeaders",
  "setSameOriginHeaders",
  "readRegistry",
  "updateRegistryEntry",
  "listFolders",
  "folderNameProblem",
  "escapeHtml",
  "RuntimeFSProvider",
];

// ---------------------------------------------------------------------------
// Fake OPFS
// ---------------------------------------------------------------------------

function domError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

class FakeFileHandle {
  kind = "file";

  constructor(name, store) {
    this.name = name;
    this._store = store; // { data: Uint8Array, lastModified: number }
  }

  async getFile() {
    const { data, lastModified } = this._store;
    return {
      size: data.byteLength,
      lastModified,
      async arrayBuffer() {
        return data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        );
      },
      async text() {
        return Buffer.from(data).toString("utf8");
      },
    };
  }

  async createWritable() {
    const chunks = [];
    const store = this._store;
    return {
      async write(chunk) {
        chunks.push(
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf8")
            : Buffer.from(chunk),
        );
      },
      async close() {
        store.data = new Uint8Array(Buffer.concat(chunks));
        store.lastModified = Date.now();
      },
    };
  }
}

class FakeDirectoryHandle {
  kind = "directory";

  constructor(name = "") {
    this.name = name;
    this._children = new Map(); // name -> FakeDirectoryHandle | { data, lastModified }
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this._children.get(name);
    if (existing instanceof FakeDirectoryHandle) {
      return existing;
    }
    if (existing) {
      throw domError("TypeMismatchError", `${name} is a file`);
    }
    if (!options.create) {
      throw domError("NotFoundError", `${name} not found`);
    }

    const created = new FakeDirectoryHandle(name);
    this._children.set(name, created);
    return created;
  }

  async getFileHandle(name, options = {}) {
    const existing = this._children.get(name);
    if (existing instanceof FakeDirectoryHandle) {
      throw domError("TypeMismatchError", `${name} is a directory`);
    }
    if (existing) {
      return new FakeFileHandle(name, existing);
    }
    if (!options.create) {
      throw domError("NotFoundError", `${name} not found`);
    }

    const store = { data: new Uint8Array(), lastModified: Date.now() };
    this._children.set(name, store);
    return new FakeFileHandle(name, store);
  }

  async removeEntry(name, options = {}) {
    const existing = this._children.get(name);
    if (!existing) {
      throw domError("NotFoundError", `${name} not found`);
    }
    if (
      existing instanceof FakeDirectoryHandle &&
      existing._children.size &&
      !options.recursive
    ) {
      throw domError("InvalidModificationError", `${name} is not empty`);
    }
    this._children.delete(name);
  }

  async *entries() {
    for (const [name, value] of [...this._children]) {
      yield [
        name,
        value instanceof FakeDirectoryHandle
          ? value
          : new FakeFileHandle(name, value),
      ];
    }
  }
}

/** Walks or builds `rfs/<Folder>/<path>` so a test can arrange a tree in one line. */
export async function seed(root, files) {
  for (const [filePath, contents] of Object.entries(files)) {
    const parts = filePath.split("/").filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const last = parts[parts.length - 1];
    if (contents === null) {
      await dir.getDirectoryHandle(last, { create: true });
      continue;
    }
    const writable = await (
      await dir.getFileHandle(last, { create: true })
    ).createWritable();
    await writable.write(contents);
    await writable.close();
  }
  return root;
}

// ---------------------------------------------------------------------------
// Fake vscode
// ---------------------------------------------------------------------------

class Uri {
  constructor(scheme, uriPath) {
    this.scheme = scheme;
    this.path = uriPath;
  }

  static from({ scheme, path: uriPath }) {
    return new Uri(scheme, uriPath);
  }

  static parse(value) {
    const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value);
    if (!match) {
      throw new Error(`not a uri: ${value}`);
    }
    return new Uri(match[1], match[2]);
  }

  static file(value) {
    return new Uri("file", value.startsWith("/") ? value : `/${value}`);
  }

  static joinPath(base, ...parts) {
    const segments = [
      base.path.replace(/\/+$/, ""),
      ...parts.map((part) => String(part).replace(/^\/+/, "")),
    ];
    return new Uri(base.scheme, segments.join("/"));
  }

  with(change) {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
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
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };
  }

  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose() {
    this.listeners = [];
  }
}

/**
 * Enough of QuickPick to drive the folder picker. The real one filters `items`
 * by `value` and keeps `alwaysShow` entries regardless; this does not filter at
 * all, because what the tests care about is which items were offered and what
 * accepting one does. `type()` and `accept()` are the test-side handles.
 */
function fakeQuickPick() {
  const handlers = { accept: [], change: [], hide: [] };
  const on = (kind) => (listener) => {
    handlers[kind].push(listener);
    return { dispose() {} };
  };

  const picker = {
    title: "",
    placeholder: "",
    value: "",
    items: [],
    selectedItems: [],
    shown: false,
    disposed: false,
    onDidAccept: on("accept"),
    onDidChangeValue: on("change"),
    onDidHide: on("hide"),
    show() {
      picker.shown = true;
    },
    hide() {
      picker.shown = false;
      for (const listener of [...handlers.hide]) {
        listener();
      }
    },
    dispose() {
      picker.disposed = true;
    },

    /** Types into the filter box, as a user would. */
    type(value) {
      picker.value = value;
      for (const listener of [...handlers.change]) {
        listener(value);
      }
    },
    /** Accepts an item, or whatever is currently selected. */
    accept(item) {
      if (item !== undefined) {
        picker.selectedItems = [item];
      }
      for (const listener of [...handlers.accept]) {
        listener();
      }
    },
    /** The item whose label starts with the create codicon. */
    get createItem() {
      return picker.items.find((item) =>
        item.label.startsWith("$(new-folder)"),
      );
    },
  };
  return picker;
}

function fsError(code) {
  return (uriOrMessage) => {
    const error = new Error(String(uriOrMessage));
    error.code = code;
    error.name = code;
    return error;
  };
}

/**
 * @param {object} options
 * @param {Record<string, Function>} [options.hostCommands] embedder commands the
 *   bootstrap registers in static/index.html, which the extension can only reach
 *   through executeCommand.
 * @param {Record<string, unknown>} [options.answers] canned replies, keyed by the
 *   window API that asks the question.
 */
export function createVscodeStub({ hostCommands = {}, answers = {} } = {}) {
  const calls = {
    executed: [],
    messages: [],
    locks: [],
    configUpdates: [],
    terminals: [],
  };
  const quickPicks = [];
  const statusItems = [];
  const outputChannels = [];
  const commands = new Map();
  const configuration = new Map();
  const listeners = { configuration: [], save: [], extensions: [] };
  // A mutable box rather than a getter, so tests can destructure the result
  // before activate() has run and still see the registration afterwards.
  const registered = { fileSystemProvider: undefined };

  const vscode = {
    Uri,
    EventEmitter: FakeEventEmitter,
    Disposable: class Disposable {
      constructor(fn) {
        this.dispose = fn ?? (() => {});
      }
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    FileSystemError: {
      FileNotFound: fsError("FileNotFound"),
      FileExists: fsError("FileExists"),
      FileNotADirectory: fsError("FileNotADirectory"),
      FileIsADirectory: fsError("FileIsADirectory"),
      NoPermissions: fsError("NoPermissions"),
    },

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
      activeTextEditor: undefined,
      async showInformationMessage(message) {
        calls.messages.push(["info", message]);
        return answers.information;
      },
      async showWarningMessage(message, ...actions) {
        calls.messages.push(["warning", message, ...actions]);
        return answers.warning;
      },
      async showErrorMessage(message) {
        calls.messages.push(["error", message]);
        return answers.error;
      },
      async showQuickPick(items, options) {
        calls.messages.push(["quickPick", items, options]);
        return answers.quickPick;
      },
      async showInputBox(options) {
        calls.messages.push(["inputBox", options]);
        return answers.inputBox;
      },
      createQuickPick() {
        const picker = fakeQuickPick();
        quickPicks.push(picker);
        return picker;
      },
      createWebviewPanel() {
        return {
          title: "",
          webview: { html: "", onDidReceiveMessage() {}, postMessage() {} },
          onDidDispose() {},
          reveal() {},
        };
      },
      createStatusBarItem() {
        const item = {
          text: "",
          name: "",
          tooltip: "",
          command: undefined,
          visible: false,
          disposed: false,
          show() {
            item.visible = true;
          },
          hide() {
            item.visible = false;
          },
          dispose() {
            item.disposed = true;
          },
        };
        statusItems.push(item);
        return item;
      },
      createOutputChannel(name) {
        const channel = {
          name,
          lines: [],
          shown: false,
          disposed: false,
          append(text) {
            channel.lines.push(...String(text).split("\n").filter(Boolean));
          },
          appendLine(text) {
            channel.lines.push(String(text));
          },
          show() {
            channel.shown = true;
          },
          hide() {},
          clear() {
            channel.lines = [];
          },
          dispose() {
            channel.disposed = true;
          },
        };
        outputChannels.push(channel);
        return channel;
      },
      /**
       * Records the terminal so a test can drive its pty. `open()` is not called
       * here: VS Code calls it after the terminal is shown, and a test that
       * wants output has to call it the same way.
       */
      createTerminal(options) {
        const terminal = {
          name: options?.name ?? "",
          options,
          shown: false,
          disposed: false,
          exitStatus: undefined,
          show() {
            terminal.shown = true;
          },
          hide() {},
          sendText() {},
          dispose() {
            terminal.disposed = true;
            options?.pty?.close?.(undefined);
          },
        };
        calls.terminals.push(terminal);
        return terminal;
      },
    },

    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      /**
       * Reads fail by default, the way a real workspace does when a file is
       * missing. A test that wants a runnable entry replaces readFile.
       */
      fs: {
        async readFile(uri) {
          throw fsError("FileNotFound")(uri?.toString?.() ?? "file");
        },
      },
      registerFileSystemProvider(scheme, provider) {
        registered.fileSystemProvider = { scheme, provider };
        return { dispose() {} };
      },
      getConfiguration(section) {
        return {
          get: (key, fallback) =>
            configuration.has(`${section}.${key}`)
              ? configuration.get(`${section}.${key}`)
              : fallback,
          update: async (key, value) => {
            configuration.set(`${section}.${key}`, value);
            calls.configUpdates.push([`${section}.${key}`, value]);
          },
        };
      },
      onDidChangeConfiguration(listener) {
        listeners.configuration.push(listener);
        return { dispose() {} };
      },
      onDidSaveTextDocument(listener) {
        listeners.save.push(listener);
        return { dispose() {} };
      },
      async saveAll() {
        return true;
      },
    },

    /**
     * The host registry reads `all` on activation and `getExtension()` only
     * when a runtime is chosen. A test pack is any object in `all` with an
     * `activate()`; `packageJSON.contributes` is what the registry scans.
     */
    extensions: {
      all: [],
      getExtension(id) {
        return vscode.extensions.all.find((extension) => extension.id === id);
      },
      onDidChange(listener) {
        listeners.extensions.push(listener);
        return { dispose() {} };
      },
    },
  };

  return {
    vscode,
    calls,
    commands,
    configuration,
    listeners,
    quickPicks,
    registered,
    statusItems,
    outputChannels,
  };
}

// ---------------------------------------------------------------------------

/**
 * Loads an extension against fresh fakes and returns everything a test needs.
 *
 * `extensionDir` names a folder under extensions/ and `internals` is the list
 * of names the test-side epilogue exposes; both default to the RuntimeFS
 * extension, which is what most tests load.
 *
 * `crossOriginIsolated` is passed as a function parameter rather than assigned
 * onto globalThis, for the same reason as `navigator`: it has to be scoped to
 * the loaded extension. Node has no such global, so without this the host would
 * always report false. `fetch` is the same arrangement, and a test that wants
 * to serve extension assets from disk replaces it.
 *
 * @param {object} [options]
 * @param {string} [options.extensionDir] folder name under extensions/
 * @param {string[]} [options.internals] names to expose as __internals
 * @param {boolean} [options.crossOriginIsolated]
 * @param {typeof fetch} [options.fetch]
 */
export function loadExtension(options = {}) {
  const {
    extensionDir = "runtimefs",
    internals = INTERNALS,
    crossOriginIsolated = false,
    fetch: fetchImpl = globalThis.fetch,
    ...stubOptions
  } = options;
  const stub = createVscodeStub(stubOptions);
  const opfs = new FakeDirectoryHandle();

  const navigator = {
    storage: { getDirectory: async () => opfs },
    locks: {
      async request(name, optionsOrFn, maybeFn) {
        stub.calls.locks.push(name);
        return (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn)();
      },
    },
  };

  const extensionPath = path.join(RC_ROOT, "extensions", extensionDir, "extension.js");
  const source = readFileSync(extensionPath, "utf8");
  const epilogue = `\n;module.exports.__internals = { ${internals.join(", ")} };\n`;
  const factory = new Function(
    "module",
    "exports",
    "require",
    "navigator",
    "setTimeout",
    "clearTimeout",
    "crossOriginIsolated",
    "fetch",
    source + epilogue,
  );

  const requested = [];
  const module = { exports: {} };
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
    navigator,
    setTimeout,
    clearTimeout,
    crossOriginIsolated,
    fetchImpl,
  );

  return {
    ...stub,
    opfs,
    exports: module.exports,
    internals: module.exports.__internals,
    requested,
  };
}

/** A fake ExtensionContext with the two mementos and a subscriptions array. */
export function fakeContext(initial = {}) {
  const state = { global: new Map(Object.entries(initial.global ?? {})) };
  const memento = (map) => ({
    get(key, fallback) {
      return map.has(key) ? map.get(key) : fallback;
    },
    async update(key, value) {
      map.set(key, value);
    },
    keys() {
      return [...map.keys()];
    },
  });
  return {
    subscriptions: [],
    globalState: memento(state.global),
    workspaceState: memento(new Map()),
    extensionUri: {
      scheme: "file",
      path: "/extensions/runtime-host",
      toString: () => "file:/extensions/runtime-host",
    },
    asAbsolutePath: (relative) => `/extensions/runtime-host/${relative}`,
  };
}

/** A fake TextDocument with just what the host reads. */
export function fakeDocument(uriString, { languageId = "plaintext", text = "", isDirty = false } = {}) {
  return {
    uri: { scheme: uriString.split(":")[0], path: uriString.replace(/^[^:]*:/, ""), toString: () => uriString },
    languageId,
    isDirty,
    fileName: uriString,
    getText: () => text,
  };
}

/** Test-side mirror of the rfs: mapping, for arranging fixtures. */
export async function rfsFolder(opfs, name, files = {}) {
  const rfs = await opfs.getDirectoryHandle("rfs", { create: true });
  return seed(await rfs.getDirectoryHandle(name, { create: true }), files);
}

/** `_fireSoon` coalesces on a 5ms timer. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
