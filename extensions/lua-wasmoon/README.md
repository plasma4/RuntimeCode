# Lua (wasmoon) runtime pack

Brings Lua 5.4 to the runtime host, per [RUNTIMES.md](../../RUNTIMES.md). The
interpreter is [wasmoon](https://github.com/ceifa/wasmoon) 1.16.0 (MIT), the
official Lua VM compiled to WebAssembly with a JS bridge. It declares
`site: "host"` because it runs in the extension host worker, which already is a
worker with no DOM; there is no nested worker and no shared memory involved.

Capabilities are stated as implemented, not as hoped: stdout, stderr and exit
codes are real, stdin is `none` (wasmoon exposes no blocking read), threads,
packages and graphics are off, and the only file the guest sees is the entry
file the host hands it.

## Assets

`pack.json` is the vendoring record: upstream tarball, version, and a SHA-256
for each asset. `test/luapack.test.mjs` recomputes both digests and fails if an
asset changes. Nothing here is fetched from a CDN at run time; the assets ship
inside the extension folder, so the pack works offline.

| Asset | From | Bytes |
| --- | --- | --- |
| `assets/wasmoon-1.16.0.js` | `package/dist/index.js` | 151,652 |
| `assets/glue-1.16.0.wasm` | `package/dist/glue.wasm` | 271,581 |

`assets/LICENSE-wasmoon` is the upstream MIT license and is kept verbatim. Lua
itself is also MIT.

## Refreshing the vendored assets

This is by hand until `scripts/packs.mjs` exists (RUNTIMES.md M2). Run it from
this directory, with the tarball version and the filenames updated together:

```sh
curl -fsSL -o /tmp/wasmoon-<version>.tgz https://registry.npmjs.org/wasmoon/-/wasmoon-<version>.tgz
mkdir -p /tmp/wasmoon-<version> && tar -xzf /tmp/wasmoon-<version>.tgz -C /tmp/wasmoon-<version>
cp /tmp/wasmoon-<version>/package/dist/index.js assets/wasmoon-<version>.js
cp /tmp/wasmoon-<version>/package/dist/glue.wasm assets/glue-<version>.wasm
cp /tmp/wasmoon-<version>/package/LICENSE assets/LICENSE-wasmoon
sha256sum assets/wasmoon-<version>.js assets/glue-<version>.wasm
```

Then update `extension.js` (both filenames), `package.json` (`engine`,
`installBytes`), and `pack.json` (`version`, `upstream`, `assets`, digests,
`installBytes`). Delete the previous asset files; a stale wasm sitting beside a
new one is the failure the digest test cannot see.

## Why the UMD is evaluated instead of required

The web extension host loads an extension with
`new Function('module','exports','require', src)` and `require` resolves only
`vscode`, so there is no module loader for a dependency. The pack fetches the
UMD source as a string and evaluates it the same way, with the worker-shaped
globals supplied as function parameters when a test needs to run it outside a
browser. See the comment on `setEnvironment()` in `extension.js`.
