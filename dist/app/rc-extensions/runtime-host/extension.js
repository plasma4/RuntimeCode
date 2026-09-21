/*---------------------------------------------------------------------------------------------
 *  RuntimeCode: runtime host
 *
 *  The one extension a user talks to: it discovers runtime packs, owns the Run
 *  command and the terminal, and hands the guest a mount table. Packs own the
 *  language; the host owns everything the user sees. See RUNTIMES.md for the
 *  contract and the milestones. This is M1: one Run command, one pseudoterminal,
 *  exit codes propagated. Install, the catalog and cleanup are M2.
 *
 *  A runtime pack declares itself in its own package.json:
 *
 *    "contributes": {
 *      "runtimecode.runtimes": [{ "id": "...", "tier": "quick", ... }]
 *    }
 *
 *  and exports `createSession(spec, io)` from its activation. The host never
 *  loads a pack until a runtime is chosen, and only calls activate() at that
 *  point: RUNTIMES.md "The provider contract".
 *
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

// The web extension host loads this file by wrapping it in
// `new Function('module','exports','require', src)` (extHostExtensionService.ts),
// so it has to stay a single, dependency-free CommonJS file. Only 'vscode'
// resolves; there is no bundler here.
const vscode = require("vscode");

/** The manifest key a runtime pack contributes itself under. */
const CONTRIBUTION_KEY = "runtimecode.runtimes";
/** All of this extension's settings live under one section. */
const CONFIG_SECTION = "runtimecode.runtime";
const OUTPUT_NAME = "Runtime Host";
/** Last runtime picked, so Run does not ask every time. */
const LAST_RUNTIME_KEY = "runtimecode.runtime.last";

const TIERS = ["quick", "faithful"];
const SITES = ["worker", "webview", "window", "host"];
const STDIN_MODES = ["none", "buffered", "blocking"];

/**
 * @typedef {object} ExtensionLike
 * @property {string} id
 * @property {{ contributes?: Record<string, unknown> }} [packageJSON]
 *
 * @typedef {object} Capabilities
 * @property {"none"|"buffered"|"blocking"} [stdin]
 * @property {boolean} [threads]
 * @property {string} [packages]
 * @property {boolean|string} [graphics]
 * @property {boolean} [debug]
 * @property {string} [fs]
 *
 * @typedef {object} RuntimeEntry
 * @property {string} id
 * @property {string} displayName
 * @property {string} [description]
 * @property {string[]} languages
 * @property {"quick"|"faithful"} tier
 * @property {string} [engine]
 * @property {string} [languageVersion]
 * @property {"worker"|"webview"|"window"|"host"} site
 * @property {string} worker
 * @property {string} [assets]
 * @property {number} [installBytes]
 * @property {{ crossOriginIsolated?: boolean }} [requires]
 * @property {Capabilities} [capabilities]
 *
 * @typedef {RuntimeEntry & { extensionId: string }} Runtime
 *
 * @typedef {{ path: string, uri?: vscode.Uri, memory?: boolean }} Mount
 *
 * @typedef {object} RunSpec
 * @property {string} runtimeId
 * @property {vscode.Uri} entry
 * @property {string[]} argv
 * @property {Record<string, string>} env
 * @property {vscode.Uri} cwd
 * @property {Mount[]} mounts
 * @property {"none"|"buffered"|"blocking"} stdinMode
 *
 * @typedef {object} Session
 * @property {(data: string) => void} write
 * @property {(signal: "INT"|"KILL") => void} signal
 * @property {(columns: number, rows: number) => void} resize
 * @property {() => void} dispose
 * @property {Promise<number>} exit
 *
 * @typedef {object} SessionIO
 * @property {(data: string) => void} stdout
 * @property {(data: string) => void} stderr
 * @property {(data: string) => void} diag
 * @property {(capabilities: Capabilities) => void} ready
 *
 * @typedef {object} Provider
 * @property {(spec: RunSpec, io: SessionIO) => Promise<Session>} createSession
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Everything wrong with one contribution, as sentences a human can act on.
 * Empty means it is usable. Validating here rather than at Run time is what
 * keeps a malformed pack from failing after the user has already committed to
 * it.
 *
 * @param {string} extensionId
 * @param {unknown} entry
 * @returns {string[]}
 */
function runtimeProblems(extensionId, entry) {
  if (entry === null || typeof entry !== "object") {
    return [`${extensionId}: a runtimecode.runtimes entry is not an object.`];
  }
  const record = /** @type {Record<string, unknown>} */ (entry);
  const id = typeof record.id === "string" ? record.id : "(no id)";
  const where = `${extensionId} ${id}`;
  /** @type {string[]} */
  const problems = [];

  if (typeof record.id !== "string" || !record.id) {
    problems.push(`${where}: needs a non-empty string id.`);
  }
  if (typeof record.displayName !== "string" || !record.displayName) {
    problems.push(`${where}: needs a non-empty string displayName.`);
  }
  if (
    !Array.isArray(record.languages) ||
    record.languages.length === 0 ||
    !record.languages.every((language) => typeof language === "string")
  ) {
    problems.push(`${where}: languages has to be a non-empty array of strings.`);
  }
  if (typeof record.tier !== "string" || !TIERS.includes(record.tier)) {
    problems.push(`${where}: tier has to be one of ${TIERS.join(", ")}.`);
  }
  const site = typeof record.site === "string" ? record.site : undefined;
  if (site === undefined || !SITES.includes(site)) {
    problems.push(`${where}: site has to be one of ${SITES.join(", ")}.`);
  }
  if (site !== "host" && (typeof record.worker !== "string" || !record.worker)) {
    problems.push(
      `${where}: needs a worker entry point (only site "host" runs without one).`,
    );
  }
  if (
    record.installBytes !== undefined &&
    (typeof record.installBytes !== "number" || record.installBytes < 0)
  ) {
    problems.push(`${where}: installBytes has to be a non-negative number.`);
  }
  const stdin = capabilityOf(record, "stdin");
  if (stdin !== undefined && !STDIN_MODES.includes(stdin)) {
    problems.push(
      `${where}: capabilities.stdin has to be one of ${STDIN_MODES.join(", ")}.`,
    );
  }
  return problems;
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {string | undefined}
 */
function capabilityOf(record, key) {
  const capabilities = record.capabilities;
  if (capabilities === null || typeof capabilities !== "object") {
    return undefined;
  }
  const value = /** @type {Record<string, unknown>} */ (capabilities)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Scans what the extension host has, the same scan RUNTIMES.md describes: the
 * manifest costs nothing to read and activate() only happens when a runtime is
 * chosen. Duplicate ids are a problem, not a last-one-wins.
 *
 * @param {readonly ExtensionLike[]} extensions
 * @returns {{ runtimes: Runtime[], problems: string[] }}
 */
function collectRuntimes(extensions) {
  /** @type {Runtime[]} */
  const runtimes = [];
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();

  for (const extension of extensions) {
    const contributes = extension.packageJSON?.contributes;
    const entries = contributes ? contributes[CONTRIBUTION_KEY] : undefined;
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      problems.push(
        `${extension.id}: contributes.${CONTRIBUTION_KEY} has to be an array.`,
      );
      continue;
    }
    for (const entry of entries) {
      const entryProblems = runtimeProblems(extension.id, entry);
      if (entryProblems.length) {
        problems.push(...entryProblems);
        continue;
      }
      const runtime = /** @type {Runtime} */ ({
        .../** @type {RuntimeEntry} */ (entry),
        extensionId: extension.id,
      });
      if (seen.has(runtime.id)) {
        problems.push(
          `${extension.id}: runtime id ${runtime.id} is already provided by another extension.`,
        );
        continue;
      }
      seen.add(runtime.id);
      runtimes.push(runtime);
    }
  }
  return { runtimes, problems };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * @param {number} [bytes]
 * @returns {string}
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "size unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * One line of capability facts, the ones RUNTIMES.md says to advertise rather
 * than let the user discover by hanging.
 *
 * @param {Capabilities} [capabilities]
 * @returns {string}
 */
function capabilitySummary(capabilities) {
  /** @type {string[]} */
  const parts = [];
  parts.push(`stdin: ${capabilities?.stdin ?? "none"}`);
  parts.push(`threads: ${capabilities?.threads ? "yes" : "no"}`);
  if (capabilities?.packages) {
    parts.push(`packages: ${capabilities.packages}`);
  }
  if (capabilities?.graphics && capabilities.graphics !== "none") {
    parts.push(`graphics: ${capabilities.graphics}`);
  }
  return parts.join(" · ");
}

/**
 * @param {Runtime} runtime
 * @returns {string}
 */
function runtimeDetail(runtime) {
  return [
    runtime.engine,
    formatBytes(runtime.installBytes),
    capabilitySummary(runtime.capabilities),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The runtime ids a file's language can use. Falls back to every runtime when
 * nothing matches, so a pack that declares languages differently is still
 * reachable.
 *
 * @param {readonly Runtime[]} runtimes
 * @param {string} languageId
 * @returns {Runtime[]}
 */
function runtimesFor(runtimes, languageId) {
  const matching = runtimes.filter((runtime) =>
    runtime.languages.includes(languageId),
  );
  return matching.length ? matching : [...runtimes];
}

/**
 * @typedef {vscode.QuickPickItem & { runtime: Runtime }} RuntimePickItem
 *
 * @param {readonly Runtime[]} runtimes
 * @param {string} placeHolder
 * @returns {Promise<Runtime | undefined>}
 */
async function pickRuntime(runtimes, placeHolder) {
  /** @type {RuntimePickItem[]} */
  const items = runtimes.map((runtime) => ({
    label: runtime.displayName,
    description: `${runtime.tier} · ${runtime.languages.join(", ")}`,
    detail: runtimeDetail(runtime),
    runtime,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Select a runtime",
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.runtime;
}

/**
 * Default setting, then last used, then the only candidate, then ask.
 *
 * @param {readonly Runtime[]} runtimes
 * @param {string} languageId
 * @param {string} preferredId
 * @returns {Promise<Runtime | undefined>}
 */
async function chooseRuntime(runtimes, languageId, preferredId) {
  const candidates = runtimesFor(runtimes, languageId);
  const preferred = candidates.find((runtime) => runtime.id === preferredId);
  if (preferred) {
    return preferred;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  return pickRuntime(candidates, `Pick a runtime for ${languageId}`);
}

// ---------------------------------------------------------------------------
// Capabilities and isolation
// ---------------------------------------------------------------------------

/** @returns {boolean} */
function isCrossOriginIsolated() {
  return typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false;
}

/**
 * A runtime is most privileged thing a user can install here, so a missing
 * capability is a named error, never a silent degradation. RUNTIMES.md
 * "Advertise what each runtime cannot do" and "Make missing isolation a named
 * error".
 *
 * @param {Runtime} runtime
 * @param {boolean} isolated
 * @returns {string | undefined}
 */
function isolationRequired(runtime, isolated) {
  if (isolated || runtime.requires?.crossOriginIsolated !== true) {
    return undefined;
  }
  return (
    `${runtime.displayName} requires cross-origin isolation, which this ` +
    `RuntimeFS folder does not have. Enable "runtimecode.sameOrigin.enabled" ` +
    `for the folder RuntimeCode is served from, or pick another runtime.`
  );
}

/**
 * @param {Runtime} runtime
 * @param {boolean} isolated
 * @returns {{ mode: "none"|"buffered"|"blocking", note?: string }}
 */
function stdinMode(runtime, isolated) {
  const requested = runtime.capabilities?.stdin ?? "none";
  if (requested !== "blocking" || isolated) {
    return { mode: requested };
  }
  return {
    mode: "buffered",
    note:
      "stdin: buffered. Blocking input needs cross-origin isolation; enable " +
      '"runtimecode.sameOrigin.enabled" and reload to get real line blocking.',
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * The terminal side of a session. Output arriving before the terminal has
 * opened is buffered, because firing into a closed emitter would lose it.
 */
class RuntimePty {
  /** @type {vscode.EventEmitter<string>} */
  writeEmitter;
  /** @type {vscode.EventEmitter<number | void>} */
  closeEmitter;
  /** @type {vscode.Event<string>} */
  onDidWrite;
  /** @type {vscode.Event<number | void>} */
  onDidClose;
  /** @type {((data: string) => void) | undefined} */
  onInput;
  /** @type {((dimensions: vscode.TerminalDimensions) => void) | undefined} */
  onResize;
  /** @type {(() => void) | undefined} */
  onClose;
  /** @type {string[]} */
  pending = [];
  opened = false;
  closed = false;

  /** @param {string} name */
  constructor(name) {
    this.name = name;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
  }

  /** @param {vscode.TerminalDimensions | undefined} _dimensions */
  open(_dimensions) {
    this.opened = true;
    for (const chunk of this.pending) {
      this.writeEmitter.fire(chunk);
    }
    this.pending = [];
  }

  /** @param {string} text */
  write(text) {
    if (this.closed) {
      return;
    }
    if (!this.opened) {
      this.pending.push(text);
      return;
    }
    this.writeEmitter.fire(text);
  }

  /** @param {string} data */
  handleInput(data) {
    this.onInput?.(data);
  }

  /** @param {vscode.TerminalDimensions} dimensions */
  setDimensions(dimensions) {
    this.onResize?.(dimensions);
  }

  /**
   * Called both by VS Code (user closed the terminal) and by the exit handler.
   * The closed flag keeps it to one close, and the close flag keeps onClose
   * from disposing a session that has already exited.
   *
   * @param {number | undefined} [code]
   */
  close(code) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose?.();
    this.closeEmitter.fire(code);
  }

  dispose() {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

/**
 * @param {Runtime} runtime
 * @param {vscode.TextDocument} document
 * @param {readonly vscode.WorkspaceFolder[] | undefined} folders
 * @param {"none"|"buffered"|"blocking"} mode
 * @returns {RunSpec}
 */
function specFor(runtime, document, folders, mode) {
  const folder = folders?.[0];
  /** @type {Mount[]} */
  const mounts = [{ path: "/tmp", memory: true }];
  if (folder) {
    mounts.unshift({ path: "/workspace", uri: folder.uri });
  }
  return {
    runtimeId: runtime.id,
    entry: document.uri,
    argv: [],
    env: {},
    cwd: folder ? folder.uri : document.uri,
    mounts,
    stdinMode: mode,
  };
}

/**
 * @param {Runtime} runtime
 * @returns {Promise<Provider>}
 */
async function activateProvider(runtime) {
  const extension = vscode.extensions.getExtension(runtime.extensionId);
  if (!extension) {
    throw new Error(
      `Runtime pack ${runtime.id} (${runtime.extensionId}) is not installed.`,
    );
  }
  const exports = await extension.activate();
  if (!exports || typeof exports.createSession !== "function") {
    throw new Error(
      `Runtime pack ${runtime.displayName} does not export createSession().`,
    );
  }
  return exports;
}

/**
 * @param {RuntimePty} pty
 * @param {vscode.OutputChannel} output
 * @param {Runtime} runtime
 * @returns {SessionIO}
 */
function sessionIO(pty, output, runtime) {
  return {
    stdout: (data) => pty.write(String(data)),
    stderr: (data) => pty.write(String(data)),
    diag: (data) => output.appendLine(`[${runtime.id}] ${String(data)}`),
    ready: (capabilities) => {
      const requested = runtime.capabilities?.stdin ?? "none";
      const actual = capabilities?.stdin;
      if (actual && actual !== requested) {
        pty.write(
          `\r\nstdin: ${actual} (${runtime.displayName} implements less than it declares)\r\n`,
        );
      }
    },
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {Runtime} runtime
 * @param {vscode.TextEditor} editor
 * @param {{ context: vscode.ExtensionContext, output: vscode.OutputChannel }} host
 */
async function runWith(runtime, editor, host) {
  const { context, output } = host;
  const isolated = isCrossOriginIsolated();

  const required = isolationRequired(runtime, isolated);
  if (required) {
    output.appendLine(`[run] refused ${runtime.id}: ${required}`);
    vscode.window.showWarningMessage(required);
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty);
  if (dirty.length) {
    if (config.get("saveBeforeRun", true)) {
      await vscode.workspace.saveAll(false);
    } else {
      output.appendLine(
        "[run] runtimecode.runtime.saveBeforeRun is off; running the last saved contents",
      );
    }
  }

  const { mode, note } = stdinMode(runtime, isolated);
  const spec = specFor(runtime, editor.document, vscode.workspace.workspaceFolders, mode);

  const pty = new RuntimePty(runtime.displayName);
  const terminal = vscode.window.createTerminal({
    name: runtime.displayName,
    pty,
    isTransient: true,
  });
  pty.write(`RuntimeCode: ${runtime.displayName} (${runtime.tier})\r\n`);
  if (note) {
    pty.write(`${note}\r\n`);
  }

  let session;
  try {
    const provider = await activateProvider(runtime);
    session = await provider.createSession(spec, sessionIO(pty, output, runtime));
  } catch (error) {
    pty.write(`\r\nCould not start ${runtime.displayName}: ${messageOf(error)}\r\n`);
    pty.close(1);
    terminal.show();
    return;
  }

  pty.onInput = (data) => session.write(data);
  pty.onResize = (dimensions) =>
    session.resize(dimensions.columns, dimensions.rows);
  pty.onClose = () => session.dispose();

  terminal.show();
  await context.globalState.update(LAST_RUNTIME_KEY, runtime.id);

  session.exit.then(
    (code) => {
      pty.write(`\r\n[exited with code ${code}]\r\n`);
      pty.close(code);
    },
    (error) => {
      pty.write(`\r\n[runtime error: ${messageOf(error)}]\r\n`);
      pty.close(1);
    },
  );
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const output = vscode.window.createOutputChannel(OUTPUT_NAME);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = "Runtime Host";
  status.command = "runtimecode.pickRuntime";
  context.subscriptions.push(output, status);

  /** @type {Runtime[]} */
  let runtimes = [];

  /** @returns {readonly Runtime[]} */
  const refresh = () => {
    const collected = collectRuntimes(vscode.extensions.all);
    runtimes = collected.runtimes;
    for (const problem of collected.problems) {
      output.appendLine(`[registry] ${problem}`);
    }
    if (runtimes.length) {
      const lastId = context.globalState.get(LAST_RUNTIME_KEY, "");
      const last = runtimes.find((runtime) => runtime.id === lastId) ?? runtimes[0];
      status.text = "$(play) Run";
      status.tooltip = `Run with ${last.displayName}`;
    } else {
      status.text = "$(play) No runtime";
      status.tooltip = "No runtime packs are installed. See RUNTIMES.md.";
    }
    status.show();
    return runtimes;
  };

  refresh();

  const runCommand = vscode.commands.registerCommand("runtimecode.run", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open a file to run.");
      return;
    }
    const available = runtimes.length ? runtimes : [...refresh()];
    if (!available.length) {
      vscode.window.showWarningMessage(
        "No runtime packs are installed. See RUNTIMES.md to add one.",
      );
      return;
    }
    const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get("default", "");
    const lastId = context.globalState.get(LAST_RUNTIME_KEY, "");
    const runtime = await chooseRuntime(
      available,
      editor.document.languageId,
      configured || lastId,
    );
    if (!runtime) {
      return;
    }
    await runWith(runtime, editor, { context, output });
  });

  const pickCommand = vscode.commands.registerCommand("runtimecode.pickRuntime", async () => {
    const available = runtimes.length ? runtimes : [...refresh()];
    if (!available.length) {
      vscode.window.showWarningMessage(
        "No runtime packs are installed. See RUNTIMES.md to add one.",
      );
      return;
    }
    const picked = await pickRuntime(available, "Nothing to run yet; this only picks a default.");
    if (!picked) {
      return;
    }
    await context.globalState.update(LAST_RUNTIME_KEY, picked.id);
    vscode.window.showInformationMessage(`Selected ${picked.displayName}.`);
  });

  const showCommand = vscode.commands.registerCommand("runtimecode.showRuntimes", () => {
    refresh();
    if (!runtimes.length) {
      output.appendLine("No runtime packs are installed. See RUNTIMES.md.");
    }
    for (const runtime of runtimes) {
      output.appendLine(
        `${runtime.id} — ${runtime.displayName} (${runtime.tier}) · ` +
          `${runtime.languages.join(", ")} · ${runtimeDetail(runtime)}`,
      );
    }
    output.show();
  });

  const onExtensionsChanged = vscode.extensions.onDidChange(refresh);

  context.subscriptions.push(runCommand, pickCommand, showCommand, onExtensionsChanged);
}

function deactivate() {
  // context.subscriptions has everything; the sessions belong to their terminals.
}

module.exports = { activate, deactivate };
