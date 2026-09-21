/*---------------------------------------------------------------------------------------------
 *  RuntimeCode: the Python runtime host
 *
 *  The host half of RUNTIMES.md, for one language. It owns every surface the
 *  user sees -- the Run commands, the pseudoterminal, the runtime picker, the
 *  status bar item, the capability warnings -- for three Python runtimes that
 *  differ on every axis the plan measures:
 *
 *    python.pyodide       quick     CPython via Emscripten, micropip, ~11 MB
 *    python.cpython-wasi  faithful  unpatched CPython for wasm32-wasip1, ~21 MB
 *    python.micropython   tiny      the microcontroller interpreter, <1 MB
 *
 *  What it is not: any of those three runtimes. No wasm ships in this build,
 *  `scripts/packs.mjs` does not exist yet (RUNTIMES.md M2), so every runtime
 *  here resolves to "pack not installed" and a run ends in a preflight report
 *  instead of program output.
 *
 *  That report is the point of the shell. It drives the whole host path --
 *  runtime selection, dirty-buffer policy, the mount table, stdin negotiation,
 *  the terminal, streaming, exit codes -- so that landing a pack later only has
 *  to fill in one function per engine: EngineAdapter.createSession(). The
 *  reports are also the honest answer to "why did nothing run", which beats a
 *  silent no-op or a runtime that appears to hang.
 *
 *  Three shapes here are contracts, not implementation details, and changing
 *  them means changing RUNTIMES.md too: the `runtimecode.runtimes` manifest
 *  contribution, the RunSpec/SessionIO/RuntimeSession triple, and the guest
 *  message names (init, stdin, signal, resize, dispose / ready, stdout, stderr,
 *  exit, fs, diag).
 *
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

// The web extension host loads this file as CommonJS by wrapping it in
// `new Function('module','exports','require', src)` (extHostExtensionService.ts),
// so it has to stay a single, dependency-free file. There is no bundler and no
// relative require: only 'vscode' resolves. A pack, which carries a bundled
// worker, does not get that luxury; the host does, and keeps it.

const vscode = require("vscode");

const CONFIG_SECTION = "runtimecode.python";
/** The manifest key packs and this extension both declare runtimes under. */
const CONTRIBUTION_KEY = "runtimecode.runtimes";
/** Where the per-workspace runtime choice is remembered. */
const SELECTED_RUNTIME_KEY = "runtimecode.python.runtime";
const LANGUAGE = "python";
/** Exit codes the host itself produces, following the shell convention. */
const EXIT_NOT_INSTALLED = 127;
const EXIT_INTERRUPTED = 130;

// ---------------------------------------------------------------------------
// The contract, as types
// ---------------------------------------------------------------------------

/**
 * @typedef {"quick" | "faithful" | "tiny"} Tier
 *   RUNTIMES.md names two tiers. MicroPython is neither: it is not a smaller
 *   Pyodide, it is a different language subset, so it gets its own name rather
 *   than pretending to be the quick tier that Pyodide already fills.
 *
 * @typedef {"none" | "buffered" | "blocking"} StdinMode
 *
 * @typedef {object} Capabilities
 * @property {StdinMode} stdin
 * @property {boolean} threads
 * @property {string} packages
 * @property {string} graphics
 * @property {boolean} debug
 * @property {string} fs
 *
 * @typedef {object} RuntimeDescriptor
 * @property {string} id
 * @property {string} displayName
 * @property {string[]} languages
 * @property {Tier} tier
 * @property {string} engine Selects the EngineAdapter in ENGINES.
 * @property {string} languageVersion
 * @property {"worker" | "webview" | "window"} site
 * @property {string} pack Folder name inside the packs RuntimeFS folder.
 * @property {number} installBytes
 * @property {string} [installBytesSource] `estimate` until a pack measures it.
 * @property {string} [license]
 * @property {string} [homepage]
 * @property {string} [summary]
 * @property {{ crossOriginIsolated?: boolean }} [requires]
 * @property {Capabilities} capabilities
 * @property {Partial<Capabilities>} [isolatedCapabilities] What improves once
 *   the deployment is cross-origin isolated.
 * @property {string} extensionId The extension that declared it.
 *
 * @typedef {object} Mount One row of the table the guest is allowed to see.
 * @property {string} guestPath
 * @property {"host" | "memory"} kind
 * @property {vscode.Uri} [uri] Host side, for `kind: "host"`.
 * @property {boolean} readOnly
 *
 * @typedef {object} RunSpec
 * @property {string} runtimeId
 * @property {vscode.Uri} [entry] Absent for a selection run, which has no file.
 * @property {string} entryGuestPath
 * @property {string} [entrySource] The program text, for a selection run.
 * @property {string} label What the terminal calls this run.
 * @property {string[]} argv
 * @property {Record<string, string>} env
 * @property {string} cwd Guest-side.
 * @property {Mount[]} mounts
 * @property {StdinMode} stdinMode
 *
 * @typedef {object} SessionIO What the host hands a session to talk back with.
 * @property {(text: string) => void} stdout
 * @property {(text: string) => void} stderr
 * @property {(text: string) => void} diag
 *
 * @typedef {object} RuntimeSession
 * @property {(data: string) => void} write
 * @property {(signal: "INT" | "KILL") => void} signal
 * @property {(cols: number, rows: number) => void} resize
 * @property {() => void} dispose
 * @property {Promise<number>} exit
 *
 * @typedef {object} EngineAdapter
 * @property {string} id
 * @property {string} loader The pack asset the worker importScripts() first.
 * @property {string[]} assets Every asset the pack must carry to be runnable.
 * @property {string[]} notes Constraints that decide whether the pack can be
 *   built at all. Read these before pinning an upstream build.
 * @property {(spec: RunSpec, io: SessionIO, pack: PackManifest) => Promise<RuntimeSession>} createSession
 *
 * @typedef {object} PackManifest What `scripts/packs.mjs` writes next to a
 *   pack's assets, and what install-time digest verification reads.
 * @property {string} id
 * @property {string} version
 * @property {string} [engine]
 * @property {number} [installBytes]
 * @property {string} [license]
 * @property {{ name: string, bytes?: number, sha256?: string }[]} [assets]
 *
 * @typedef {object} PackStatus
 * @property {"installed" | "missing" | "standalone" | "error"} state
 * @property {string} [base] URL the pack was looked for under.
 * @property {PackManifest} [manifest]
 * @property {string[]} [missingAssets]
 * @property {string} [detail]
 *
 * @typedef {object} EnvironmentProbe
 * @property {boolean} crossOriginIsolated
 * @property {boolean} sharedArrayBuffer
 * @property {StdinMode} bestStdin
 *
 * @typedef {object} Negotiated
 * @property {Capabilities} capabilities
 * @property {string[]} notices Lines to print when the answer is worse than the
 *   manifest promised. Silent EOF is how "the runtime hangs" gets reported.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
function setting(key, fallback) {
  return config().get(key, fallback);
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * Every Python runtime any installed extension declares, ours included.
 *
 * The three built-in descriptors live in our own package.json rather than in
 * this file so that a pack, once packs exist, can declare itself with the exact
 * same JSON and be picked up with no host change. When a pack declares an id we
 * also declare, the pack wins: its copy is the one that matches the bytes on
 * disk, ours is a placeholder describing a runtime that is not there.
 *
 * @param {string} selfId
 * @returns {RuntimeDescriptor[]}
 */
function readCatalog(selfId) {
  /** @type {Map<string, RuntimeDescriptor>} */
  const byId = new Map();

  for (const extension of vscode.extensions.all) {
    const contributes = extension.packageJSON && extension.packageJSON.contributes;
    const declared = contributes && contributes[CONTRIBUTION_KEY];
    if (!Array.isArray(declared)) {
      continue;
    }
    for (const entry of declared) {
      const descriptor = toDescriptor(entry, extension.id);
      if (!descriptor || !descriptor.languages.includes(LANGUAGE)) {
        continue;
      }
      const existing = byId.get(descriptor.id);
      if (existing && existing.extensionId !== selfId) {
        continue;
      }
      byId.set(descriptor.id, descriptor);
    }
  }

  const order = { quick: 0, faithful: 1, tiny: 2 };
  return [...byId.values()].sort(
    (a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9),
  );
}

/**
 * Manifest JSON is whatever the author typed, so the fields the host actually
 * dereferences are checked. A malformed descriptor is dropped rather than
 * crashing activation: one bad pack should not take Python away.
 *
 * @param {any} entry
 * @param {string} extensionId
 * @returns {RuntimeDescriptor | undefined}
 */
function toDescriptor(entry, extensionId) {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const { id, displayName, languages, capabilities } = entry;
  if (typeof id !== "string" || typeof displayName !== "string") {
    return undefined;
  }
  if (!Array.isArray(languages) || !capabilities) {
    return undefined;
  }
  return {
    id,
    displayName,
    languages: languages.filter((l) => typeof l === "string"),
    tier: entry.tier === "faithful" || entry.tier === "tiny" ? entry.tier : "quick",
    engine: typeof entry.engine === "string" ? entry.engine : "",
    languageVersion:
      typeof entry.languageVersion === "string" ? entry.languageVersion : "",
    site: entry.site === "webview" || entry.site === "window" ? entry.site : "worker",
    pack: typeof entry.pack === "string" ? entry.pack : id,
    installBytes:
      typeof entry.installBytes === "number" ? entry.installBytes : 0,
    installBytesSource: entry.installBytesSource,
    license: entry.license,
    homepage: entry.homepage,
    summary: entry.summary,
    requires: entry.requires,
    capabilities: {
      stdin: isStdinMode(capabilities.stdin) ? capabilities.stdin : "none",
      threads: capabilities.threads === true,
      packages:
        typeof capabilities.packages === "string" ? capabilities.packages : "none",
      graphics:
        typeof capabilities.graphics === "string" ? capabilities.graphics : "none",
      debug: capabilities.debug === true,
      fs: typeof capabilities.fs === "string" ? capabilities.fs : "mount",
    },
    isolatedCapabilities: entry.isolatedCapabilities,
    extensionId,
  };
}

/**
 * @param {unknown} value
 * @returns {value is StdinMode}
 */
function isStdinMode(value) {
  return value === "none" || value === "buffered" || value === "blocking";
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/**
 * What this deployment can do, measured rather than assumed. Isolation is not
 * ours to turn on: it comes from COOP and COEP on the folder RuntimeCode is
 * served from, which is a RuntimeFS Custom Headers setting. Everything downhill
 * of that -- SharedArrayBuffer, Atomics.wait, therefore blocking stdin --
 * follows from this one probe.
 *
 * @returns {EnvironmentProbe}
 */
function probeEnvironment() {
  const isolated =
    typeof globalThis.crossOriginIsolated === "boolean"
      ? globalThis.crossOriginIsolated
      : false;
  const sharedArrayBuffer = typeof SharedArrayBuffer === "function";
  return {
    crossOriginIsolated: isolated,
    sharedArrayBuffer,
    // Blocking reads mean Atomics.wait on a ring buffer shared with the guest
    // worker, and a SharedArrayBuffer that only exists under isolation.
    bestStdin: isolated && sharedArrayBuffer ? "blocking" : "buffered",
  };
}

/**
 * Reconcile three opinions about what a run can do: what the runtime's manifest
 * claims, what this environment supports, and what the user asked for. The
 * notices are the whole reason this function returns a pair -- a capability
 * that quietly degrades is the failure mode RUNTIMES.md calls out by name.
 *
 * @param {RuntimeDescriptor} descriptor
 * @param {EnvironmentProbe} env
 * @returns {Negotiated}
 */
function negotiate(descriptor, env) {
  /** @type {string[]} */
  const notices = [];
  const declared = descriptor.capabilities;

  // A runtime may advertise more once isolation is on; CPython on WASI goes
  // from EOF-only to real blocking reads, because its fd_read becomes a
  // synchronous syscall the shim can service.
  const upgrade =
    env.crossOriginIsolated && descriptor.isolatedCapabilities
      ? descriptor.isolatedCapabilities
      : {};
  /** @type {Capabilities} */
  const capabilities = { ...declared, ...upgrade };

  const best = capabilities.stdin === "none" ? "none" : env.bestStdin;
  const requested = setting("stdin", "auto");
  let stdin = rankStdin(capabilities.stdin) < rankStdin(best) ? capabilities.stdin : best;

  if (isStdinMode(requested)) {
    if (rankStdin(requested) > rankStdin(stdin)) {
      notices.push(
        `stdin: "${requested}" was requested, but this runtime and deployment top out at "${stdin}".`,
      );
    } else {
      stdin = requested;
    }
  }

  const isolationWouldHelp =
    !env.crossOriginIsolated &&
    descriptor.isolatedCapabilities !== undefined &&
    rankStdin(descriptor.isolatedCapabilities.stdin || "none") > rankStdin(stdin);

  if (stdin === "none") {
    notices.push(
      "stdin: reads return EOF immediately, so input() raises EOFError rather than waiting." +
        (isolationWouldHelp
          ? " Cross-origin isolation (COOP+COEP on this RuntimeFS folder) would make it blocking."
          : ""),
    );
  } else if (stdin === "buffered" && !env.crossOriginIsolated) {
    notices.push(
      "stdin: buffered, not blocking. Typed input is queued and a read takes what has arrived. " +
        "Blocking reads need cross-origin isolation (COOP+COEP on this RuntimeFS folder).",
    );
  }

  if (declared.threads && !env.crossOriginIsolated) {
    notices.push(
      "threads: off. The nested-worker polyfill forbids a worker spawning workers, so a " +
        "threaded build needs the webview execution site as well as isolation.",
    );
  }
  if (descriptor.requires && descriptor.requires.crossOriginIsolated && !env.crossOriginIsolated) {
    notices.push(
      `${descriptor.displayName} requires cross-origin isolation, which this deployment does not have.`,
    );
  }

  capabilities.stdin = stdin;
  return { capabilities, notices };
}

/** @param {StdinMode} mode */
function rankStdin(mode) {
  return mode === "blocking" ? 2 : mode === "buffered" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

/**
 * Where a runtime pack's bytes are, if they are anywhere.
 *
 * A pack is a RuntimeFS folder served by RuntimeFS's service worker, because
 * `additionalBuiltinExtensions` takes a URL and OPFS has none. That makes pack
 * lookup an HTTP fetch of `<rfs base>/n/<packs folder>/<pack id>/pack.json`,
 * and it makes a standalone deployment -- one not served from RuntimeFS at all
 * -- a first-class answer rather than an error: there is no `/n/` segment, so
 * there can be no packs, and the host should say so.
 *
 * Results are cached for the session because a probe costs a network round
 * trip and the answer only changes on install, which reloads the workbench
 * anyway. `Refresh Installed Runtimes` drops the cache by hand.
 */
class PackIndex {
  constructor() {
    /** @type {Map<string, PackStatus>} */
    this._cache = new Map();
    /** @type {Promise<string | undefined> | undefined} */
    this._base = undefined;
  }

  invalidate() {
    this._cache.clear();
    this._base = undefined;
  }

  /**
   * The packs folder URL, or undefined when RuntimeCode is served standalone.
   * `runtimecode.internal.getRuntimeFsBase` is registered by the bootstrap in
   * static/index.html; the extension host is a worker and cannot work this out
   * for itself.
   *
   * @returns {Promise<string | undefined>}
   */
  async base() {
    if (!this._base) {
      this._base = (async () => {
        try {
          const rfsBase = await vscode.commands.executeCommand(
            "runtimecode.internal.getRuntimeFsBase",
          );
          if (typeof rfsBase !== "string" || !rfsBase) {
            return undefined;
          }
          const folder = setting("packsFolder", "RC-Packs");
          return `${rfsBase}/n/${encodeURIComponent(folder)}/`;
        } catch {
          return undefined;
        }
      })();
    }
    return this._base;
  }

  /**
   * @param {RuntimeDescriptor} descriptor
   * @returns {Promise<PackStatus>}
   */
  async lookup(descriptor) {
    const cached = this._cache.get(descriptor.id);
    if (cached) {
      return cached;
    }
    const status = await this._probe(descriptor);
    this._cache.set(descriptor.id, status);
    return status;
  }

  /**
   * @param {RuntimeDescriptor} descriptor
   * @returns {Promise<PackStatus>}
   */
  async _probe(descriptor) {
    const base = await this.base();
    if (!base) {
      return {
        state: "standalone",
        detail:
          "RuntimeCode is not being served from RuntimeFS, so there is no /n/ path a pack could be installed under.",
      };
    }
    const url = `${base}${encodeURIComponent(descriptor.pack)}/pack.json`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        return {
          state: "missing",
          base: url,
          detail: `${response.status} ${response.statusText || "not found"}`,
        };
      }
      const manifest = /** @type {PackManifest} */ (await response.json());
      const engine = ENGINES[descriptor.engine];
      const present = new Set(
        (manifest.assets || []).map((asset) => asset && asset.name),
      );
      const missingAssets = engine
        ? engine.assets.filter((name) => !present.has(name))
        : [];
      return { state: "installed", base: url, manifest, missingAssets };
    } catch (err) {
      return { state: "error", base: url, detail: messageOf(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Pack install (the autosystem)
// ---------------------------------------------------------------------------

/**
 * The installed-pack registry. One file, `rfs/.runtimecode/packs.json`, read by
 * the bootstrap in static/index.html before `create()` so each installed pack
 * can be appended to additionalBuiltinExtensions as a built-in extension.
 *
 * @typedef {object} PacksRegistry
 * @property {string} [folder] The packs folder name installs target, so the
 *   bootstrap can resolve `/n/<folder>/<id>/` without knowing the setting.
 * @property {Record<string, { version: string, installedAt: number }>} packs
 */

/** The registry file, `rfs/.runtimecode/packs.json`. */
const REGISTRY_PATH = [".runtimecode", "packs.json"];

async function opfsRoot() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    throw new RunStartError("OPFS is unavailable in this browser.", [
      "Installing and running runtime packs requires the Origin Private File System.",
    ]);
  }
  return navigator.storage.getDirectory();
}

/** The `rfs/` prefix every RuntimeFS folder and the registry live under. */
async function rfsPrefix(create = false) {
  return (await opfsRoot()).getDirectoryHandle("rfs", { create });
}

/**
 * @returns {Promise<PacksRegistry>}
 */
async function readPacksRegistry() {
  try {
    const prefix = await rfsPrefix();
    let dir = prefix;
    for (let i = 0; i < REGISTRY_PATH.length - 1; i++) {
      dir = await dir.getDirectoryHandle(REGISTRY_PATH[i]);
    }
    const file = await dir.getFileHandle(REGISTRY_PATH[REGISTRY_PATH.length - 1]);
    const text = await (await file.getFile()).text();
    const parsed = text ? JSON.parse(text) : {};
    return {
      folder: parsed.folder,
      packs: parsed.packs && typeof parsed.packs === "object" ? parsed.packs : {},
    };
  } catch {
    return { folder: undefined, packs: {} };
  }
}

/**
 * Writes the registry under a lock, so two installs cannot interleave. A
 * separate lock from RuntimeFS's `rfs_registry_lock`: that one protects
 * rfs_system.json, this one protects packs.json, and they never touch the same
 * file.
 *
 * @param {PacksRegistry} registry
 */
async function writePacksRegistry(registry) {
  const write = async () => {
    const prefix = await rfsPrefix(true);
    let dir = prefix;
    for (let i = 0; i < REGISTRY_PATH.length - 1; i++) {
      dir = await dir.getDirectoryHandle(REGISTRY_PATH[i], { create: true });
    }
    const file = await dir.getFileHandle(REGISTRY_PATH[REGISTRY_PATH.length - 1], { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(registry));
    await writable.close();
  };
  if (navigator.locks) {
    return navigator.locks.request("rfs_packs_registry", { mode: "exclusive" }, write);
  }
  return write();
}

/**
 * SHA-256 hex of an ArrayBuffer, for install-time digest re-verification.
 *
 * @param {ArrayBuffer} buffer
 */
async function sha256HexBytes(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Writes `relPath` (e.g. `assets/pyodide.js`) under `rfs/<packsFolder>/<id>/`,
 * creating directories as needed.
 *
 * @param {FileSystemDirectoryHandle} prefix
 * @param {string} packsFolder
 * @param {string} id
 * @param {string} relPath
 * @param {Uint8Array} bytes
 */
async function writePackFile(prefix, packsFolder, id, relPath, bytes) {
  let dir = await prefix.getDirectoryHandle(packsFolder, { create: true });
  dir = await dir.getDirectoryHandle(id, { create: true });
  const parts = relPath.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await file.createWritable();
  await writable.write(/** @type {BufferSource} */ (bytes));
  await writable.close();
}

/** @param {FileSystemDirectoryHandle} prefix @param {string} packsFolder @param {string} id */
async function deletePackFolder(prefix, packsFolder, id) {
  const folder = await prefix.getDirectoryHandle(packsFolder, { create: true });
  await folder.removeEntry(id, { recursive: true });
}

/** @param {FileSystemDirectoryHandle} prefix @param {string} packsFolder @returns {Promise<string[]>} */
async function listPackFolders(prefix, packsFolder) {
  try {
    const folder = await prefix.getDirectoryHandle(packsFolder);
    /** @type {string[]} */
    const names = [];
    for await (const [name, handle] of folder.entries()) {
      if (handle.kind === "directory") {
        names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Installs one pack: fetch every file it ships from the packs folder URL,
 * re-verify the asset digests against the catalog, write the bytes into OPFS
 * under `rfs/<packsFolder>/<id>/`, and record it in the registry. A reload then
 * makes the bootstrap register it as a built-in extension.
 *
 * The digests are checked here, again, even though scripts/packs.mjs checked
 * them at build time: a runtime is the most privileged thing a user installs,
 * and the catalog could have been served by a proxy the build never saw.
 *
 * @param {CatalogEntry} entry One row of catalog.json.
 * @param {string} base The packs folder base URL, with trailing slash.
 * @param {string} packsFolder
 * @returns {Promise<void>}
 */
async function installPack(entry, base, packsFolder) {
  const prefix = await rfsPrefix(true);
  const id = entry.id;

  const fetchFile = async (/** @type {string} */ file) => {
    const url = `${base}${encodeURIComponent(id)}/${file}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Could not fetch ${url} (${response.status} ${response.statusText}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const asset = (entry.assets || []).find((a) => `assets/${a.name}` === file);
    if (asset && asset.sha256) {
      const digest = await sha256HexBytes(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      if (digest !== asset.sha256) {
        throw new Error(`Checksum mismatch for ${url}: expected ${asset.sha256}, got ${digest}.`);
      }
    }
    await writePackFile(prefix, packsFolder, id, file, bytes);
  };

  for (const file of entry.files || []) {
    await fetchFile(file);
  }

  const registry = await readPacksRegistry();
  registry.folder = packsFolder;
  registry.packs[id] = { version: entry.version, installedAt: Date.now() };
  await writePacksRegistry(registry);

  try {
    await vscode.commands.executeCommand("runtimecode.internal.invalidateRfsCache", packsFolder);
  } catch {
    /* best effort: stale cache just means the reload is required anyway */
  }
}

/**
 * Uninstalls one pack: delete its OPFS folder and drop it from the registry.
 *
 * @param {string} id
 * @param {string} packsFolder
 */
async function uninstallPack(id, packsFolder) {
  const prefix = await rfsPrefix(true);
  try {
    await deletePackFolder(prefix, packsFolder, id);
  } catch {
    /* already gone is fine */
  }
  const registry = await readPacksRegistry();
  delete registry.packs[id];
  if (Object.keys(registry.packs).length === 0) {
    delete registry.folder;
  }
  await writePacksRegistry(registry);
  try {
    await vscode.commands.executeCommand("runtimecode.internal.invalidateRfsCache", packsFolder);
  } catch {
    /* best effort */
  }
}

/**
 * Removes pack folders with no registry entry -- what an interrupted install
 * leaves behind. Returns the names removed.
 *
 * @param {string} packsFolder
 * @returns {Promise<string[]>}
 */
async function cleanupPacksFolder(packsFolder) {
  const prefix = await rfsPrefix(true);
  const registry = await readPacksRegistry();
  const orphaned = [];
  for (const name of await listPackFolders(prefix, packsFolder)) {
    if (!registry.packs[name]) {
      try {
        await deletePackFolder(prefix, packsFolder, name);
        orphaned.push(name);
      } catch {
        /* keep going */
      }
    }
  }
  if (orphaned.length > 0) {
    try {
      await vscode.commands.executeCommand("runtimecode.internal.invalidateRfsCache", packsFolder);
    } catch {
      /* best effort */
    }
  }
  return orphaned;
}

/**
 * One row of dist/packs/catalog.json, as scripts/packs.mjs emits it.
 *
 * @typedef {object} CatalogEntry
 * @property {string} id
 * @property {string} version
 * @property {string} [engine]
 * @property {"quick" | "faithful" | "tiny"} [tier]
 * @property {string} [license]
 * @property {string} [summary]
 * @property {number} [installBytes]
 * @property {{ displayName?: string, tier?: string }} [descriptor]
 * @property {string[]} files Every file the pack folder ships.
 * @property {{ name: string, bytes?: number, sha256?: string }[]} [assets]
 */

/**
 * Reads `catalog.json` from the packs folder. Returns the parsed array, or
 * undefined when there is no packs base (standalone) or no catalog yet.
 *
 * @param {PackIndex} packs
 * @returns {Promise<CatalogEntry[] | undefined>}
 */
async function fetchCatalog(packs) {
  const base = await packs.base();
  if (!base) {
    return undefined;
  }
  try {
    const response = await fetch(`${base}catalog.json`, { cache: "no-store" });
    if (!response.ok) {
      return undefined;
    }
    const catalog = await response.json();
    return Array.isArray(catalog) ? catalog : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/**
 * Raised when a run cannot start, with the detail lines the terminal prints
 * verbatim. Everything a user needs to act on belongs in `detail`, not in the
 * message: one line of "it failed" and five of "here is what is missing".
 */
class RunStartError extends Error {
  /**
   * @param {string} message
   * @param {string[]} detail
   * @param {number} [exitCode]
   */
  constructor(message, detail, exitCode = EXIT_NOT_INSTALLED) {
    super(message);
    this.name = "RunStartError";
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

/**
 * The three engines. Each one is a plan plus an unwritten createSession(): the
 * asset list is what the pack build has to fetch and pin, the notes are the
 * constraints that decide whether a given upstream build can be used here at
 * all, and both are consumed by the diagnostics command rather than left as
 * comments nobody reads.
 *
 * @type {Record<string, EngineAdapter>}
 */
const ENGINES = {
  pyodide: {
    id: "pyodide",
    loader: "pyodide.js",
    // The contents of pyodide-core-<version>.tar.bz2, which is the download
    // Pyodide documents for self-hosting.
    assets: [
      "pyodide.js",
      "pyodide.asm.js",
      "pyodide.asm.wasm",
      "python_stdlib.zip",
      "pyodide-lock.json",
    ],
    notes: [
      "Load pyodide.js, not pyodide.mjs: the nested-worker polyfill ends in importScripts(), which is invalid in a module worker.",
      "indexURL must point at the pack folder served by RuntimeFS, so nothing is fetched from a CDN at run time.",
      "loadPackage and micropip both want the network; a pack has to vendor the wheels it promises or say packages: none.",
      "Emscripten's MEMFS is the guest filesystem. The mount table is implemented by copying in before the run and copying out after, or by a FS backend that proxies to workspace.fs.",
      "matplotlib and anything else drawing pixels needs the webview execution site, not this one.",
    ],
    createSession: notImplemented("pyodide", [
      "bundle a classic-script worker that importScripts() pyodide.js and speaks the init/stdout/exit protocol",
      "wire setStdout/setStderr batched callbacks into SessionIO, and stdin through the negotiated tier",
      "implement the mount table over Emscripten FS, honouring readOnly",
    ]),
  },

  "cpython-wasi": {
    id: "cpython-wasi",
    loader: "python.wasm",
    assets: ["python.wasm", "python-stdlib.zip"],
    notes: [
      "wasm32-wasip1, so the shim decides everything: @vscode/wasm-wasi needs ms-vscode.wasm-wasi-core vendored as a built-in, @bjorn3/browser_wasi_shim has no synchronous syscalls and needs its own SAB ring buffer for blocking stdin.",
      "Without isolation there is no SAB, so fd_read on stdin returns EOF; that is why this descriptor declares stdin: none and upgrades to blocking only under isolation.",
      "Mounts are WASI preopens, fixed at instantiation: the mount table has to be complete before the module starts.",
      "No threads and no subprocess: not a shim limitation, the upstream WASI build has neither.",
      "The stdlib is a separate tree or zip; PYTHONHOME and PYTHONPATH have to name whichever the pack shipped.",
    ],
    createSession: notImplemented("cpython-wasi", [
      "pick the WASI shim (RUNTIMES.md open question 1) -- it decides the guest entry point",
      "instantiate python.wasm with preopens built from the mount table",
      "for blocking stdin, allocate the SAB ring buffer host-side and hand it to the guest in init",
    ]),
  },

  micropython: {
    id: "micropython",
    loader: "micropython.js",
    assets: ["micropython.js", "micropython.wasm"],
    notes: [
      "ports/webassembly emits micropython.mjs; the pack build has to re-emit it as an IIFE (EXPORT_ES6=0, MODULARIZE=1) for the same importScripts reason as Pyodide.",
      "The build is asyncify-based, which is what makes a blocking input() possible at all here -- but it costs code size and speed.",
      "Not CPython: no ssl, no sqlite3, a small subset of the stdlib, and a different traceback format. Conformance cases will fail on purpose, and that is the point of the tier.",
      "mp_js_do_str runs a string, so a selection run needs no temporary file at all.",
      "No mip package installs: there is no network in the guest.",
    ],
    createSession: notImplemented("micropython", [
      "bundle the IIFE loader and speak the init/stdout/exit protocol",
      "route stdout through the Module.print hooks and stdin through the asyncify read callback",
      "implement the mount table over the VFS hooks the wasm port exposes",
    ]),
  },
};

/**
 * The honest placeholder. Every engine resolves here today, and each one names
 * what it would take to replace it, so the next person does not have to
 * reconstruct the plan from the asset list.
 *
 * @param {string} engine
 * @param {string[]} steps
 * @returns {(spec: RunSpec, io: SessionIO, pack: PackManifest) => Promise<RuntimeSession>}
 */
function notImplemented(engine, steps) {
  return async (_spec, _io, pack) => {
    throw new RunStartError(
      `The ${engine} pack is installed (version ${pack.version || "unknown"}), but its session is not implemented yet.`,
      [
        "This build ships the runtime host, not the runtimes. To finish this engine:",
        ...steps.map((step) => `  - ${step}`),
        "See RUNTIMES.md, milestone M3.",
      ],
    );
  };
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

/**
 * Resolve a descriptor plus a spec into a live session, or throw a
 * RunStartError carrying everything the terminal should print. This is the
 * single place that knows a runtime might not be installed; once packs exist,
 * an install prompt belongs here and nowhere else.
 *
 * @param {RuntimeDescriptor} descriptor
 * @param {PackStatus} pack
 * @param {RunSpec} spec
 * @param {SessionIO} io
 * @returns {Promise<RuntimeSession>}
 */
async function startSession(descriptor, pack, spec, io) {
  const engine = ENGINES[descriptor.engine];
  if (!engine) {
    throw new RunStartError(
      `No engine adapter for "${descriptor.engine}".`,
      [
        `${descriptor.displayName} declares engine "${descriptor.engine}", which this host does not implement.`,
        `Known engines: ${Object.keys(ENGINES).join(", ")}.`,
      ],
    );
  }

  if (pack.state === "standalone") {
    throw new RunStartError(`${descriptor.displayName} is not installed.`, [
      pack.detail || "No RuntimeFS base.",
      "Runtime packs are RuntimeFS folders, so a standalone deployment cannot have any.",
      "Serve RuntimeCode from RuntimeFS (a /n/<Folder>/ URL) and install the pack there.",
    ]);
  }
  if (pack.state === "error") {
    throw new RunStartError(
      `Could not read the ${descriptor.pack} pack.`,
      [`${pack.base}`, pack.detail || "unknown error"],
    );
  }
  if (pack.state === "missing") {
    throw new RunStartError(`${descriptor.displayName} is not installed.`, [
      `Looked for: ${pack.base} (${pack.detail})`,
      `Assets the pack must carry: ${engine.assets.join(", ")}`,
      `Download size once it exists: ${formatBytes(descriptor.installBytes)}${
        descriptor.installBytesSource === "estimate" ? " (estimated)" : ""
      }`,
      "Nothing to install yet: scripts/packs.mjs builds the packs folder, and it is RUNTIMES.md milestone M2.",
    ]);
  }

  if (pack.missingAssets && pack.missingAssets.length > 0) {
    throw new RunStartError(
      `The ${descriptor.pack} pack is incomplete.`,
      [
        `Missing assets: ${pack.missingAssets.join(", ")}`,
        "Reinstall the pack; a partial install is what an interrupted copy leaves behind.",
      ],
    );
  }

  return engine.createSession(spec, io, pack.manifest || { id: descriptor.pack, version: "unknown" });
}

// ---------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------

const CSI_RESET = "\x1b[0m";
const CSI_DIM = "\x1b[2m";
const CSI_BOLD = "\x1b[1m";
const CSI_RED = "\x1b[31m";
const CSI_GREEN = "\x1b[32m";
const CSI_YELLOW = "\x1b[33m";

/**
 * One run, rendered. `createTerminal({ pty })` is the only terminal a web
 * extension host can make at all -- WorkerExtHostTerminalService.createTerminal
 * throws NotSupportedError without a remote authority, and
 * createExtensionTerminal is not overridden -- so every runtime's output lands
 * here, and the pack never draws its own UI.
 *
 * @implements {vscode.Pseudoterminal}
 */
class RunTerminal {
  /**
   * @param {object} options
   * @param {RuntimeDescriptor} options.descriptor
   * @param {RunSpec} options.spec
   * @param {Negotiated} options.negotiated
   * @param {EnvironmentProbe} options.env
   * @param {(io: SessionIO) => Promise<RuntimeSession>} options.start
   * @param {() => void} options.onClosed
   */
  constructor({ descriptor, spec, negotiated, env, start, onClosed }) {
    this._descriptor = descriptor;
    this._spec = spec;
    this._negotiated = negotiated;
    this._env = env;
    this._start = start;
    this._onClosed = onClosed;

    this._writeEmitter = new vscode.EventEmitter();
    this._closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this._writeEmitter.event;
    this.onDidClose = this._closeEmitter.event;

    /** @type {RuntimeSession | undefined} */
    this._session = undefined;
    /** Input typed before the session existed, replayed once it does. */
    this._pending = "";
    /** The line being edited, echoed by hand: a pty has no line discipline. */
    this._line = "";
    this._closed = false;
    this._warnedNoStdin = false;
    /** @type {vscode.TerminalDimensions | undefined} */
    this._dimensions = undefined;
  }

  /** @param {vscode.TerminalDimensions} [dimensions] */
  open(dimensions) {
    this._dimensions = dimensions;
    this._writeBanner();
    void this._launch();
  }

  close() {
    // Closing the terminal kills the run: a guest with nowhere to write is a
    // leak, not a background job.
    if (this._session) {
      this._session.signal("KILL");
      this._session.dispose();
      this._session = undefined;
    }
    this._closed = true;
  }

  /** @param {string} data */
  handleInput(data) {
    if (this._closed) {
      return;
    }
    // Ctrl+C is a signal, not input, whether or not a session is up yet.
    if (data === "\x03") {
      this._write(`${CSI_DIM}^C${CSI_RESET}\r\n`);
      if (this._session) {
        this._session.signal("INT");
      } else {
        this._exit(EXIT_INTERRUPTED);
      }
      return;
    }
    if (this._negotiated.capabilities.stdin === "none") {
      // Swallowing input silently here would look like a hang; say why once,
      // rather than once per keystroke.
      if (!this._warnedNoStdin) {
        this._warnedNoStdin = true;
        this._write(
          `${CSI_DIM}(this runtime reads no stdin in this deployment)${CSI_RESET}\r\n`,
        );
      }
      return;
    }

    for (const char of data) {
      if (char === "\r") {
        this._write("\r\n");
        this._send(`${this._line}\n`);
        this._line = "";
      } else if (char === "\x7f") {
        if (this._line.length > 0) {
          this._line = this._line.slice(0, -1);
          this._write("\b \b");
        }
      } else if (char === "\x04") {
        // Ctrl+D: end of input, after flushing whatever is half-typed.
        this._send(this._line);
        this._line = "";
        this._send("\x04");
      } else if (char >= " ") {
        this._line += char;
        this._write(char);
      }
    }
  }

  /** @param {vscode.TerminalDimensions} dimensions */
  setDimensions(dimensions) {
    this._dimensions = dimensions;
    if (this._session) {
      this._session.resize(dimensions.columns, dimensions.rows);
    }
  }

  /** Ask the running program to stop, escalating if it will not. */
  interrupt() {
    if (!this._session) {
      this._exit(EXIT_INTERRUPTED);
      return;
    }
    this._session.signal("INT");
    const session = this._session;
    setTimeout(() => {
      if (this._session === session && !this._closed) {
        session.signal("KILL");
      }
    }, 2000);
  }

  // -- internals ------------------------------------------------------------

  async _launch() {
    /** @type {SessionIO} */
    const io = {
      stdout: (text) => this._write(toCrlf(text)),
      stderr: (text) => this._write(`${CSI_RED}${toCrlf(text)}${CSI_RESET}`),
      diag: (text) => this._write(`${CSI_DIM}${toCrlf(text)}${CSI_RESET}\r\n`),
    };

    const startedAt = Date.now();
    try {
      const session = await this._start(io);
      if (this._closed) {
        session.dispose();
        return;
      }
      this._session = session;
      if (this._dimensions) {
        session.resize(this._dimensions.columns, this._dimensions.rows);
      }
      if (this._pending) {
        session.write(this._pending);
        this._pending = "";
      }
      const code = await session.exit;
      this._writeElapsed(startedAt);
      this._exit(code);
    } catch (err) {
      if (err instanceof RunStartError) {
        this._write(`${CSI_RED}${CSI_BOLD}error${CSI_RESET}    ${err.message}\r\n`);
        for (const line of err.detail) {
          this._write(`         ${CSI_DIM}${line}${CSI_RESET}\r\n`);
        }
        this._exit(err.exitCode);
      } else {
        this._write(`${CSI_RED}${CSI_BOLD}error${CSI_RESET}    ${messageOf(err)}\r\n`);
        this._exit(1);
      }
    }
  }

  _writeBanner() {
    const d = this._descriptor;
    const caps = this._negotiated.capabilities;
    const tier = `${d.tier} tier`;

    this._write(
      `${CSI_BOLD}${d.displayName}${CSI_RESET} ${CSI_DIM}· ${tier} · ${d.engine}${
        d.languageVersion ? ` · Python ${d.languageVersion}` : ""
      }${CSI_RESET}\r\n`,
    );
    this._field(
      "env",
      `cross-origin isolated: ${yesNo(this._env.crossOriginIsolated)}   SharedArrayBuffer: ${yesNo(
        this._env.sharedArrayBuffer,
      )}   site: ${d.site}`,
    );
    this._field(
      "limits",
      `stdin: ${caps.stdin}   threads: ${yesNo(caps.threads)}   packages: ${caps.packages}   graphics: ${caps.graphics}`,
    );
    for (const mount of this._spec.mounts) {
      this._field(
        "mount",
        `${mount.guestPath.padEnd(12)}${
          mount.kind === "memory" ? "in memory, discarded at exit" : String(mount.uri)
        }${mount.readOnly ? " (read-only)" : ""}`,
      );
    }
    this._field(
      "entry",
      `${this._spec.entryGuestPath}${
        this._spec.argv.length > 1 ? `   argv: ${JSON.stringify(this._spec.argv.slice(1))}` : ""
      }`,
    );

    if (setting("capabilityNotices", true)) {
      for (const notice of this._negotiated.notices) {
        this._write(`${CSI_YELLOW}note${CSI_RESET}     ${CSI_DIM}${notice}${CSI_RESET}\r\n`);
      }
    }
    this._write("\r\n");
  }

  /**
   * @param {string} label
   * @param {string} value
   */
  _field(label, value) {
    this._write(`${CSI_DIM}${label.padEnd(8)}${CSI_RESET} ${value}\r\n`);
  }

  /** @param {number} startedAt */
  _writeElapsed(startedAt) {
    const seconds = (Date.now() - startedAt) / 1000;
    this._write(`\r\n${CSI_DIM}finished in ${seconds.toFixed(2)}s${CSI_RESET}\r\n`);
  }

  /** @param {string} data */
  _send(data) {
    if (this._session) {
      this._session.write(data);
    } else {
      this._pending += data;
    }
  }

  /** @param {string} text */
  _write(text) {
    if (!this._closed) {
      this._writeEmitter.fire(text);
    }
  }

  /**
   * The exit line goes out before _closed is set, because _write drops
   * everything after that point: a terminal whose last line is missing is how
   * a non-zero exit code gets reported as "it printed nothing".
   *
   * @param {number} code
   */
  _exit(code) {
    if (this._closed) {
      return;
    }
    const colour = code === 0 ? CSI_GREEN : CSI_RED;
    this._write(`${colour}[exit ${code}]${CSI_RESET}\r\n`);
    this._closed = true;
    if (this._session) {
      this._session.dispose();
      this._session = undefined;
    }
    this._closeEmitter.fire(code);
    this._onClosed();
  }
}

// ---------------------------------------------------------------------------
// Building a run
// ---------------------------------------------------------------------------

/**
 * The mount table, and nothing outside it. The guest sees `/workspace` and
 * `/tmp`; no ambient OPFS, no RuntimeFS folder the table does not name.
 *
 * A file opened outside any workspace folder still gets a workspace: its own
 * directory. Running a script that cannot see its siblings is a worse surprise
 * than mounting one directory more than asked.
 *
 * @param {vscode.Uri} [entry]
 * @returns {{ mounts: Mount[], root: vscode.Uri | undefined }}
 */
function buildMounts(entry) {
  const folder = entry
    ? vscode.workspace.getWorkspaceFolder(entry)
    : vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const root = folder
    ? folder.uri
    : entry
      ? vscode.Uri.joinPath(entry, "..")
      : undefined;

  /** @type {Mount[]} */
  const mounts = [];
  if (root) {
    mounts.push({ guestPath: "/workspace", kind: "host", uri: root, readOnly: false });
  }
  mounts.push({ guestPath: "/tmp", kind: "memory", readOnly: false });
  return { mounts, root };
}

/**
 * Guest path for a host file, relative to the `/workspace` mount.
 *
 * @param {vscode.Uri} entry
 * @param {vscode.Uri | undefined} root
 * @returns {string}
 */
function guestPathFor(entry, root) {
  if (!root) {
    return `/tmp/${basename(entry.path)}`;
  }
  const prefix = root.path.endsWith("/") ? root.path : `${root.path}/`;
  if (entry.path.startsWith(prefix)) {
    return `/workspace/${entry.path.slice(prefix.length)}`;
  }
  return `/tmp/${basename(entry.path)}`;
}

/**
 * The dirty-buffer policy, applied identically for every runtime. RUNTIMES.md
 * leaves the choice open and warns that inconsistency here produces bug reports
 * that look like runtime bugs; this is the one place that decides.
 *
 * @param {vscode.Uri | undefined} root
 * @returns {Promise<number>} how many documents were saved
 */
async function applyDirtyBufferPolicy(root) {
  if (setting("dirtyBuffers", "save") !== "save") {
    return 0;
  }
  const prefix = root ? (root.path.endsWith("/") ? root.path : `${root.path}/`) : undefined;
  const dirty = vscode.workspace.textDocuments.filter((document) => {
    if (!document.isDirty || document.isUntitled) {
      return false;
    }
    // Only what the guest could actually read: saving the user's unrelated
    // files because they asked to run a script is overreach.
    return !prefix || document.uri.path.startsWith(prefix);
  });
  let saved = 0;
  for (const document of dirty) {
    if (await document.save()) {
      saved += 1;
    }
  }
  return saved;
}

/**
 * @param {RuntimeDescriptor} descriptor
 * @param {Negotiated} negotiated
 * @param {object} source
 * @param {vscode.Uri} [source.uri]
 * @param {string} [source.text] A selection run, which has no file.
 * @param {string} source.label
 * @returns {Promise<{ spec: RunSpec, saved: number }>}
 */
async function buildRunSpec(descriptor, negotiated, source) {
  const { mounts, root } = buildMounts(source.uri);
  const saved = source.uri ? await applyDirtyBufferPolicy(root) : 0;

  const entryGuestPath = source.uri
    ? guestPathFor(source.uri, root)
    : `/tmp/${source.label}`;

  /** @type {Record<string, string>} */
  const env = {
    HOME: "/tmp",
    TERM: "xterm-256color",
    // Line-buffered output would hold a program's first print until it exits,
    // which reads as a hang in a terminal that only ever shows finished runs.
    PYTHONUNBUFFERED: "1",
    // The workspace mount is writable and is a real RuntimeFS folder; a run
    // should not litter it with __pycache__.
    PYTHONDONTWRITEBYTECODE: "1",
    ...setting("env", /** @type {Record<string, string>} */ ({})),
  };

  return {
    saved,
    spec: {
      runtimeId: descriptor.id,
      entry: source.uri,
      entryGuestPath,
      entrySource: source.text,
      label: source.label,
      argv: [entryGuestPath, ...setting("argv", /** @type {string[]} */ ([]))],
      env,
      cwd: root ? "/workspace" : "/tmp",
      mounts,
      stdinMode: negotiated.capabilities.stdin,
    },
  };
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const output = vscode.window.createOutputChannel("Python (RuntimeCode)");
  const packs = new PackIndex();
  /** @type {Set<RunTerminal>} */
  const running = new Set();

  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.name = "Python runtime";
  status.command = "runtimecode.python.selectRuntime";
  context.subscriptions.push(output, status, { dispose: () => packs.invalidate() });

  /** @returns {RuntimeDescriptor[]} */
  const catalog = () => readCatalog(context.extension.id);

  /**
   * The runtime a run would use: the workspace's remembered choice, then the
   * configured default, then the quick tier. Never a prompt -- Run should run.
   *
   * @returns {RuntimeDescriptor | undefined}
   */
  function currentRuntime() {
    const all = catalog();
    if (all.length === 0) {
      return undefined;
    }
    const remembered = context.workspaceState.get(SELECTED_RUNTIME_KEY);
    const configured = setting("defaultRuntime", "auto");
    const wanted = typeof remembered === "string" ? remembered : configured;
    return all.find((entry) => entry.id === wanted) || all[0];
  }

  /**
   * The status bar item follows the active editor: which Python runtime a run
   * would use is worth a permanent slot next to Python source and nowhere else.
   * The commands stay in the palette either way.
   */
  function refreshStatus() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== LANGUAGE) {
      status.hide();
      return;
    }
    const descriptor = currentRuntime();
    status.text = descriptor
      ? `$(play) Python: ${shortName(descriptor)}`
      : "$(warning) Python: no runtime";
    status.tooltip = descriptor
      ? `${descriptor.displayName} · ${descriptor.tier} tier · ${formatBytes(descriptor.installBytes)}\nClick to pick another runtime.`
      : "No Python runtime is declared.";
    status.show();
  }

  /**
   * One run, from a file or from a selection.
   *
   * @param {object} source
   * @param {vscode.Uri} [source.uri]
   * @param {string} [source.text]
   * @param {string} source.label
   */
  async function run(source) {
    const descriptor = currentRuntime();
    if (!descriptor) {
      vscode.window.showErrorMessage(
        "No Python runtime is available. Install a runtime pack, then reload.",
      );
      return;
    }

    const env = probeEnvironment();
    const negotiated = negotiate(descriptor, env);
    const { spec, saved } = await buildRunSpec(descriptor, negotiated, source);
    const pack = await packs.lookup(descriptor);

    const terminal = new RunTerminal({
      descriptor,
      spec,
      negotiated,
      env,
      start: (io) => {
        if (saved > 0) {
          io.diag(`saved ${saved} unsaved file${saved === 1 ? "" : "s"} before running`);
        }
        return startSession(descriptor, pack, spec, io);
      },
      onClosed: () => running.delete(terminal),
    });
    running.add(terminal);

    const ui = vscode.window.createTerminal({
      name: `${source.label} · ${shortName(descriptor)}`,
      pty: terminal,
      // Restoring a dead run's terminal after a reload would show output from a
      // session that no longer exists.
      isTransient: true,
      iconPath: new vscode.ThemeIcon("play"),
    });
    context.subscriptions.push(ui);
    ui.show(true);
    output.appendLine(
      `run ${spec.entryGuestPath} on ${descriptor.id} (stdin: ${spec.stdinMode}, pack: ${pack.state})`,
    );
  }

  const runFile = vscode.commands.registerCommand(
    "runtimecode.python.run",
    async (/** @type {vscode.Uri | undefined} */ uri) => {
      const target = uri || activePythonUri();
      if (!target) {
        const editor = vscode.window.activeTextEditor;
        vscode.window.showErrorMessage(
          editor && editor.document.isUntitled
            ? "An untitled buffer has no path the guest can read. Save it, or use Python: Run Selection."
            : "Open a Python file to run it.",
        );
        return;
      }
      await run({ uri: target, label: basename(target.path) });
    },
  );

  const runSelection = vscode.commands.registerCommand(
    "runtimecode.python.runSelection",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("Open a Python file to run a selection.");
        return;
      }
      const text = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      if (!text.trim()) {
        vscode.window.showWarningMessage("Nothing to run: the selection is empty.");
        return;
      }
      // A selection has no file, so it runs out of the /tmp mount. Dedenting
      // is deliberately not done here: it is a language concern and the pack
      // that compiles the text is where a decision about it belongs.
      await run({ text, label: "selection.py" });
    },
  );

  const stop = vscode.commands.registerCommand("runtimecode.python.stop", () => {
    if (running.size === 0) {
      vscode.window.showInformationMessage("No Python program is running.");
      return;
    }
    for (const terminal of running) {
      terminal.interrupt();
    }
  });

  const selectRuntime = vscode.commands.registerCommand(
    "runtimecode.python.selectRuntime",
    async () => {
      const all = catalog();
      if (all.length === 0) {
        vscode.window.showErrorMessage("No Python runtime is declared.");
        return;
      }
      const env = probeEnvironment();
      const statuses = await Promise.all(all.map((entry) => packs.lookup(entry)));
      const current = currentRuntime();

      const items = all.map((descriptor, index) => {
        const state = statuses[index];
        const caps = negotiate(descriptor, env).capabilities;
        const installed = state.state === "installed";
        return {
          label: `${tierIcon(descriptor.tier)} ${descriptor.displayName}`,
          description: `${descriptor.tier} · ${formatBytes(descriptor.installBytes)}${
            descriptor.installBytesSource === "estimate" ? "*" : ""
          } · ${installed ? "installed" : "not installed"}${
            current && current.id === descriptor.id ? " · current" : ""
          }`,
          detail: `${descriptor.summary || ""} — Python ${descriptor.languageVersion}, stdin ${caps.stdin}, packages ${caps.packages}`,
          descriptor,
          installed,
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        title: "Select the Python runtime",
        placeHolder: "Sizes marked * are estimates until a pack is built",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) {
        return;
      }

      // The install guardrail: a runtime is the largest and most privileged
      // thing a user installs here, so the size is stated before anything is
      // downloaded rather than after.
      const threshold = setting("installThresholdBytes", 52428800);
      if (!picked.installed && picked.descriptor.installBytes > threshold) {
        const proceed = await vscode.window.showWarningMessage(
          `${picked.descriptor.displayName} needs a ${formatBytes(picked.descriptor.installBytes)} download the first time it runs.`,
          { modal: true },
          "Select anyway",
        );
        if (proceed !== "Select anyway") {
          return;
        }
      }

      await context.workspaceState.update(SELECTED_RUNTIME_KEY, picked.descriptor.id);
      refreshStatus();
    },
  );

  const refresh = vscode.commands.registerCommand(
    "runtimecode.python.refreshRuntimes",
    async () => {
      packs.invalidate();
      const all = catalog();
      const statuses = await Promise.all(all.map((entry) => packs.lookup(entry)));
      const installed = statuses.filter((entry) => entry.state === "installed").length;
      refreshStatus();
      vscode.window.showInformationMessage(
        `${all.length} Python runtime${all.length === 1 ? "" : "s"} declared, ${installed} installed.`,
      );
    },
  );

  const diagnostics = vscode.commands.registerCommand(
    "runtimecode.python.showDiagnostics",
    async () => {
      output.clear();
      for (const line of await buildDiagnostics(catalog(), packs)) {
        output.appendLine(line);
      }
      output.show(true);
    },
  );

  /**
   * The reload every install or uninstall ends with: builtin registration is
   * read once by create(), so a pack is inert until the workbench restarts.
   */
  const offerReload = async () => {
    const action = await vscode.window.showInformationMessage(
      "Reload to load the runtime packs.",
      "Reload",
    );
    if (action === "Reload") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  };

  const installRuntime = vscode.commands.registerCommand(
    "runtimecode.python.installRuntime",
    async () => {
      const base = await packs.base();
      if (!base) {
        vscode.window.showErrorMessage(
          "RuntimeCode is not being served from RuntimeFS, so there is no packs folder to install from.",
        );
        return;
      }
      const catalogEntries = await fetchCatalog(packs);
      if (!catalogEntries || catalogEntries.length === 0) {
        vscode.window.showErrorMessage(
          `No pack catalog found at ${base}catalog.json. Build one with: node scripts/packs.mjs --build`,
        );
        return;
      }
      const registry = await readPacksRegistry();
      const items = catalogEntries.map((entry) => ({
        label: `${tierIcon(entry.tier || "quick")} ${entry.descriptor?.displayName || entry.id}`,
        description: `${formatBytes(entry.installBytes || 0)} · ${
          registry.packs[entry.id] ? "installed" : "not installed"
        }`,
        detail: `${entry.summary || ""} — ${entry.license}`,
        entry,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "Install a runtime pack",
        placeHolder: "Bytes are the verified build output, not an estimate",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked || registry.packs[picked.entry.id]) {
        return;
      }

      const threshold = setting("installThresholdBytes", 52428800);
      if ((picked.entry.installBytes || 0) > threshold) {
        const proceed = await vscode.window.showWarningMessage(
          `${picked.entry.descriptor?.displayName || picked.entry.id} needs a ${formatBytes(
            picked.entry.installBytes || 0,
          )} download.`,
          { modal: true },
          "Install anyway",
        );
        if (proceed !== "Install anyway") {
          return;
        }
      }

      const packsFolder = setting("packsFolder", "RC-Packs");
      try {
        await installPack(picked.entry, base, packsFolder);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not install ${picked.entry.id}: ${messageOf(err)}`,
        );
        return;
      }
      packs.invalidate();
      await offerReload();
    },
  );

  const uninstallRuntime = vscode.commands.registerCommand(
    "runtimecode.python.uninstallRuntime",
    async () => {
      const registry = await readPacksRegistry();
      const installed = Object.entries(registry.packs);
      if (installed.length === 0) {
        vscode.window.showInformationMessage("No runtime packs are installed.");
        return;
      }
      const items = installed.map(([id, meta]) => ({
        label: id,
        description: meta.version,
        id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: "Uninstall a runtime pack",
        placeHolder: "The pack's files are removed from OPFS and it stops being registered",
      });
      if (!picked) {
        return;
      }
      const packsFolder = setting("packsFolder", "RC-Packs");
      try {
        await uninstallPack(picked.id, packsFolder);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not uninstall ${picked.id}: ${messageOf(err)}`,
        );
        return;
      }
      packs.invalidate();
      await offerReload();
    },
  );

  const cleanupPacks = vscode.commands.registerCommand(
    "runtimecode.python.cleanupPacks",
    async () => {
      const packsFolder = setting("packsFolder", "RC-Packs");
      const orphaned = await cleanupPacksFolder(packsFolder);
      if (orphaned.length === 0) {
        vscode.window.showInformationMessage(
          "No orphaned pack folders found. Every folder in the packs folder is registered.",
        );
        return;
      }
      packs.invalidate();
      await vscode.window.showInformationMessage(
        `Removed ${orphaned.length} orphaned pack folder${orphaned.length === 1 ? "" : "s"}: ${orphaned.join(", ")}`,
      );
    },
  );

  const onConfigChanged = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`${CONFIG_SECTION}.packsFolder`)) {
      packs.invalidate();
    }
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      refreshStatus();
    }
  });

  // The status bar item is only useful where Python is: showing "Python:
  // Pyodide" beside a Markdown file is noise.
  const onEditorChanged = vscode.window.onDidChangeActiveTextEditor(() =>
    refreshStatus(),
  );

  context.subscriptions.push(
    runFile,
    runSelection,
    stop,
    selectRuntime,
    refresh,
    diagnostics,
    installRuntime,
    uninstallRuntime,
    cleanupPacks,
    onConfigChanged,
    onEditorChanged,
  );

  refreshStatus();
  output.appendLine(
    `Python host active. Runtimes: ${catalog().map((entry) => entry.id).join(", ") || "none"}.`,
  );
}

/**
 * The report that answers "why did my program not run", in one place: what this
 * deployment can do, what each runtime claims, what it would actually get here,
 * and where its bytes were looked for.
 *
 * @param {RuntimeDescriptor[]} catalog
 * @param {PackIndex} packs
 * @returns {Promise<string[]>}
 */
async function buildDiagnostics(catalog, packs) {
  const env = probeEnvironment();
  const base = await packs.base();
  const lines = [
    "Python (RuntimeCode) diagnostics",
    "",
    "Environment",
    `  cross-origin isolated : ${yesNo(env.crossOriginIsolated)}`,
    `  SharedArrayBuffer     : ${yesNo(env.sharedArrayBuffer)}`,
    `  best stdin tier       : ${env.bestStdin}`,
    `  packs folder          : ${base || "none (RuntimeCode is served standalone)"}`,
    "",
  ];

  for (const descriptor of catalog) {
    const status = await packs.lookup(descriptor);
    const { capabilities, notices } = negotiate(descriptor, env);
    const engine = ENGINES[descriptor.engine];
    lines.push(
      `${descriptor.displayName}  [${descriptor.id}]`,
      `  tier      : ${descriptor.tier}`,
      `  engine    : ${descriptor.engine}  (Python ${descriptor.languageVersion}, site ${descriptor.site})`,
      `  declared  : ${descriptor.extensionId}`,
      `  license   : ${descriptor.license || "unstated"}`,
      `  size      : ${formatBytes(descriptor.installBytes)}${
        descriptor.installBytesSource === "estimate" ? " (estimate)" : ""
      }`,
      `  pack      : ${status.state}${status.base ? ` at ${status.base}` : ""}${
        status.detail ? ` (${status.detail})` : ""
      }`,
      `  effective : stdin ${capabilities.stdin}, threads ${yesNo(capabilities.threads)}, packages ${capabilities.packages}, graphics ${capabilities.graphics}, fs ${capabilities.fs}`,
    );
    if (status.missingAssets && status.missingAssets.length > 0) {
      lines.push(`  missing   : ${status.missingAssets.join(", ")}`);
    }
    for (const notice of notices) {
      lines.push(`  note      : ${notice}`);
    }
    if (engine) {
      lines.push(`  assets    : ${engine.assets.join(", ")}`);
      for (const note of engine.notes) {
        lines.push(`  engine    : ${note}`);
      }
    }
    lines.push("");
  }

  lines.push(
    "No runtime packs ship with this build. The host is RUNTIMES.md milestone M1;",
    "the pack pipeline that would install one is M2.",
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @returns {vscode.Uri | undefined} */
function activePythonUri() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  // Untitled documents have no storage a guest could read, and the mount table
  // is the only way in. Run Selection is the path for unsaved text.
  return editor.document.isUntitled ? undefined : editor.document.uri;
}

/** @param {string} path */
function basename(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? decodeURIComponent(parts[parts.length - 1]) : "program.py";
}

/** @param {RuntimeDescriptor} descriptor */
function shortName(descriptor) {
  const match = /\(([^)]+)\)/.exec(descriptor.displayName);
  return match ? match[1] : descriptor.displayName;
}

/** @param {Tier} tier */
function tierIcon(tier) {
  return tier === "faithful" ? "$(verified)" : tier === "tiny" ? "$(zap)" : "$(rocket)";
}

/** @param {boolean} value */
function yesNo(value) {
  return value ? "yes" : "no";
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "size unknown";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A pty writes to a terminal, not to a file: a bare newline leaves the cursor
 * in the column it was in, so output arrives as a staircase.
 *
 * @param {string} text
 */
function toCrlf(text) {
  return text.replace(/\r?\n/g, "\r\n");
}

/** @param {unknown} err */
function messageOf(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function deactivate() {
  // Terminals, commands and the status bar item are all in
  // context.subscriptions. A run that is still going dies with the extension
  // host, which is the same worker this file runs in.
}

module.exports = {
  activate,
  deactivate,
  // Internals the test harness reaches for; not a public API.
  __internals: {
    readCatalog,
    probeEnvironment,
    negotiate,
    buildMounts,
    guestPathFor,
    formatBytes,
    ENGINES,
    installPack,
    uninstallPack,
    cleanupPacksFolder,
    fetchCatalog,
    readPacksRegistry,
  },
};
