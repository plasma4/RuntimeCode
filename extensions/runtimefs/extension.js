/*---------------------------------------------------------------------------------------------
 *  RuntimeCode: RuntimeFS integration
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

// Loaded by the web extension host as CommonJS (extHostExtensionService.ts wraps
// the source in `new Function('module','exports','require', ...)`), so this file
// is deliberately dependency-free and unbundled.

const vscode = require("vscode");

/** Must match rfs.js: `const RFS_PREFIX = "rfs"` and `const SYSTEM_FILE = "rfs_system.json"`. */
const RFS_PREFIX = "rfs";
const SYSTEM_FILE = "rfs_system.json";
const SCHEME = "rfs";

/**
 * One folder's entry in rfs_system.json. RuntimeFS owns the shape. We only
 * ever merge into it, never rewrite it wholesale.
 *
 * @typedef {object} RegistryEntry
 * @property {string | null} [encryptionType]
 * @property {string} [headers] Custom Headers, one `* -> Name: value` per line.
 * @property {number} [lastModified]
 *
 * @typedef {Record<string, RegistryEntry>} Registry
 */

// ---------------------------------------------------------------------------
// OPFS helpers
// ---------------------------------------------------------------------------

async function opfsRoot() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new Error(
      "This browser does not support OPFS, which RuntimeFS requires.",
    );
  }
  return navigator.storage.getDirectory();
}

async function rfsRoot(create = false) {
  return (await opfsRoot()).getDirectoryHandle(RFS_PREFIX, { create });
}

/**
 * The name of a thrown DOMException, or undefined for anything else.
 * Duck-typed rather than `instanceof Error`, because what OPFS rejects with is
 * only guaranteed to carry a name.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errorName(err) {
  if (typeof err !== "object" || err === null || !("name" in err)) {
    return undefined;
  }
  const { name } = err;
  return typeof name === "string" ? name : undefined;
}

/**
 * `rfs:/<Folder>/a/b.txt` -> { folder: '<Folder>', parts: ['a','b.txt'] }.
 * The workspace root is `rfs:/<Folder>`, so parts is empty there.
 *
 * @param {vscode.Uri} uri
 * @returns {{ folder: string, parts: string[] }}
 */
function parseUri(uri) {
  const segments = uri.path.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 0) {
    throw vscode.FileSystemError.FileNotFound(uri);
  }
  return { folder: segments[0], parts: segments.slice(1) };
}

/**
 * Maps OPFS/DOM errors onto the FileSystemError values VS Code expects.
 *
 * @param {unknown} err
 * @param {vscode.Uri} uri
 * @returns {Error}
 */
function toFileSystemError(err, uri) {
  const name = errorName(err);
  if (name === "NotFoundError") {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (name === "TypeMismatchError") {
    return vscode.FileSystemError.FileNotADirectory(uri);
  }
  if (name === "InvalidModificationError") {
    return vscode.FileSystemError.FileExists(uri);
  }
  if (name === "NoModificationAllowedError" || name === "NotAllowedError") {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * @param {vscode.Uri} uri
 * @param {{ create?: boolean, depth?: number }} [options] `depth` stops that
 *   many segments short of the full path, which is how the parent directory of
 *   a file is reached.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function directoryHandleFor(uri, { create = false, depth = 0 } = {}) {
  const { folder, parts } = parseUri(uri);
  const root = await rfsRoot(create);
  let dir = await root.getDirectoryHandle(folder, { create });
  const upto = parts.length - depth;
  for (let i = 0; i < upto; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create });
  }
  return dir;
}

/**
 * @param {vscode.Uri} uri
 * @param {boolean} [create]
 * @returns {Promise<FileSystemFileHandle>}
 */
async function fileHandleFor(uri, create = false) {
  const { parts } = parseUri(uri);
  if (parts.length === 0) {
    throw vscode.FileSystemError.FileIsADirectory(uri);
  }
  const dir = await directoryHandleFor(uri, { create, depth: 1 });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

// ---------------------------------------------------------------------------
// RuntimeFS registry + service worker coordination
// ---------------------------------------------------------------------------

/**
 * Mirrors updateRegistryEntry() in rfs.js, including its lock name, so the
 * RuntimeFS UI and RuntimeCode cannot corrupt rfs_system.json by writing at the
 * same time. Passing `data === null` deletes the entry.
 *
 * @param {string} name
 * @param {RegistryEntry | null} data
 */
async function updateRegistryEntry(name, data) {
  const write = async () => {
    const root = await opfsRoot();
    /** @type {Registry} */
    let registry = {};
    try {
      const handle = await root.getFileHandle(SYSTEM_FILE);
      const text = await (await handle.getFile()).text();
      registry = text ? JSON.parse(text) : {};
    } catch {
      /* first write; start empty */
    }

    if (data === null) {
      delete registry[name];
    } else {
      registry[name] = {
        ...(registry[name] || {}),
        ...data,
        lastModified: Date.now(),
      };
    }

    const handle = await root.getFileHandle(SYSTEM_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(registry));
    await writable.close();
  };

  if (navigator.locks) {
    return navigator.locks.request(
      "rfs_registry_lock",
      { mode: "exclusive" },
      write,
    );
  }
  return write();
}

/** @returns {Promise<Registry>} */
async function readRegistry() {
  try {
    const root = await opfsRoot();
    const text = await (
      await (await root.getFileHandle(SYSTEM_FILE)).getFile()
    ).text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * RuntimeFS's service worker caches responses per folder, so edits made here are
 * invisible to a preview tab until it is told to drop them. Best-effort: the
 * extension host worker has no ServiceWorkerContainer, so this is relayed
 * through the workbench via a command the bootstrap registers.
 *
 * @param {string} folder
 */
async function invalidateFolderCache(folder) {
  try {
    await vscode.commands.executeCommand(
      "runtimecode.internal.invalidateRfsCache",
      folder,
    );
  } catch {
    /* preview will simply serve stale content until reload */
  }
}

/**
 * Matches the per-folder write lock rfs.js takes in performSyncToOpfs().
 *
 * @template T
 * @param {string} folder
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withFolderLock(folder, fn) {
  if (!navigator.locks) {
    return fn();
  }
  return navigator.locks.request(`rfs_write_${folder}`, fn);
}

// ---------------------------------------------------------------------------
// FileSystemProvider
// ---------------------------------------------------------------------------

/** @implements {vscode.FileSystemProvider} */
class RuntimeFSProvider {
  constructor() {
    this._emitter =
      /** @type {vscode.EventEmitter<vscode.FileChangeEvent[]>} */ (
        new vscode.EventEmitter()
      );
    this.onDidChangeFile = this._emitter.event;
    /** @type {vscode.FileChangeEvent[]} */
    this._bufferedEvents = [];
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this._fireSoonHandle = undefined;
  }

  watch() {
    // OPFS has no change notification, and FileSystemObserver is not available
    // in a worker. Edits made through this provider are reported via _fireSoon;
    // external changes (the RuntimeFS UI, another tab) are not observed.
    return new vscode.Disposable(() => {});
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {Promise<vscode.FileStat>}
   */
  async stat(uri) {
    const { parts } = parseUri(uri);
    try {
      if (parts.length === 0) {
        await directoryHandleFor(uri);
        return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      }

      // Try file first: the common case, and cheaper than probing both.
      try {
        const file = await (await fileHandleFor(uri)).getFile();
        return {
          type: vscode.FileType.File,
          ctime: file.lastModified,
          mtime: file.lastModified,
          size: file.size,
        };
      } catch (err) {
        if (errorName(err) === "TypeMismatchError") {
          await directoryHandleFor(uri);
          return {
            type: vscode.FileType.Directory,
            ctime: 0,
            mtime: 0,
            size: 0,
          };
        }
        throw err;
      }
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {Promise<[string, vscode.FileType][]>}
   */
  async readDirectory(uri) {
    try {
      const dir = await directoryHandleFor(uri);
      /** @type {[string, vscode.FileType][]} */
      const entries = [];
      for await (const [name, handle] of dir.entries()) {
        entries.push([
          name,
          handle.kind === "directory"
            ? vscode.FileType.Directory
            : vscode.FileType.File,
        ]);
      }
      return entries;
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /** @param {vscode.Uri} uri */
  async createDirectory(uri) {
    try {
      const { folder } = parseUri(uri);
      await withFolderLock(folder, () =>
        directoryHandleFor(uri, { create: true }),
      );
      this._fireSoon({ type: vscode.FileChangeType.Created, uri });
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {Promise<Uint8Array>}
   */
  async readFile(uri) {
    try {
      const file = await (await fileHandleFor(uri)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /**
   * @param {vscode.Uri} uri
   * @param {Uint8Array} content
   * @param {{ create: boolean, overwrite: boolean }} options
   */
  async writeFile(uri, content, options) {
    const { folder } = parseUri(uri);
    try {
      let existed = true;
      try {
        await fileHandleFor(uri);
      } catch {
        existed = false;
      }

      if (!existed && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (existed && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }

      await withFolderLock(folder, async () => {
        const handle = await fileHandleFor(uri, true);
        const writable = await handle.createWritable();
        await writable.write(/** @type {BufferSource} */ (content));
        await writable.close();
      });

      this._fireSoon({
        type: existed
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Created,
        uri,
      });
      await invalidateFolderCache(folder);
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /**
   * @param {vscode.Uri} uri
   * @param {{ recursive: boolean }} options
   */
  async delete(uri, options) {
    const { folder, parts } = parseUri(uri);
    if (parts.length === 0) {
      throw vscode.FileSystemError.NoPermissions(
        "Delete the folder from the RuntimeFS UI instead.",
      );
    }
    try {
      await withFolderLock(folder, async () => {
        const parent = await directoryHandleFor(uri, { depth: 1 });
        await parent.removeEntry(parts[parts.length - 1], {
          recursive: !!(options && options.recursive),
        });
      });
      this._fireSoon({ type: vscode.FileChangeType.Deleted, uri });
      await invalidateFolderCache(folder);
    } catch (err) {
      throw toFileSystemError(err, uri);
    }
  }

  /**
   * @param {vscode.Uri} oldUri
   * @param {vscode.Uri} newUri
   * @param {{ overwrite: boolean }} options
   */
  async rename(oldUri, newUri, options) {
    // OPFS has no atomic move, so this is copy-then-delete.
    const { folder } = parseUri(oldUri);
    try {
      const stat = await this.stat(oldUri);
      if (stat.type === vscode.FileType.Directory) {
        await this._copyDirectory(oldUri, newUri, options);
      } else {
        const data = await this.readFile(oldUri);
        await this.writeFile(newUri, data, {
          create: true,
          overwrite: !!(options && options.overwrite),
        });
      }
      await this.delete(oldUri, { recursive: true });

      this._fireSoon(
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      );
      await invalidateFolderCache(folder);
    } catch (err) {
      throw toFileSystemError(err, oldUri);
    }
  }

  /**
   * @param {vscode.Uri} from
   * @param {vscode.Uri} to
   * @param {{ overwrite: boolean }} options
   */
  async _copyDirectory(from, to, options) {
    await this.createDirectory(to);
    for (const [name, type] of await this.readDirectory(from)) {
      const childFrom = from.with({ path: `${from.path}/${name}` });
      const childTo = to.with({ path: `${to.path}/${name}` });
      if (type === vscode.FileType.Directory) {
        await this._copyDirectory(childFrom, childTo, options);
      } else {
        await this.writeFile(childTo, await this.readFile(childFrom), {
          create: true,
          overwrite: !!(options && options.overwrite),
        });
      }
    }
  }

  /**
   * Coalesces events so a bulk write does not fire one event per file.
   *
   * @param {...vscode.FileChangeEvent} events
   */
  _fireSoon(...events) {
    this._bufferedEvents.push(...events);
    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle);
    }
    this._fireSoonHandle = setTimeout(() => {
      this._emitter.fire(this._bufferedEvents);
      this._bufferedEvents.length = 0;
    }, 5);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function listFolders() {
  const registry = await readRegistry();
  const names = new Set(Object.keys(registry));

  // The registry can drift from what is actually on disk (RuntimeFS repairs it
  // on load), so trust the directory listing as well.
  try {
    const root = await rfsRoot();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === "directory") {
        names.add(name);
      }
    }
  } catch {
    /* no folders yet */
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} name
 * @returns {vscode.Uri}
 */
function folderUri(name) {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${name}` });
}

async function openRfsFolder() {
  const folders = await listFolders();
  if (folders.length === 0) {
    const create = "Create Folder...";
    const choice = await vscode.window.showInformationMessage(
      "No RuntimeFS folders yet. Upload one in RuntimeFS, or create an empty one here.",
      create,
    );
    if (choice === create) {
      return newRfsFolder();
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(folders, {
    title: "Open RuntimeFS Folder",
    placeHolder: "Select a folder stored in RuntimeFS",
  });
  if (picked) {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      folderUri(picked),
    );
  }
}

async function newRfsFolder() {
  const existing = new Set(await listFolders());
  const name = await vscode.window.showInputBox({
    title: "New RuntimeFS Folder",
    prompt: "Name for the new folder",
    validateInput: (value) => {
      if (!value || !value.trim()) {
        return "A name is required.";
      }
      if (/[/\\]/.test(value)) {
        return "The name cannot contain slashes.";
      }
      if (existing.has(value)) {
        return "A folder with that name already exists.";
      }
      return undefined;
    },
  });
  if (!name) {
    return;
  }

  const root = await rfsRoot(true);
  await root.getDirectoryHandle(name, { create: true });
  // encryptionType mirrors what rfs.js writes for a plain imported folder.
  await updateRegistryEntry(name, { encryptionType: null });

  await vscode.commands.executeCommand("vscode.openFolder", folderUri(name));
}

/** Imports a native directory through Chromium's File System Access picker. */
async function importRfsFolder() {
  try {
    const name = await vscode.commands.executeCommand(
      "runtimecode.internal.importRfsFolder",
    );
    if (typeof name === "string" && name) {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        folderUri(name),
      );
    }
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Could not import RuntimeFS folder: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Exports one RuntimeFS folder as a portable .tar.gz download. */
async function exportRfsFolder() {
  const folders = await listFolders();
  if (folders.length === 0) {
    await vscode.window.showInformationMessage(
      "No RuntimeFS folders to export.",
    );
    return;
  }

  // showQuickPick has no way to preselect an item, so the folder that is open
  // goes to the top of the list instead. The `activeItem` option this used to
  // pass belongs to the QuickPick object API and was quietly ignored here.
  const open = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === SCHEME,
  );
  const openName = open
    ? folders.find((name) => folderUri(name).toString() === open.uri.toString())
    : undefined;
  const ordered = openName
    ? [openName, ...folders.filter((name) => name !== openName)]
    : folders;

  const picked = await vscode.window.showQuickPick(ordered, {
    title: "Export RuntimeFS Folder",
    placeHolder: "Select a folder to save locally as .tar.gz",
  });
  if (!picked) {
    return;
  }

  try {
    await vscode.commands.executeCommand(
      "runtimecode.internal.exportRfsFolder",
      picked,
    );
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Could not export RuntimeFS folder: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Live preview
//
// Everything below lives in this file on purpose: the web extension host
// resolves `require` only for registered factories such as 'vscode'
// (extHostExtensionService.ts:109), so a relative require would throw
// "Cannot load module". Web extensions have to be a single file unless you add
// a bundler, and this one is small enough not to need one.
// ---------------------------------------------------------------------------

/** RuntimeFS serves uploaded folders from this virtual path. See sw.js. */
const VIRTUAL_ROOT = "/n/";
const SAME_ORIGIN_HEADER_LINES = [
  "* -> Cross-Origin-Embedder-Policy: require-corp",
  "* -> Cross-Origin-Opener-Policy: same-origin",
];
const SAME_ORIGIN_HEADER_LINE =
  /^\s*\*\s*->\s*Cross-Origin-(?:Embedder-Policy\s*:\s*require-corp|Opener-Policy\s*:\s*same-origin)\s*$/i;
const SAME_ORIGIN_HEADER_TESTS = [
  /^\s*\*\s*->\s*Cross-Origin-Embedder-Policy\s*:\s*require-corp\s*$/im,
  /^\s*\*\s*->\s*Cross-Origin-Opener-Policy\s*:\s*same-origin\s*$/im,
];

/** @param {vscode.Uri} uri */
function isPreviewable(uri) {
  return /\.(html?|svg|pdf|md)$/i.test(uri.path);
}

/**
 * `rfs:/<Folder>/a/b.html` + base -> `<base>/n/<Folder>/a/b.html`
 *
 * @param {string} base
 * @param {vscode.Uri} uri
 */
function previewUrlFor(base, uri) {
  const encoded = uri.path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${base}${VIRTUAL_ROOT}${encoded}`;
}

/** @param {string | undefined} headers */
function hasSameOriginHeaders(headers) {
  return SAME_ORIGIN_HEADER_TESTS.every((test) => test.test(headers || ""));
}

/**
 * @param {string} folder
 * @param {boolean} enabled
 */
async function setSameOriginHeaders(folder, enabled) {
  const registry = await readRegistry();
  const current = registry[folder]?.headers || "";
  const lines = current
    .split(/\r?\n/)
    .filter((line) => !SAME_ORIGIN_HEADER_LINE.test(line));
  if (enabled) {
    lines.push(...SAME_ORIGIN_HEADER_LINES);
  }
  await updateRegistryEntry(folder, { headers: lines.join("\n").trim() });
  await invalidateFolderCache(folder);
}

/** @param {string} folder */
async function ensureSameOriginHeaders(folder) {
  const headers = (await readRegistry())[folder]?.headers || "";
  if (hasSameOriginHeaders(headers)) {
    return true;
  }
  const add = "Add Headers";
  const choice = await vscode.window.showWarningMessage(
    "Dev Preview requires COEP+COOP in the RuntimeFS folder's Custom Headers. Use True Preview instead if you don't need dev features.",
    add,
  );
  if (choice !== add) {
    return false;
  }
  await setSameOriginHeaders(folder, true);
  await vscode.workspace
    .getConfiguration("runtimecode.sameOrigin")
    .update("enabled", true, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    "Dev Preview same-origin headers added; cache refreshed.",
  );
  return true;
}

/**
 * The active editor if it is previewable, else the RuntimeFS workspace root,
 * which RuntimeFS resolves to index.html, matching the user's expectation that
 * previewing "the folder" just works.
 */
function resolvePreviewTarget() {
  const active = vscode.window.activeTextEditor;
  if (
    active &&
    active.document.uri.scheme === SCHEME &&
    isPreviewable(active.document.uri)
  ) {
    return active.document.uri;
  }
  const folder = (vscode.workspace.workspaceFolders || []).find(
    (f) => f.uri.scheme === SCHEME,
  );
  return folder ? folder.uri : undefined;
}

/** @type {Record<string, string>} */
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

/**
 * The rc-preview.html wrapper URL for a target. `cacheBust` makes the iframe
 * refetch through RuntimeFS's service worker instead of replaying what it
 * cached before the last save.
 *
 * @param {string} runtimeCodeBase
 * @param {string} target
 * @param {boolean} inspector
 * @param {boolean} [cacheBust]
 */
function previewWrapperUrl(
  runtimeCodeBase,
  target,
  inspector,
  cacheBust = false,
) {
  const wrapper = new URL("rc-preview.html", runtimeCodeBase);
  wrapper.searchParams.set("target", target);
  if (inspector) {
    wrapper.searchParams.set("inspector", "1");
  }
  if (cacheBust) {
    wrapper.searchParams.set("__rc", String(Date.now()));
  }
  return wrapper.toString();
}

class PreviewPanel {
  constructor() {
    /** @type {vscode.WebviewPanel | undefined} */
    this._panel = undefined;
    /** @type {string | undefined} */
    this._url = undefined;
    /** @type {string | undefined} */
    this._runtimeCodeBase = undefined;
    this._inspector = vscode.workspace
      .getConfiguration("runtimecode.preview")
      .get("inspector", false);
  }

  get isOpen() {
    return !!this._panel;
  }

  /** Whether Eruda is injected. Opening in a tab has to match the panel. */
  get inspector() {
    return this._inspector;
  }

  /**
   * @param {string} url
   * @param {string} title
   * @param {string} runtimeCodeBase
   */
  show(url, title, runtimeCodeBase) {
    this._url = url;
    this._runtimeCodeBase = runtimeCodeBase;

    if (!this._panel) {
      this._panel = vscode.window.createWebviewPanel(
        "runtimecode.preview",
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this._panel.onDidDispose(() => {
        this._panel = undefined;
      });
      this._panel.webview.onDidReceiveMessage((message) => {
        if (message && message.command === "reload") {
          this.reload();
        }
        if (message && message.command === "openTab") {
          vscode.commands.executeCommand("runtimecode.openPreviewInTab");
        }
        if (message && message.command === "toggleInspector") {
          this.toggleInspector();
        }
      });
    } else {
      this._panel.title = title;
      this._panel.reveal(vscode.ViewColumn.Beside, true);
    }

    this._panel.webview.html = this._html(url, title, runtimeCodeBase);
  }

  reload() {
    if (this._panel && this._url && this._runtimeCodeBase) {
      this._panel.webview.html = this._html(
        this._url,
        this._panel.title,
        this._runtimeCodeBase,
      );
    }
  }

  async toggleInspector() {
    this._inspector = !this._inspector;
    await vscode.workspace
      .getConfiguration("runtimecode.preview")
      .update("inspector", this._inspector, vscode.ConfigurationTarget.Global);
    this.reload();
    return this._inspector;
  }

  /**
   * @param {string} url
   * @param {string} title
   * @param {string} runtimeCodeBase
   */
  _html(url, title, runtimeCodeBase) {
    const src = previewWrapperUrl(runtimeCodeBase, url, this._inspector, true);
    return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<title>${escapeHtml(title)}</title>
	<style>
		html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); }
		#bar {
			display: flex; gap: 8px; align-items: center; height: 28px; box-sizing: border-box;
			padding: 0 8px; font: 12px var(--vscode-font-family); color: var(--vscode-foreground);
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		#bar button {
			font: inherit; cursor: pointer; padding: 2px 8px; border: none; border-radius: 2px;
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		#bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
		#url { flex: 1; opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		iframe { width: 100%; height: calc(100% - 28px); border: 0; background: #fff; display: block; }
	</style>
</head>
<body>
	<div id="bar">
		<button id="reload">Reload</button>
		<button id="tab">Open in Tab</button>
		<button id="inspector">Inspector ${this._inspector ? "On" : "Off"}</button>
		<span id="url">${escapeHtml(url)}</span>
	</div>
	<iframe src="${escapeHtml(src)}"></iframe>
	<script>
		const api = acquireVsCodeApi();
		document.getElementById('reload').addEventListener('click', () => api.postMessage({ command: 'reload' }));
		document.getElementById('tab').addEventListener('click', () => api.postMessage({ command: 'openTab' }));
		document.getElementById('inspector').addEventListener('click', () => api.postMessage({ command: 'toggleInspector' }));
	</script>
</body>
</html>`;
  }
}

/**
 * Resolves the preview URL, saving and cache-invalidating first so the preview
 * never shows a stale file. Returns undefined (having told the user why) when
 * preview is not possible.
 */
async function resolvePreviewUrl({ prepare = true } = {}) {
  const target = resolvePreviewTarget();
  if (!target) {
    vscode.window.showWarningMessage(
      "Open a RuntimeFS folder by uploading it from that menu, or an HTML file to preview.",
    );
    return undefined;
  }

  if (prepare) {
    await vscode.workspace.saveAll(false);
    await invalidateFolderCache(parseUri(target).folder);
  }

  // Only the workbench knows where RuntimeFS is mounted; the extension host is
  // a worker with no `window.location`.
  const base = /** @type {string | undefined} */ (
    await vscode.commands.executeCommand(
      "runtimecode.internal.getRuntimeFsBase",
    )
  );
  if (!base) {
    vscode.window.showErrorMessage(
      "Live preview needs RuntimeCode to be served from RuntimeFS (a /n/<Folder>/ URL). " +
        "This instance looks like it is hosted standalone.",
    );
    return undefined;
  }

  const runtimeCodeBase = /** @type {string | undefined} */ (
    await vscode.commands.executeCommand(
      "runtimecode.internal.getRuntimeCodeBase",
    )
  );
  if (!runtimeCodeBase) {
    return undefined;
  }
  return { url: previewUrlFor(base, target), target, runtimeCodeBase };
}

async function resolveDevPreview() {
  const resolved = await resolvePreviewUrl();
  if (!resolved) {
    return undefined;
  }
  return (await ensureSameOriginHeaders(parseUri(resolved.target).folder))
    ? resolved
    : undefined;
}

// ---------------------------------------------------------------------------

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const provider = new RuntimeFSProvider();
  const preview = new PreviewPanel();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: true,
    }),

    vscode.commands.registerCommand("runtimecode.openRfsFolder", openRfsFolder),
    vscode.commands.registerCommand("runtimecode.newRfsFolder", newRfsFolder),
    vscode.commands.registerCommand(
      "runtimecode.importRfsFolder",
      importRfsFolder,
    ),
    vscode.commands.registerCommand(
      "runtimecode.exportRfsFolder",
      exportRfsFolder,
    ),
    vscode.commands.registerCommand("runtimecode.refreshRfs", async () => {
      for (const folder of vscode.workspace.workspaceFolders || []) {
        if (folder.uri.scheme === SCHEME) {
          await invalidateFolderCache(parseUri(folder.uri).folder);
        }
      }
      vscode.window.showInformationMessage("RuntimeFS cache refreshed.");
    }),

    vscode.commands.registerCommand("runtimecode.showPreview", async () => {
      const resolved = await resolveDevPreview();
      if (!resolved) {
        return;
      }
      const name =
        resolved.target.path.split("/").filter(Boolean).pop() || "index.html";
      preview.show(resolved.url, `Preview: ${name}`, resolved.runtimeCodeBase);
    }),

    vscode.commands.registerCommand(
      "runtimecode.openPreviewInTab",
      async () => {
        const resolved = await resolveDevPreview();
        if (!resolved) {
          return;
        }
        // window.open is unavailable in the extension host worker, so the
        // workbench opens the tab. That also keeps RuntimeFS's rules applied.
        await vscode.commands.executeCommand(
          "runtimecode.internal.openExternalTab",
          previewWrapperUrl(
            resolved.runtimeCodeBase,
            resolved.url,
            preview.inspector,
          ),
        );
      },
    ),

    vscode.commands.registerCommand(
      "runtimecode.openTruePreviewInTab",
      async () => {
        const resolved = await resolvePreviewUrl({ prepare: false });
        if (!resolved) {
          return;
        }
        // Deliberately direct: no wrapper, cache-buster, auto-reload or Eruda.
        await vscode.commands.executeCommand(
          "runtimecode.internal.openExternalTab",
          resolved.url,
        );
      },
    ),

    vscode.commands.registerCommand("runtimecode.reloadPreview", () =>
      preview.reload(),
    ),

    vscode.commands.registerCommand(
      "runtimecode.togglePreviewInspector",
      async () => {
        const enabled = await preview.toggleInspector();
        vscode.window.showInformationMessage(
          `Preview inspector ${enabled ? "enabled" : "disabled"}.`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "runtimecode.enableSameOrigin",
      async () => {
        const target = resolvePreviewTarget();
        if (!target) {
          return;
        }
        const folder = parseUri(target).folder;
        await setSameOriginHeaders(folder, true);
        await vscode.workspace
          .getConfiguration("runtimecode.sameOrigin")
          .update("enabled", true, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          "Dev Preview same-origin headers enabled; cache refreshed.",
        );
      },
    ),

    vscode.commands.registerCommand(
      "runtimecode.disableSameOrigin",
      async () => {
        const target = resolvePreviewTarget();
        if (!target) {
          return;
        }
        const folder = parseUri(target).folder;
        await setSameOriginHeaders(folder, false);
        await vscode.workspace
          .getConfiguration("runtimecode.sameOrigin")
          .update("enabled", false, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          "Dev Preview same-origin headers disabled; cache refreshed.",
        );
      },
    ),

    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("runtimecode.sameOrigin.enabled")) {
        return;
      }
      const target = resolvePreviewTarget();
      if (!target) {
        return;
      }
      const enabled = vscode.workspace
        .getConfiguration("runtimecode.sameOrigin")
        .get("enabled", false);
      await setSameOriginHeaders(parseUri(target).folder, enabled);
    }),

    // Saving anything in a previewed folder refreshes the side preview.
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!preview.isOpen || doc.uri.scheme !== SCHEME) {
        return;
      }
      await invalidateFolderCache(parseUri(doc.uri).folder);
      preview.reload();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
