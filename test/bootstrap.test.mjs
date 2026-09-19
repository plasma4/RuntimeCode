/**
 * Tests for the bootstrap in static/index.html.
 *
 * Mostly for one function. getRuntimeFsBase decides whether Dev Preview works
 * at all, it is the only place that knows where RuntimeFS is, and being wrong
 * costs the user a feature with an error message that blames their deployment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadBootstrap, EXTENSION_SOURCE } from "./bootstrap.mjs";

const fsBase = async (options) =>
  (await loadBootstrap(options)).command(
    "runtimecode.internal.getRuntimeFsBase",
  )();

// ---------------------------------------------------------------------------
// Where RuntimeFS is
// ---------------------------------------------------------------------------

test("a /n/ url carries the RuntimeFS root in front of it", async () => {
  assert.equal(
    await fsBase({ href: "https://example.org/fs/n/RC/" }),
    "https://example.org/fs",
  );
  assert.equal(
    await fsBase({ href: "https://example.org/n/RC/?folder=rfs:/Site" }),
    "https://example.org",
  );
  assert.equal(
    await fsBase({ href: "https://example.org/a/b/n/RC/index.html" }),
    "https://example.org/a/b",
  );
});

test("without a /n/ segment the controlling RuntimeFS worker gives the root", async () => {
  // The deployment where RuntimeCode is real files on the server and only the
  // user's own folders live in OPFS. sw.js computes its base the same way.
  assert.equal(
    await fsBase({
      href: "https://example.org/fs/rc/",
      controllerScript: "https://example.org/fs/sw.min.js",
    }),
    "https://example.org/fs",
  );

  // Unminified worker, and RuntimeFS installed at the origin root.
  assert.equal(
    await fsBase({
      href: "https://example.org/rc/",
      controllerScript: "https://example.org/sw.js",
    }),
    "https://example.org",
  );
});

test("the /n/ url wins over a worker somewhere else", async () => {
  assert.equal(
    await fsBase({
      href: "https://example.org/fs/n/RC/",
      controllerScript: "https://example.org/other/sw.min.js",
    }),
    "https://example.org/fs",
    "a /n/ path cannot be served by anything but the RuntimeFS that owns it",
  );
});

test("our own webview worker is not RuntimeFS", async () => {
  // rc-webview-sw.js is a real file at the same root and controls the webview
  // pages. Matching it would hand back a root with no RuntimeFS behind it.
  assert.equal(
    await fsBase({
      href: "https://example.org/fs/rc/",
      controllerScript: "https://example.org/fs/rc-webview-sw.js",
    }),
    undefined,
  );
});

test("standalone stays standalone", async () => {
  assert.equal(
    await fsBase({ href: "https://example.org/rc/" }),
    undefined,
    "no /n/ segment and no controller means there is nothing to preview through",
  );
  assert.equal(
    await fsBase({ href: "https://example.org/rc/", serviceWorkers: false }),
    undefined,
  );
  assert.equal(
    await fsBase({
      href: "https://example.org/rc/",
      controllerScript: "https://example.org/other-sw.js",
    }),
    undefined,
    "some unrelated worker controlling the page is not RuntimeFS",
  );
});

// ---------------------------------------------------------------------------
// The embedder bridge
// ---------------------------------------------------------------------------

test("getRuntimeCodeBase is the folder the workbench itself was served from", async () => {
  const { command } = await loadBootstrap({
    href: "https://example.org/fs/n/RC/index.html?folder=rfs:/Site",
  });
  assert.equal(
    await command("runtimecode.internal.getRuntimeCodeBase")(),
    "https://example.org/fs/n/RC/",
  );
});

test("every internal command the extension calls is one the bootstrap registers", async () => {
  const { config } = await loadBootstrap();
  const registered = config.commands.map((command) => command.id);
  const called = [
    ...new Set(
      EXTENSION_SOURCE().match(/runtimecode\.internal\.[A-Za-z]+/g) ?? [],
    ),
  ];

  assert.ok(
    called.length > 0,
    "the extension reaches the window only through these",
  );
  for (const id of called) {
    assert.ok(
      registered.includes(id),
      `${id} is executed by the extension and registered by nobody, which fails at runtime`,
    );
  }
});

test("the workbench is handed an absolute webviewEndpoint", async () => {
  const { config } = await loadBootstrap({
    href: "https://example.org/fs/n/RC/",
  });
  // webviewElement.ts:585 parses this and compares scheme://authority against
  // the origin of incoming messages. A relative value parses to "://" and
  // every webview message is dropped, silently.
  assert.match(
    config.webviewEndpoint,
    /^https:\/\/example\.org\/fs\/n\/RC\/out\/vs\//,
  );
});
