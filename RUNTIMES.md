# Language runtimes

A plan for running code inside RuntimeCode: WebAssembly interpreters and
compilers, shipped as optional **runtime packs**, with more than one pack per
language where the trade-offs really differ.

None of it is built yet. This file exists so the constraints are written down
before the code is, because most of them are only discoverable by reading
upstream or by watching something fail silently in a browser.

## What we are actually building

Three separate things. Conflating them is the main way this goes wrong.

| Layer | What it is | Where it lives |
| --- | --- | --- |
| Runtime host | One small built-in extension: registry, Run command, terminal, tasks, runtime selection | `extensions/runtime-host/` |
| Runtime pack | One language runtime plus its assets, contributing metadata the host reads | a RuntimeFS folder, installed on demand |
| Pack pipeline | Build-time fetch, pin and verify; install; registration; cleanup | `scripts/packs.mjs`, the bootstrap, host commands |

The host ships with the build and is inert with no packs installed. Packs are
large, optional, and versioned independently of the workbench.

The target: run a file or a selection, see output in a terminal, read and write
the workspace, work offline after one install, and let a user pick a different
runtime for the same language without anything else changing.

Out of scope for now: a general POSIX shell, network sockets, multi-process
programs, native toolchains (Go, Rust, Java, .NET, for reasons in
[Language candidates](#language-candidates)), and anything that needs a server.

## Constraints that decide the design

Each of these is verified against the pinned upstream, 1.137.0, not assumed.

**There is no terminal unless an extension owns it.**
`WorkerExtHostTerminalService.createTerminal` throws `NotSupportedError` without
a remote authority (`extHostTerminalService.ts:1311`). `createExtensionTerminal`
is not overridden (`:521`), so `vscode.window.createTerminal({ name, pty })`
works. Every runtime writes its output to a `Pseudoterminal`. The terminal UI
itself is in the web build (`workbench.web.main.ts:164`), so there is a panel to
render into.

**The extension host is a worker inside a same-origin sandboxed iframe.**
`webWorkerExtensionHost.ts:149` sets `sandbox="allow-scripts allow-same-origin"`,
and the worker is created from a Blob inside that iframe. This is why the
RuntimeFS provider can see OPFS at all. It is also the evidence that a pack's
worker will be able to fetch its `.wasm` through RuntimeFS's service worker: the
extension host worker already does exactly that for the workbench bundle.

**Nested workers are a polyfill, and it constrains pack code twice.**
`worker/polyfillNestedWorker.ts` does not create a worker in the extension host.
It posts `_newWorker` to the iframe, the iframe creates the real `Worker`, and
the blob bootstrap ends in `importScripts(workerUrl)`.

1. A pack's worker entry has to be a **classic script**. `type: 'module'` is
   forwarded to the constructor, but the bootstrap's `importScripts` is invalid
   in a module worker. Bundle to IIFE, never ESM.
2. That bootstrap then replaces `globalThis.Worker` with a class that throws
   `'Nested workers from within nested worker are NOT supported.'` So a runtime
   worker cannot spawn workers, which rules out pthreads, whatever the COI
   headers say.

The second one caught me by surprise, and it is the constraint most likely to
sink a promising pack late. Check it before picking a runtime build.

**SharedArrayBuffer needs cross-origin isolation, which is a RuntimeFS folder
setting.** Upstream already plumbs isolation through. `network.ts:401-445`
defines the `vscode-coi` query parameter, the webview service worker replays it
as COOP and COEP response headers (`pre/service-worker.js:517-525`), and the
extension host iframe appends `?vscode-coi=2` when `crossOriginIsolated`. What
upstream cannot do is set the top-level document's headers. That is RuntimeFS
Custom Headers on the folder RuntimeCode is served from, the same mechanism
`runtimecode.sameOrigin.enabled` already maintains for Dev Preview.

Turning it on is not free. `Cross-Origin-Embedder-Policy: require-corp` blocks
cross-origin subresources that lack CORP, and extension gallery icons from Open
VSX are the likely first casualty. Audit the rest. This is the biggest open
decision in the plan, and the one I would make first: see
[Cross-origin isolation](#cross-origin-isolation).

**An extension has to be fetchable over HTTP.** `additionalBuiltinExtensions`
takes a marketplace id or a location URI (`web.api.ts:254`), and the scanner
fetches `package.json` and the `browser` entry from it. OPFS has no URL, so a
pack sitting in OPFS is invisible. Unless it sits in a RuntimeFS folder, which
RuntimeFS's service worker serves at `/n/<Folder>/`. That one fact is what makes
installable packs possible without a server.

Two consequences. Packs registered this way show up as built-ins that can be
disabled but not uninstalled from the Extensions view, so uninstall has to be our
own command. And the list is read once by `create()`, so installing a pack
requires a workbench reload.

**Web extensions load as a single CommonJS file**, via
`new Function('module','exports','require', src)`
(`extHostExtensionService.ts:87`), with `require` resolving nothing but `vscode`
(`:109`). `extensions/runtimefs/` gets away without a build step because it has
no dependencies. A pack will not, so every pack needs a bundler step producing
one IIFE per entry point.

**OPFS sync access handles are exclusive.** `createSyncAccessHandle()` takes a
writable lock on the file, and RuntimeFS is serving those same files. A pack that
holds handles open across a run makes the folder unservable and breaks Dev
Preview with no useful error. Open, operate, close. Prefer
`{ mode: 'read-only' }` where the browser has it.

**Offline matters, and the vendoring pattern already exists.**
`staticify.mjs:136` downloads Eruda from a pinned URL, checks a SHA-256, and
writes it into the build. Runtime assets get the same treatment: pinned version,
pinned digest, verified at build time, served from our own origin. No pack
fetches from a CDN at run time.

## Cross-origin isolation

Almost every capability question reduces to whether the RuntimeCode folder
carries COOP and COEP.

| | Not isolated | Isolated |
| --- | --- | --- |
| `SharedArrayBuffer`, `Atomics.wait` | no | yes |
| Blocking `stdin` (`input()`, `scanf`) | no, EOF or a prompt dialog | yes, real line-blocking reads |
| Synchronous WASI syscalls across a worker boundary | no | yes |
| Threaded wasm builds | no, and the nested-worker polyfill blocks them too | only at a webview site |
| Cross-origin gallery assets | fine | need CORP; icons likely break |
| Dev Preview | needs the headers anyway | already the documented state |

Three ways to land it, in increasing order of ambition:

1. Opt in per deployment. Extend `runtimecode.sameOrigin.enabled` to cover the
   folder RuntimeCode itself is served from, and have the host refuse capability
   tiers that need SAB with a message naming the setting.
2. Isolate by default, with an escape hatch, and document what breaks.
3. `credentialless` COEP, which is laxer on cross-origin subresources and
   Chromium-only. Measure it in the spike; do not plan around it.

Start with (1) and revisit once you have measured what (2) actually costs. The
host has to work without isolation regardless, because most deployments will not
have it on day one.

## Execution sites

Where the guest code actually runs. Packs declare which one they need instead of
each inventing an arrangement.

| Site | Threads | SAB | DOM and canvas | Cost to build | Notes |
| --- | --- | --- | --- | --- | --- |
| `worker`, a nested worker from the extension host | no | with isolation | no | low | The default. Classic script only. Dies with the extension host. |
| `webview`, hidden or visible | yes | with isolation | yes | medium | The only site that can spawn workers. Needed for graphics and pthreads. Webviews are same-origin here (patch 0003). |
| `window`, a worker owned by the bootstrap and exposed as an embedder command | yes | with isolation | no | medium | Adds divergence in `static/index.html`. |

Start with `worker`. Add `webview` when the first pack needs threads or a
plotting surface, such as matplotlib or SDL. Treat `window` as the fallback,
because every line in `static/index.html` is a line we carry across upgrades.

## The provider contract

One contract, so runtimes are interchangeable and the host owns all the UI.

A pack declares itself in `package.json`, which costs nothing to read. The host
scans `extensions.all[].packageJSON` and only calls `activate()` when a runtime
is chosen.

```json
"contributes": {
  "runtimecode.runtimes": [{
    "id": "python.pyodide",
    "displayName": "Python (Pyodide)",
    "languages": ["python"],
    "tier": "quick",
    "engine": "pyodide 0.28.x",
    "languageVersion": "3.13",
    "site": "worker",
    "worker": "./dist/session.js",
    "assets": "./assets/",
    "installBytes": 11534336,
    "requires": { "crossOriginIsolated": false },
    "capabilities": {
      "stdin": "buffered",
      "threads": false,
      "packages": "micropip",
      "graphics": "none",
      "debug": false,
      "fs": "mount"
    }
  }]
}
```

The extension exports one object:

```ts
export interface RuntimeProvider {
  createSession(spec: RunSpec, io: SessionIO): Promise<RuntimeSession>;
}

interface RunSpec {
  runtimeId: string;
  entry: vscode.Uri;          // the file to run
  argv: string[];
  env: Record<string, string>;
  cwd: vscode.Uri;
  mounts: Mount[];            // see Filesystem model
  stdinMode: 'blocking' | 'buffered' | 'none';
}

interface RuntimeSession {
  write(data: string): void;  // stdin
  signal(sig: 'INT' | 'KILL'): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  readonly exit: Promise<number>;
}
```

Messages to the site are structured-clone only, with no ad-hoc shapes. To the
guest: `init`, `stdin`, `signal`, `resize`, `dispose`. From the guest: `ready`
(echoing the capabilities it really implemented), `stdout`, `stderr`, `exit`,
`fs` when the host services filesystem calls, and `diag`.

The host owns everything the user sees: the terminal, the status bar item, the
run buttons, the runtime picker, and the error when a capability is missing. A
pack that draws its own UI has left the contract, and the second pack for that
language will not match it.

## Filesystem model

The guest sees a mount table and nothing else. No ambient OPFS, no access to
RuntimeFS folders the table does not name.

```
/workspace  ->  the workspace folder (rfs:/<Folder> today, any scheme in principle)
/tmp        ->  in memory, discarded at exit
```

Reads and writes go through `vscode.workspace.fs`, which keeps packs
scheme-agnostic. For `rfs:` paths a pack may take the OPFS fast path directly,
using the same mapping the RuntimeFS extension uses (`rfs/<Folder>/<path>`), but
then it inherits RuntimeFS's rules: take `rfs_write_<name>` around writes, call
`runtimecode.internal.invalidateRfsCache` afterwards, and never hold a sync
access handle open across a run.

One behaviour to settle early: unsaved editor buffers. A run that reads the file
from storage silently executes yesterday's code. Either save dirty documents in
the workspace first, which is the VS Code-typical answer, or overlay dirty
buffers onto the mount. Pick one and apply it to every pack. Inconsistency here
produces bug reports that look like runtime bugs.

## Standard input

| Mode | Requires | Behaviour |
| --- | --- | --- |
| `none` | | reads return EOF at once |
| `buffered` | | terminal input is queued; a read returns what has arrived, EOF if nothing has |
| `blocking` | isolation and SAB | `Atomics.wait` on a shared ring buffer, so `input()` really blocks |

The host advertises the best mode the environment supports, the pack echoes back
what it implemented, and the terminal prints one line whenever the answer is
worse than the user expects. Silent EOF is the failure that gets reported as "the
runtime hangs".

## Tiers, and why one runtime per language is not enough

Two named tiers, so "which one do I install" has an answer that fits in a
sentence.

**quick** is the smallest download, the fastest cold start, and usually the
richest package ecosystem. It gives up fidelity at the edges: threads,
subprocesses, sockets, unusual syscalls. It is often a patched build of the
language.

**faithful** is an unpatched upstream build that behaves like the real thing, and
pays for it in size, startup, or missing prebuilt packages.

The benchmark harness records install bytes, cold start to first output, warm
start, a small CPU benchmark, conformance pass rate, and the capability set. That
turns the frontier into a table instead of an argument.

## Language candidates

Sizes are order-of-magnitude guesses, to be replaced by measurements from the
pack build. Record each pack's license before it ships.

| Language | quick | faithful | Notes |
| --- | --- | --- | --- |
| Python | Pyodide, ~10-15 MB core | CPython built for WASI, ~15-20 MB | Pyodide brings `micropip` and prebuilt scientific wheels. The WASI build is unpatched CPython with no wheel ecosystem. Neither gets threads or subprocesses. |
| JavaScript | worker `eval`, ~0 MB | QuickJS-ng wasm, ~1 MB | The quick tier is the host engine: instant, but host semantics and host globals. QuickJS is isolated and deterministic. TypeScript needs a transform; Sucrase is small, `esbuild-wasm` (~9 MB) is exact. |
| C | tcc compiled to wasm, ~1 MB | clang with the wasi-sdk sysroot, ~40-100 MB | The clearest pair in the list. Near-instant C99 against a thin libc, or a real toolchain that builds most single-file C and C++. |
| Ruby | ruby.wasm, ~10-30 MB | | One credible option. Ship it as quick and leave the tier open. |
| Lua | wasmoon, ~0.5 MB | | Cheap, and a good first pack for proving the contract end to end. |
| PHP | php-wasm, ~10 MB | | Mature lineage, from WordPress Playground. |
| SQL | SQLite wasm with the OPFS VFS, ~1 MB | | Not a program runtime, but valuable and a natural fit for the mount model. |

Deferred, with the reasons worth keeping written down. Go and Rust: the compilers
are not browser-hostable at a sane size, and TinyGo needs a server. Java:
CheerpJ's licensing does not fit this project. .NET: the wasm workload is large
and assumes its own host.

For the WASI plumbing, evaluate three before writing any: `@vscode/wasm-wasi`
(Microsoft's, MIT, designed against this exact extension host arrangement and its
SAB constraints), `@bjorn3/browser_wasi_shim` (tiny, MIT, no sync syscalls), and
the Wasmer SDK (brings its own worker and thread model, which may fight the
nested-worker polyfill). Check Open VSX availability separately from license. A
dependency we vendor at build time needs no gallery entry at all.

## Distribution and install

At build time, in `scripts/packs.mjs`, following the Eruda precedent:

1. Read `packs/<id>/pack.json`: pinned upstream URLs, a SHA-256 per asset, the
   license, the version.
2. Fetch, verify every digest, and fail the build on a mismatch.
3. Bundle the pack's extension entry and worker entry to CommonJS or IIFE.
4. Write `dist/packs/<id>/` and a `dist/packs/catalog.json` recording id,
   version, bytes, digests and license.

Deploying it makes `dist/packs/` a RuntimeFS folder, for example `/n/RC-Packs/`.
That is a third artifact next to `app/` and `host-root/`, so `check-deploy.mjs`
and the README deploy table both need to learn about it.

At install time, in the host extension:

1. Read `catalog.json` from the packs folder, or from the local build while
   developing.
2. Copy the pack into OPFS under `rfs_write_<name>`, verifying digests again.
3. Record it in `rfs/.runtimecode/packs.json`.
4. Invalidate the RuntimeFS cache and offer a reload.

At startup, in `static/index.html`, before `create()`: read `packs.json` from
OPFS, resolve each entry to `<rfsBase>/n/<PacksFolder>/<id>/`, and append them to
`additionalBuiltinExtensions`. Served standalone there is no `/n/` segment and so
no packs, the same degradation the preview commands already handle. The host
should say so rather than showing an empty runtime list.

Uninstall is our own command: delete the folder, drop the entry, reload. A
cleanup command that removes pack folders with no `packs.json` entry will pay for
itself the first time an install is interrupted.

Open VSX stays a secondary path. A pack published there installs and hot-loads
with no reload, but fetches its assets from a third-party CDN at run time, which
gives up offline use. Support it, do not depend on it.

## Guardrails

- Verify digests at build time and again at install time. A runtime is the most
  privileged thing a user can install here.
- Emit each pack's upstream license into `dist/packs/<id>/LICENSE`, and name it
  in the catalog.
- Show install bytes before downloading, and refuse to install silently over a
  threshold. Packs run one to two orders of magnitude larger than the workbench's
  own assets.
- Decide explicitly whether `dist/packs/` is in scope for `check-endpoints.mjs`.
  Runtime bundles carry enormous amounts of incidental text and will generate
  noise, so skipping them like `node_modules` and relying on digests is probably
  right.
- The sandbox boundary is the wasm module plus the mount table. Guest code
  reaches only what the table names. Worth saying in the pack docs that webviews
  and the workbench share an origin in this build (patch 0003), so a pack, as
  opposed to guest code, is as privileged as any extension.

## Verify before building: spikes

The repo's own precedent applies here more than anywhere. `spikes/swtest`
produced two findings that changed the design before a line of it was written.
Each spike below is a standalone page under `spikes/`, run in a real browser, and
against a real RuntimeFS deployment whenever the question involves the service
worker.

| Spike | Question | Pass looks like |
| --- | --- | --- |
| `coi` | Does COOP and COEP on the RuntimeCode folder give `crossOriginIsolated` in the window, the extension host worker and a webview, and what breaks? | SAB constructs in all three, plus an itemised list of broken cross-origin assets |
| `nestedworker` | Does a classic-script worker start from the extension host, and does `importScripts` of a `/n/` URL go through RuntimeFS's service worker? | wasm instantiates in the nested worker, served out of OPFS |
| `syncfs` | Can a worker use sync access handles on a RuntimeFS folder, under `rfs_write_<name>`, without breaking serving? | the file round-trips and the folder still serves during and after |
| `stdin` | Does `Atomics.wait` blocking stdin survive the polyfilled worker's MessagePort proxy? | interactive `input()` in a pseudoterminal |
| `packload` | Does `additionalBuiltinExtensions` accept a `/n/<Packs>/<id>/` URI and activate the extension? | a trivial pack's command appears and runs |
| `webviewsite` | Can a webview spawn workers and run a threaded wasm build under isolation? | a pthreads build reports more than one thread |

`packload` and `nestedworker` can invalidate the whole architecture. Run those
two first.

## Conformance and benchmarks

More than one runtime per language is only honest if they are measured the same
way.

- `fixtures/runtimes/<language>/<case>/` holds `cmd`, `stdin`,
  `expected_stdout`, `expected_exit`, and an optional `requires` naming
  capabilities. Ten cases per language is enough to start: stdout, stderr, exit
  codes, argv, env, a file read, a file write, stdin, unicode, and a deliberate
  traceback.
- `RuntimeCode: Run Runtime Conformance` runs every case against every installed
  runtime for that language and writes a report into the workspace.
- The same harness records cold start, warm start, install bytes and one CPU
  benchmark, which is what fills in the tier table.

A new pack is not done until it has a conformance row.

## Milestones

| | Deliverable | Done when |
| --- | --- | --- |
| M0 | The six spikes | Findings written into this file, architecture confirmed or changed |
| M1 | `extensions/runtime-host/` and one tiny pack (Lua or QuickJS), built in-tree | A file runs, output lands in a pseudoterminal, non-zero exit codes propagate |
| M2 | `scripts/packs.mjs`, the catalog, install and uninstall and cleanup, bootstrap registration | A pack installs from the packs folder, survives a reload, uninstalls cleanly |
| M3 | Python quick tier, the mount table, the stdin tiers | A script reads and writes workspace files; `input()` works under isolation and degrades with a message without it |
| M4 | A second tier for one language, plus the conformance and benchmark harness | Two Python runtimes, one table comparing them, a picker that explains the difference |
| M5 | An inline DAP debug adapter for one runtime | Breakpoints and stepping in the web debug UI |

M0 and M1 are small. M2 is where the real work is, because it touches the
bootstrap, the deploy story and `check-deploy.mjs`.

## Open questions

1. Isolation policy: opt-in, default, or `credentialless`. Blocks the stdin tiers
   and every threaded runtime.
2. The packs folder name, and whether packs share one RuntimeFS folder or get one
   each. One folder is simpler to deploy. One each makes cache invalidation and
   Custom Headers independent per pack.
3. Whether `check-deploy.mjs` and the README deploy table grow a third artifact
   now or after M2.
4. Dirty buffers: save before run, or overlay.
5. Whether the host should also contribute a notebook controller, which would
   undermine the terminal-first assumption in the contract.
6. Naming. This file says "runtime pack" throughout, and `runtimecode.runtimes`
   is the contribution point. Both are cheap to change now and expensive later.
