/*---------------------------------------------------------------------------------------------
 *  RuntimeCode: Lua runtime pack (wasmoon)
 *
 *  Brings Lua 5.4 to the runtime host. The interpreter is wasmoon 1.16.0
 *  (MIT), the official Lua VM compiled to WebAssembly with a JS bridge, and
 *  its two assets are vendored under assets/ with digests in pack.json rather
 *  than fetched from a CDN at run time.
 *
 *  The pack declares site: "host", which means the guest runs in the extension
 *  host worker itself rather than in a nested worker. The host already is a
 *  worker with no DOM, so the sandbox boundary is still "the wasm module plus
 *  the mount table"; a nested-worker site is for packs that need threads or a
 *  plotting surface, and wasmoon needs neither.
 *
 *  What it implements from the contract, honestly:
 *    stdout         print() is wired to the terminal
 *    stderr         warn() and Lua errors go to the terminal
 *    exit          0 on success, 1 on a Lua error or an unreadable entry
 *    stdin         none: wasmoon exposes no blocking read, so io.read is not
 *                  advertised. The host is told so in package.json.
 *
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

// The web extension host loads this file by wrapping it in
// `new Function('module','exports','require', src)`, so it stays a single,
// dependency-free CommonJS file. The wasmoon UMD is loaded as a string asset
// for the same reason: there is no bundler and require resolves only 'vscode'.
const vscode = require("vscode");

const WASMOON_JS = "assets/wasmoon-1.16.0.js";
const GLUE_WASM = "assets/glue-1.16.0.wasm";

/**
 * @typedef {object} RunSpec
 * @property {string} runtimeId
 * @property {vscode.Uri} entry
 *
 * @typedef {object} SessionIO
 * @property {(data: string) => void} stdout
 * @property {(data: string) => void} stderr
 * @property {(data: string) => void} diag
 * @property {(capabilities: Record<string, unknown>) => void} ready
 *
 * @typedef {object} Session
 * @property {(data: string) => void} write
 * @property {(signal: "INT"|"KILL") => void} signal
 * @property {(columns: number, rows: number) => void} resize
 * @property {() => void} dispose
 * @property {Promise<number>} exit
 */

/** The host extension URI, captured in activate(); asset URLs are built from it. */
/** @type {vscode.Uri | undefined} */
let extensionUri;

/**
 * Function parameters shadow globals inside `new Function`, which is the only
 * way to run the wasmoon UMD outside a browser. Tests pass the worker-shaped
 * globals it expects (location, self, importScripts, fetch) through here.
 * Production leaves this empty, so the glue sees the worker's real globals.
 *
 * @type {Record<string, unknown>}
 */
let environment = {};

/** @param {Record<string, unknown>} overrides */
function setEnvironment(overrides) {
  environment = overrides;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  extensionUri = context.extensionUri;
}

function deactivate() {}

/**
 * @param {string} relative
 * @returns {string}
 */
function assetUrl(relative) {
  if (!extensionUri) {
    throw new Error("lua-wasmoon was activated without an extension URI.");
  }
  return vscode.Uri.joinPath(extensionUri, relative).toString();
}

/** @type {Promise<any> | undefined} */
let wasmoonPromise;

/**
 * Fetches and evaluates the UMD once per activation. A failed load is not
 * cached, so a transient fetch failure does not poison every later run.
 *
 * @returns {Promise<any>}
 */
async function loadWasmoon() {
  if (!wasmoonPromise) {
    wasmoonPromise = (async () => {
      const response = await fetch(assetUrl(WASMOON_JS));
      if (!response.ok) {
        throw new Error(
          `Could not fetch ${WASMOON_JS}: HTTP ${response.status}.`,
        );
      }
      const source = await response.text();
      const names = Object.keys(environment);
      const factory = new Function("module", "exports", ...names, source);
      const module = { exports: {} };
      factory(module, module.exports, ...names.map((name) => environment[name]));
      const wasmoon = module.exports;
      if (!wasmoon || typeof wasmoon.LuaFactory !== "function") {
        throw new Error("wasmoon did not initialize (no LuaFactory export).");
      }
      return wasmoon;
    })().catch((error) => {
      wasmoonPromise = undefined;
      throw error;
    });
  }
  return wasmoonPromise;
}

/**
 * Lua's print uses tostring, where nil is a value and not the string "null".
 *
 * @param {unknown} value
 * @returns {string}
 */
function luaString(value) {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One engine per session, discarded at exit. The engine owns its Lua state,
 * so two runs cannot see each other's globals, and the host's mount table is
 * the only way in or out.
 *
 * @param {RunSpec} spec
 * @param {SessionIO} io
 * @returns {Promise<Session>}
 */
async function createSession(spec, io) {
  const wasmoon = await loadWasmoon();
  const factory = new wasmoon.LuaFactory(assetUrl(GLUE_WASM));
  const engine = await factory.createEngine();

  engine.global.set("print", (.../** @type {unknown[]} */ args) => {
    io.stdout(args.map(luaString).join("\t") + "\n");
  });
  engine.global.set("warn", (.../** @type {unknown[]} */ args) => {
    io.stderr(args.map(luaString).join("\t") + "\n");
  });

  const close = () => {
    try {
      engine.global.close();
    } catch {
      // Already closed; close is the only cleanup wasmoon exposes.
    }
  };

  const exit = (async () => {
    let source;
    try {
      const bytes = await vscode.workspace.fs.readFile(spec.entry);
      source = new TextDecoder().decode(bytes);
    } catch (error) {
      io.stderr(`Could not read ${spec.entry.toString()}: ${messageOf(error)}\n`);
      close();
      return 1;
    }
    try {
      await engine.doString(source);
      return 0;
    } catch (error) {
      io.stderr(`${messageOf(error)}\n`);
      return 1;
    } finally {
      close();
    }
  })();

  return {
    // stdin is "none" in the contribution: there is no blocking read to drive.
    write() {},
    signal() {},
    resize() {},
    dispose() {
      close();
    },
    exit,
  };
}

module.exports = { activate, deactivate, createSession };
