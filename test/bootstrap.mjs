/**
 * Loads the module script out of static/index.html the way the browser runs it:
 * as source text, with the globals it reaches for passed in as parameters so
 * the fakes cannot leak between tests.
 *
 * One substitution, and only one. `await import('./out/vs/...')` would resolve
 * against this file and fail, and the bundle it names is a quarter of a
 * gigabyte of build output with no bearing on anything here. Everything else is
 * the shipped text, including the embedder command table, which is the point:
 * those six handlers are the entire bridge between the extension host worker
 * and the window, and nothing else in the suite touches them.
 *
 * The file is a template, so `data-settings` still holds {{WORKBENCH_WEB_
 * CONFIGURATION}} on disk. The stub below supplies what staticify.mjs
 * substitutes in its place.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const INDEX = path.join(RC_ROOT, "static", "index.html");

/**
 * @param {object} [options]
 * @param {string} [options.href] where the workbench is being served from
 * @param {string} [options.controllerScript] scriptURL of the service worker
 *   controlling the page, if any
 * @param {boolean} [options.serviceWorkers] false for a browser without them
 */
export async function loadBootstrap({
  href = "https://example.org/fs/n/RC/",
  controllerScript = undefined,
  serviceWorkers = true,
} = {}) {
  const html = readFileSync(INDEX, "utf8");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("no inline module script in static/index.html");
  }
  const source = match[1].replace(/await import\([^)]*\)/, "__workbench");
  if (source === match[1]) {
    throw new Error(
      "the workbench import moved; this harness replaces it by shape",
    );
  }

  const url = new URL(href);
  const window = {
    location: {
      href,
      search: url.search,
      origin: url.origin,
      pathname: url.pathname,
    },
    open: () => true,
  };

  const document = {
    getElementById: (id) =>
      id === "vscode-workbench-web-configuration"
        ? {
            getAttribute: () =>
              JSON.stringify({
                productConfiguration: { nameLong: "RuntimeCode" },
              }),
          }
        : { style: {}, textContent: "" },
    body: {},
    head: { append() {} },
    createElement: () => ({}),
  };

  const posted = [];
  const navigator = {
    serviceWorker: serviceWorkers
      ? {
          controller: controllerScript
            ? {
                scriptURL: controllerScript,
                postMessage: (message) => posted.push(message),
              }
            : null,
        }
      : undefined,
    storage: {
      getDirectory: async () => {
        throw new Error("OPFS is not stubbed");
      },
    },
    locks: {
      request: async (_name, a, b) => (typeof a === "function" ? a : b)(),
    },
  };

  /** @type {any} */
  let config;
  const __workbench = {
    create: async (_container, value) => {
      config = value;
    },
    URI: { parse: (value) => ({ toString: () => value }) },
  };

  const run = new Function(
    "window",
    "document",
    "navigator",
    "__workbench",
    `return (async () => {\n${source}\n})();`,
  );
  await run(window, document, navigator, __workbench);

  return {
    config,
    posted,
    /** @param {string} id */
    command(id) {
      const entry = config.commands.find((command) => command.id === id);
      if (!entry) {
        throw new Error(`the bootstrap registers no ${id}`);
      }
      return entry.handler;
    },
  };
}

/** The extension source, for checking the two halves of the bridge agree. */
export const EXTENSION_SOURCE = () =>
  readFileSync(
    path.join(RC_ROOT, "extensions", "runtimefs", "extension.js"),
    "utf8",
  );
