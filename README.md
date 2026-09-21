# RuntimeCode

A static, de-Microsoft'd build of VS Code for the browser. Easily ship a plain folder of files, with optional extension components with their own licenses to support other languages (Python, JS, C...).

RuntimeCode is not affiliated with or endorsed by Microsoft.

## Building

You **must** have the [Microsoft VSCode repo](https://github.com/microsoft/vscode)
cloned at `../vscode` in order to build. Note that 24GB RAM is recommended for a
cold build (or an overnight build session, with potential custom configuration
necessary) and 16GB for warm ones.

```sh
nvm use 24.18.0              # make sure that you have nvm installed locally!
node scripts/prepare.mjs     # checkout pin, apply overlay + product + patches
node scripts/build.mjs       # gulp + staticify + homepage + the endpoint and license gates
node scripts/serve.mjs       # http://127.0.0.1:8099
```

## Upgrading

```sh
node scripts/upgrade.mjs 1.138.0          # fast build
node scripts/upgrade.mjs 1.138.0 --min    # release build
```

Those commands will update the pinned version, reinstall dependencies, and run a full build.

Patch-fixing notes: it's possible to fix by hand in `../vscode` and then regenerate that one patch from the working tree. You can write non-code text in the header safely for explanations. Do NOT hand-write `.patch` files.

## Runtime packs

A runtime pack is an unmodified upstream interpreter or compiler (Pyodide,
QuickJS, wasmoon, ...) pinned to a version and digest at build time and served
as a RuntimeFS folder. See RUNTIMES.md for the contract and NEXT.md for the
learning path.

- Definitions live in `packs/<id>/pack.json`.
- `node scripts/packs.mjs --pin <id>` downloads each asset and records its
  SHA-256 in the definition.
- `node scripts/packs.mjs --build` verifies the pinned digests (failing on any
  mismatch) and writes `dist/packs/<id>/` plus `dist/packs/catalog.json`.
  Unpinned packs are reported and skipped, never a build failure.
- `--build` is run by `build.mjs`, so a normal build ships whatever is pinned.

Deploy: upload `dist/packs/` as a RuntimeFS folder named `RC-Packs` (the
`runtimecode.python.packsFolder` default). Users install individual packs from
the host's `Python: Install Runtime Pack...` command, which copies the verified
bytes into OPFS and registers them for the next reload.

## Deploying

Three artifacts, each with its own license:

| Artifact | Folder | Deploy as | License |
| --- | --- | --- | --- |
| The editor | `dist/app/` | a RuntimeFS folder | MIT (workbench), extensions keep their own terms |
| Service worker + host root files | `dist/host-root/` | real files at the origin root | MIT |
| Runtime packs | `dist/packs/` | a RuntimeFS folder named `RC-Packs` | per pack, see `catalog.json` |
| The homepage | `dist/homepage/` | a separate site | AGPL-3.0 |

`dist/host-root/` must be reachable as real files (service worker scripts
bypass service workers, so a copy inside the RuntimeFS virtual tree can never
load). `dist/packs/` is optional: a deployment with no packs folder is a
supported state, and the host says so rather than failing.

## RuntimeFS integration/explanation

TODO
