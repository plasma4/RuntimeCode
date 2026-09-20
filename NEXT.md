# Next: learn the runtime packs before building them

Learning path and download sources for the runtime-host milestone. RUNTIMES.md
defines what a pack is and how the host consumes it; this file points at where
to learn the VS Code API those plans lean on, where each runtime actually comes
from, and which runtimes are worth shipping at all.

The immediate goal is still RUNTIMES.md M1: the runtime host plus one tiny pack
(Lua or QuickJS), built in-tree. Everything here is ordered so that M1 has what
it needs first.

## Terminology first

These are not emulators. An emulator reproduces a machine or a CPU. RuntimeCode
ships nothing that emulates hardware; it ships a language runtime compiled to
WebAssembly, so the browser's own wasm engine executes it. That is a different
beast:

- An **interpreter** executes source directly: CPython, CRuby.
- An **engine** runs precompiled or bytecode material: QuickJS, Lua in wasmoon.
- A **compiler** turns source into wasm: tcc, clang (via wasi-sdk or browsercc).

RUNTIMES.md calls the shippable unit a **runtime pack**: a language runtime plus
its assets plus the metadata the host reads. This file uses that term. "Fetch a
runtime" below means pin a URL and a digest at pack-build time and vendor the
assets into the build, never at run time.

## Learn VS Code extension development

Read the repo's own files first. They encode constraints a tutorial will not
tell you:

- `extensions/python-rc/extension.js` and its `package.json`: the working
  scaffold, deliberately built to exercise every API surface the host needs.
- `extensions/runtimefs/extension.js`: a production web extension in this exact
  host, with no build step.
- `RUNTIMES.md`: the host contract, execution sites, and the extension-host
  constraints (single-file CommonJS, nested-worker polyfill).
- `DEV.md`: how to build, serve, and typecheck.

Then the official docs, in roughly this order:

| Resource | What it gives you | Link |
| --- | --- | --- |
| API landing page | The map of everything below | https://code.visualstudio.com/api |
| Your first extension | The Hello World walkthrough | https://code.visualstudio.com/api/get-started/your-first-extension |
| Extension anatomy | `package.json` + `activate()` and how they pair | https://code.visualstudio.com/api/get-started/extension-anatomy |
| Extension capabilities | High-level list of what extensions can do | https://code.visualstudio.com/api/extension-capabilities/overview |
| Extension guides index | Catalog of the API-specific guides | https://code.visualstudio.com/api/extension-guides/overview |
| Web extensions | The one that matters: browser host limits, `require('vscode')`, single file, `workspace.fs` | https://code.visualstudio.com/api/extension-guides/web-extensions |
| Webview guide | `createWebviewPanel`, CSP, `postMessage` | https://code.visualstudio.com/api/extension-guides/webview |
| Terminal guide | `window.createTerminal`, profiles | https://code.visualstudio.com/api/extension-guides/terminal |
| Task provider | Making Run show up in the task list | https://code.visualstudio.com/api/extension-guides/task-provider |
| Contribution points reference | Everything `contributes` accepts | https://code.visualstudio.com/api/references/contribution-points |
| Extension manifest | Every `package.json` field | https://code.visualstudio.com/api/references/extension-manifest |
| VS Code API reference | The full API, including `Pseudoterminal` | https://code.visualstudio.com/api/references/vscode-api |
| Extension samples repo | Working code: `terminal-sample`, `helloworld-web-sample`, `webview-sample` | https://github.com/microsoft/vscode-extension-samples |
| `@vscode/test-web` | Browser-based testing of a web extension | https://www.npmjs.com/package/@vscode/test-web |

The two pages to read before writing any host code are **Web extensions** and
the **Terminal guide**. `Pseudoterminal` is the entire output path: the
interface `onDidWrite`, `handleInput`, `setDimensions`, and the exit-code
contract are what every runtime output lands on.

### The WASI-specific path

RUNTIMES.md names three WASI plumbing candidates. Read the Microsoft one first
because it is designed against this exact extension host, including the SAB
constraints:

- Repo: https://github.com/microsoft/vscode-wasm
- `@vscode/wasm-wasi` README, with the `Wasm.load()` / `createPseudoterminal` /
  `createProcess` example: https://github.com/microsoft/vscode-wasm/blob/main/wasm-wasi/README.md
- The runnable example: https://github.com/microsoft/vscode-wasm/blob/main/wasm-wasi/example/package.json

Two caveats to keep in mind. `@vscode/wasm-wasi` is a facade over the
`ms-vscode.wasm-wasi-core` extension, which this build would have to vendor as a
built-in extension, not fetch from a gallery. And it is a preview-1 WASI shim,
so a pack built against it must target `wasm32-wasip1`. The alternatives,
`@bjorn3/browser_wasi_shim` and `@wasmer/sdk`, are listed in the plumbing
section below with their own trade-offs.

## Where the runtimes actually come from

Sizes are from package listings and release notes, not measurements. The pack
build records real bytes (RUNTIMES.md "Tiers"). Every URL is a pinned-at-build
source, matching the Eruda vendoring precedent in `scripts/staticify.mjs`.

For each language the candidates are ordered by the niche they fill, not by
quality. The goal is a Pareto frontier: add a runtime only when it covers a
capability or a size point nothing already on the list covers. Three or more
packs for one language is fine when the niches are real.

### Python

**Pyodide (quick).** The full CPython ported with Emscripten, plus `micropip`
and prebuilt scientific wheels. The default first pack for a reason.

- Docs, downloading and deploying: https://pyodide.org/en/stable/usage/downloading-and-deploying.html
- Quickstart: https://pyodide.org/en/stable/usage/quickstart.html
- Core tarball on GitHub releases (`pyodide-core-<version>.tar.bz2`): https://github.com/pyodide/pyodide/releases
- CDN mirror of the same files: `https://cdn.jsdelivr.net/pyodide/<version>/full/`
- Rough size: ~10-11 MB core (`pyodide.asm.wasm` ~9.6 MB, `python_stdlib.zip` ~2.2 MB, loader ~15 KB).

Frontier claim: richest packages, best docs, biggest ecosystem. Fastest path to
"it runs numpy".

**CPython WASI (faithful).** Unpatched upstream CPython built for
`wasm32-wasip1`. No wheel ecosystem, no threads, no subprocess, but it behaves
like real CPython because it is real CPython.

- Build and platform notes: https://github.com/python/cpython/tree/main/Platforms/WASI
- Unofficial per-version prebuilt releases: https://github.com/brettcannon/cpython-wasi-build/releases
- Rough size: ~21 MB `python.wasm` plus the stdlib as separate `.py`/`.pyc`
  trees, or a fat single-file build.

Frontier claim: the faithful tier. The two Python tiers differ on every axis
the harness measures, which is the point of having both.

**MicroPython WASM (tiny third tier).** The microcontroller interpreter also
builds for wasm and lands at well under 1 MB, with a fraction of the stdlib and
no numpy. Cold start is near instant.

- Source and wasm port build instructions: https://github.com/micropython/micropython/tree/master/ports/wasm

Frontier claim: a Python that starts in under a second on a weak machine. Not
worth much if the deployment target is a desktop browser; worth a lot on low-end
devices.

### JavaScript

**Host engine eval (quick).** The extension host is a JS engine already. Run the
selection through `new Function` or a `Worker`. Zero download, instant start,
full host semantics. Not isolated, not deterministic, and it shares the host's
globals and storage. It is the honest quick tier for JS.

Frontier claim: no other JS runtime is faster to cold start, and none costs
zero bytes.

**QuickJS-ng wasm (faithful).** The maintained fork of QuickJS compiled to
WASI. Small, isolated, deterministic, snapshotable. Vercel's build ships it as a
single `quickjs.wasm` with optional native extensions.

- Repo: https://github.com/vercel-labs/quickjs-wasi
- npm: `quickjs-wasi` (`quickjs.wasm` ~600 KB after their `-Oz` + `wasm-opt`
  pass; extensions like `url`, `crypto`, `encoding` as separate `.so`)
- Note: no implicit I/O; the caller supplies the wasm bytes and a WASI shim.

Frontier claim: isolated and deterministic JS in a sixth of a megabyte, the
exact shape a conformance test wants.

**TypeScript transform (tooling, not a runtime).** TS needs a compile step
before either JS tier runs it. Two workable options:

- `esbuild-wasm`: real esbuild in the browser, ~14 MB unpacked. Browser API and
  the `worker: false` same-thread option: https://esbuild.github.io/api/#browser
  and https://www.npmjs.com/package/esbuild-wasm
- `sucrase`: a few hundred KB, fast transforms, partial TS support:
  https://www.npmjs.com/package/sucrase
- The full `typescript` compiler runs in a browser with shims; `transpileModule`
  works, full project type-checking does not. Prefer esbuild-wasm or sucrase.

Frontier claim: the compile step is a separate pack concern. esbuild-wasm for
exactness, sucrase for size.

### C

**tcc to wasm (quick).** The tiny compiler has a wasm32 backend. Near-instant
C99 compilation against a thin libc, roughly 1 MB.

- Wasm port to build at pack time: https://github.com/davidar/tinycc-wasm
- A browser demo of the same idea, useful as a reference: https://github.com/44670/tcc-wasm

Frontier claim: the "edit and run" C loop with no download wait. C99 only, no
C++, no real libc.

**clang to wasm (faithful).** A real toolchain. Two ways to get it:

- `browsercc`, a prebuilt clang/lld compiled to wasm. clang.wasm ~43 MB,
  lld.wasm ~23 MB, sysroot ~29 MB, plus an optional precompiled header. Output
  is a WASI binary runnable by `@bjorn3/browser_wasi_shim`:
  https://github.com/BertalanD/browsercc (npm `browsercc`)
- The native wasi-sdk, which is the build-time toolchain for cross-compiling
  other packs: https://github.com/WebAssembly/wasi-sdk/releases (Linux tarball
  is ~100 MB, never a browser asset)

Frontier claim: browsercc is the practical full C/C++ tier. The native wasi-sdk
is not a runtime pack at all; it is what `scripts/packs.mjs` uses to build the
wasm assets in the first place.

### Ruby

**ruby.wasm (single credible option).** CRuby compiled for WASI, with JS
interop. Release tarballs are per version and profile.

- Repo and docs: https://github.com/ruby/ruby.wasm
- Releases: https://github.com/ruby/ruby.wasm/releases
- Direct download pattern: `https://github.com/ruby/ruby.wasm/releases/latest/download/ruby-4.0-wasm32-unknown-wasip1-full.tar.gz`
- npm: `@ruby/3.4-wasm-wasi` and friends, which carry the wasm plus the API

Frontier claim: the only real option, so it is the whole frontier. No threads,
no networking. Ship the `full` profile as quick and leave the faithful tier
open until a second credible build appears.

### Lua

**wasmoon (quick).** The official Lua VM compiled to wasm with a JS bridge.
Small and fast.

- Repo: https://github.com/ceifa/wasmoon
- npm: `wasmoon` (1.16.0 latest; a 2.0 rewrite is in prerelease). Pass the wasm
  location to `LuaFactory` to host the file yourself.
- Watch out: the package attempts node imports that trip up bundlers. That is
  the known bundler caveat, not a bug in the host.

Frontier claim: real Lua performance, cheap to embed. The right first pack for
proving the contract end to end.

**fengari (no-isolation alternative).** The entire Lua VM rewritten in JS. Slower
for compute-heavy Lua, but it needs no wasm, no COI, and interop with JS is
synchronous and cheap.

- Repo: https://github.com/fengari-lua/fengari

Frontier claim: Lua that runs in deployments without cross-origin isolation.
The two Lua packs are a clean illustration of the quick/faithful idea applied to
the *environment* rather than the language.

### PHP

Two lineages that fill the same niche differently. Worth one line each because
the licensing differs materially.

**seanmorris/php-wasm.** Self-contained, Apache-2.0, covers PHP 8.0-8.5 with an
Emscripten build and no bundled extras.

- Repo: https://github.com/seanmorris/php-wasm
- npm: `php-wasm` (`PhpWeb` for browser, `PhpNode` for Node)
- CDN copy of the browser entry: `https://cdn.jsdelivr.net/npm/php-wasm/PhpWeb.mjs`

**WordPress Playground php-wasm.** The mature lineage with bundled extensions
(SQLite, libzip, libpng, OpenSSL, MySQL). GPL-2.0-or-later, which matters when
you distribute a pack: the runtime assets are data, not linked code, but the
license still needs an explicit decision.

- Repo: https://github.com/WordPress/wordpress-playground
- npm: `@php-wasm/node` for Node, `@php-wasm/web` and `@php-wasm/universal` for
  the browser; version-specific builds like `@php-wasm/node-8-4`
- Docs: https://wordpress.github.io/wordpress-playground/developers/local-development/php-wasm-node

Frontier claim: seanmorris is the clean-license quick tier, Playground is the
bundled-extension faithful tier. Pick one as the pack and keep the other as a
documented alternative.

### SQL

**SQLite wasm.** Not a program runtime, but a natural fit for the mount model.
The official wasm build supports in-memory, OPFS persistence (in a worker, with
COI), and the object-oriented API.

- Home: https://sqlite.org/wasm/doc/trunk/index.md
- Downloads: https://sqlite.org/download.html (`sqlite-wasm-<version>.zip`)
- npm wrapper with types: `@sqlite.org/sqlite-wasm`

Frontier claim: the OPFS VFS is the reason to ship it, and it exercises exactly
the isolation question the plan already has open. The older `sql.js` (pure
in-memory, manual export) is dominated; skip it.

### Beyond the first frontier: the bulky tier

These entries are hundreds of MB, they carry LLVM-sized toolchains, and they
break the quick/faithful size framing. The install threshold guardrail in
RUNTIMES.md becomes a real conversation at this size: OPFS quota on a phone can
be a small fraction of what a desktop grants, and a 500 MB install can exceed
it. Treat every entry here as a spike first and a pack later.

**Zig.** The compiler itself, not just programs written in it, runs in a
browser, and that matters more than for other languages. `zig cc` is a bundled
clang frontend, so one Zig compiler covers Zig and C and C++. That is the
dependency you guessed it would be.

- Compiler compiled to wasm: https://github.com/zig-wasm/zigc-wasm (Unlicense)
- Run it in a browser or Node: https://github.com/zig-wasm/wasi-zigc (npm `wasi-zigc`)
- Zig's wasm32-wasi target support: https://ziglang.org/learn/platform-support/wasm32-wasi
- Ecosystem hub: https://zigwasm.org/

The cost is the LLVM tax. Zig bundles LLVM and lld for its native backends, so
the wasm build of the compiler is in the hundreds of MB, and as of writing it
was a five-commit experiment. Do not plan a shipping pack around it; plan the
spike that pins a build, measures it, and decides whether the bundled clang
makes browsercc redundant. If it does, C and C++ keep two tiers: tcc for quick,
Zig for faithful, and browsercc disappears.

Frontier claim: one compiler, three languages (Zig, C, C++), for the user who
wants Zig itself and will pay the download for it.

**Rust.** No working in-browser compiler ships as a product. Two hard paths and
one honest shortcut:

- The shortcut is an interpreter. Miri runs the MIR of a compiled crate, no
  codegen and no linking, and a Miri build compiles to wasm. `rubri` is the
  wrapper, and `browser_wasi_shim` carries the rustc artifacts it needs:
  https://github.com/LyonSyonII/rubri and the rustc demo in https://github.com/bjorn3/browser_wasi_shim
- The hard path is rustc itself compiled to wasm, via bjorn3's cranelift work
  and the discussion in https://internals.rust-lang.org/t/running-rustc-on-wasm/16198 .
  It exists and it is hundreds of MB, with the same LLVM-sized tax as Zig. Not a product.

Frontier claim: Miri is the only thing that runs Rust in a browser today, and
it is slow, by the project's own admission. Ship it only if Rust is a priority
and the conformance cases are small.

**Go.** The toolchain is not browser-hostable, but Yaegi, a Go interpreter,
compiles to wasm and keeps goroutines and channels. It is what LiveCodes uses
for its browser Go.

- Yaegi: https://github.com/traefik/yaegi
- A worked example, Go to wasm, run client-side: https://github.com/Aryan-Bagale/go-browser-interpreter and https://livecodes.io/docs/languages/go-wasm
- The toolchain side, for cross-compiling whole programs at pack-build time rather than interpreting: https://go.dev/wiki/WebAssembly

Frontier claim: Yaegi covers tutorial-grade Go without a server. It is not full
Go parity; reflect-heavy and runtime-heavy programs break. The real thing still
needs a build step only a server or a build-time pack can provide.

**C# and .NET.** The runtime is real and shipped: the Mono-based .NET
WebAssembly runtime, the same one Copilot Studio runs C# on. The compiler is
the problem. Roslyn-as-wasm is not an official product, so a generic "compile
my C#" pack has no browser-hosted compile step yet. RUNTIMES.md deferred .NET
for exactly this reason.

- Runtime and workload docs: https://github.com/dotnet/runtime/tree/main/src/mono/wasm and https://learn.microsoft.com/en-us/aspnet/core/client-side/dotnet-interop/wasm-browser-app
- NuGet runtime package: `Microsoft.NETCore.App.Runtime.Mono.browser-wasm`
- Runtime memory guidance is 256-512 MB, which is a real cost in a browser.

Frontier claim: no. The runtime ships but the compiler does not, so a pack
cannot run arbitrary C# today. Revisit when Roslyn-on-wasm is something people
ship.

**Java.** Two very different things called "Java in the browser". They do not
share a license story, which is the whole point of this entry.

The compiler path is the OSS one and it is real: TeaVM compiles Java bytecode
(so Java, Kotlin and Scala) ahead-of-time to JavaScript, WebAssembly, or C. It
is Apache-2.0, and it deliberately does not lean on OpenJDK: it ships its own
reimplementation of the class library, built from Apache Harmony and other
permissive code. It also self-hosts, meaning the compiler itself can run in the
browser, which is what a Java pack needs: compile the user's source in the
browser, run the emitted JS or wasm.

- TeaVM: https://github.com/konsoletyper/teavm and https://teavm.org/
- Wasm GC backend: `teavm-maven-webapp-wasm-gc` archetype, TeaVM 0.15.0
- `teavm-javac`, a browser-side javac + TeaVM toolchain, packaged as JS and
  Wasm-GC: https://github.com/Vsprocessing/teavm-javac (Apache-2.0, but it
  vendors OpenJDK's javac, which is GPL-2.0 with the classpath exception; the
  exception keeps its output and your code non-copyleft, and the notice must
  stay intact)
- CheerpJ, for contrast: https://cheerpj.com/cheerpj-core and https://cheerpj.com/licensing

TeaVM is not a JVM. It cannot run an existing JAR or a Swing app; it is a
whole-program compiler with its own class library, reflection is limited, and
some Java APIs are impossible to implement efficiently in a browser, by the
project's own admission. CheerpJ is the only full-JVM answer, and it is
proprietary: its community license forbids self-hosting and redistribution,
which is what a pack does.

Frontier claim: TeaVM is a real quick-tier Java pack, roughly the Java analogue
of the C compiler tier. CheerpJ stays out of scope for distribution until
RuntimeCode has a server-side component. RUNTIMES.md deferred Java on the
CheerpJ license; that deferral applies to the JVM-runtime tier, not to TeaVM.

**R.** WebR is R compiled to wasm via Emscripten, with its own repository of
precompiled wasm packages. It is the most complete real interpreter in the
browser outside Python.

- Home and download: https://docs.r-wasm.org/webr/latest/ and https://github.com/r-wasm/webr
- npm: `webr` (~50 MB unpacked, including the R binaries; self-host a release package rather than using their CDN at run time)
- Package repo, CRAN-like with wasm binaries: https://repo.r-wasm.org/

Watch the license: the WebR binaries are distributed under GPL-3.0 (its own
tooling and scripts are MIT). That is the copyleft tier, handled below.

Frontier claim: R is on the frontier if any of your users write R. Nothing else
runs R without a server. Big download, slow cold start, which is exactly the
trade the faithful tier exists to describe.

**Perl.** WebPerl is the perl binary itself ported to wasm, not a JS
translation. A WASI flavor also exists.

- WebPerl: https://webperl.zero-g.net/ and https://github.com/haukex/webperl
- A WASI flavor: https://github.com/manwar/perl-wasm

Perl's Artistic-2.0 / GPL dual license is fine for a pack. Frontier claim:
fills the "there are still Perl scripts" niche. Small audience, cheap to ship
once the pack machinery exists.

**Shell (POSIX).** A real bash for the browser exists, compiled with Emscripten,
though RUNTIMES.md explicitly deferred a general POSIX shell. GPL-3.0.

- bash to wasm: https://github.com/bahamas10/bash-wasm (build from source at pack time)
- A Rust-shell-plus-coreutils alternative: https://github.com/mavity/washm

Frontier claim: deferred by design. The mount model and the stdin tiers in
RUNTIMES.md are exactly what a shell pack would stress, so treat it as a
follow-on once the contract is proven, not a first pack.

### Toolchain-only: no browser compiler yet

These compile to wasm or JS, but the compiler itself needs a native host, so a
runtime pack cannot run arbitrary source in the browser. Listed so the frontier
stays honest; none is a plan.

| Language | Target | Where it stands |
| --- | --- | --- |
| Kotlin | wasm | Official Kotlin/Wasm target; no browser-hosted compiler. https://kotlinlang.org/docs/wasm-overview.html |
| Swift | wasm | SwiftWasm; native toolchain only. https://swiftwasm.org/ |
| Dart | wasm/js | dart2wasm; native SDK only. https://dart.dev/web |
| Scala | js | Scala.js; compiler not browser-hosted. https://www.scala-js.org/ |
| Haskell | wasm | GHC wasm32-wasi backend; no in-browser GHC. https://gitlab.haskell.org/ghc/ghc/-/wikis/wasm |
| OCaml | js/wasm | js_of_ocaml; compiler native. https://github.com/ocsigen/js_of_ocaml |
| Julia | none credible | No maintained in-browser build. |
| Erlang/Elixir | wasm | AtomVM runs compiled BEAM bytecode, not source. https://github.com/atomvm/AtomVM |
| Fortran | wasm | flang can target wasm; no prebuilt shipped. |

With those, the frontier covers most of the common languages: Python, JS, TS,
C, C++, Zig, Rust, Go, Ruby, Lua, PHP, SQL, R, Perl, shell, plus the deferred
Java and .NET. That is the honest answer to "pack all the languages".

## Licenses at a glance

A pack inherits the upstream license. The host is MIT, and the question each
pack answers is whether its binary may be copied into a user's OPFS by our
installer. Nearly everything on the list can be, with a notice. Three groups
matter:

**Permissive, copy freely.** MIT, Apache-2.0, BSD, PSF, Unlicense. Most of the
list: Pyodide core (MPL-2.0, weak file-level copyleft, fine as an unmodified
asset), MicroPython, QuickJS, esbuild-wasm, sucrase, ruby.wasm, wasmoon,
fengari, seanmorris/php-wasm, SQLite (public domain, wrapper Apache-2.0), Zig
(Unlicense, compiler MIT), Miri, Yaegi, .NET/Mono, TeaVM, WebPerl, and all
three WASI shims. The only obligation is to keep the license notice, which the
catalog already records.

**Copyleft, copy only if you comply.** WebR (GPL-3.0 binaries), bash.wasm
(GPL-3.0), WordPress Playground php-wasm (GPL-2.0-or-later), tcc (LGPL-2.1).
These are redistributable, with conditions: ship the source or an offer, keep
the notices, and do not merge the code into the MIT host. RUNTIMES.md's
architecture, one generic host that loads interchangeable unmodified runtimes
as assets, is exactly the "mere aggregation" shape that keeps the host MIT. Two
rules keep it that way: never patch the runtime and fold the patch into the
host, and vendor the upstream build scripts inside the pack so the shipped
binary is reproducible, which is what a GPL source offer needs anyway.

**Not redistributable.** CheerpJ alone. It is proprietary, not copyleft: there
is no license term that permits redistribution, and the community license
explicitly forbids self-hosting and OEM use. That is why it is a separate
decision from every GPL item above.

Two practical notes. Bundling a GPL binary as a data asset is common (every
Linux distribution image does it); the fight is only over code you actually
merge or patch. And "not redistributable" software is a licensing problem you
can solve by asking, since the vendor sells exactly that permission.

## WASI plumbing

These are not runtimes either. They are the shim that lets a wasi-preview-1
binary talk to the browser. The pack worker needs one of them, and the choice is
made once for all packs.

- `@vscode/wasm-wasi`: MIT, designed against this extension host and its SAB
  constraints, but a facade over the `ms-vscode.wasm-wasi-core` extension that
  this build must vendor. https://github.com/microsoft/vscode-wasm
- `@bjorn3/browser_wasi_shim`: tiny, MIT/Apache-2.0, no synchronous syscalls, so
  blocking stdin needs its own SAB ring buffer. https://github.com/bjorn3/browser_wasi_shim
- `@wasmer/sdk`: MIT, ~15.5 MB, WASIX with threads and subprocesses, but brings
  its own worker and thread model that may fight the nested-worker polyfill.
  https://www.npmjs.com/package/@wasmer/sdk and https://docs.wasmer.io/sdk/wasmer-js

## What a good extension considers doing

The host owns everything the user sees; the pack owns the guest. These are the
behaviors worth building into the host on purpose, each one already implied by
RUNTIMES.md or the scaffold:

- **Own the run flow.** One `Run` command and one status bar item, wired to the
  runtime picker. The terminal is a `Pseudoterminal` on a `createTerminal`
  call, `isTransient: true`, named after the runtime, so the output panel
  reuses the user's existing terminal muscle memory.
- **Explain the tiers in the picker.** "Quick" and "faithful" are decisions, not
  trivia. Show install bytes in the detail line before anything downloads, and
  refuse to install silently over a configured threshold.
- **Advertise what each runtime cannot do.** The stdin tier, threads, subprocess
  and graphics capabilities come back from the pack in its `ready` message and
  get printed to the terminal when the answer is worse than the user expects.
  Silent EOF is how "the runtime hangs" gets reported.
- **Make missing isolation a named error.** When a capability needs SAB and the
  folder is not COI, the host says which setting to change
  (`runtimecode.sameOrigin.enabled`) instead of failing obliquely.
- **Decide the dirty-buffer policy once.** Save dirty documents before a run, or
  overlay dirty buffers onto the mount. Inconsistency here produces bugs that
  look like runtime bugs. Pick one, apply it to every pack.
- **Verify and re-verify.** Digests are checked at build time and again at
  install time. A runtime is the most privileged thing a user can install here.
- **Emit the license.** Every pack ships its upstream `LICENSE` and names it in
  the catalog. GPL packs (php-wasm from Playground) get a conscious decision,
  not a surprise.
- **Handle the reload.** Builtin registration is read once, so an install
  offers a reload and the pack is inert until then. Uninstall and a cleanup
  command for orphaned pack folders are first-class commands, not footguns.
- **Invalidate caches after writes.** Writes through `rfs:` need
  `runtimecode.internal.invalidateRfsCache`, and no sync access handle may be
  held across a run. The RuntimeFS extension already demonstrates both.
- **Keep the terminal host-side.** A pack that draws its own UI has left the
  contract and the second pack for that language will not match it.
- **Measure before choosing.** The conformance and benchmark harness is what
  makes the frontier a table instead of an argument. A new pack is not done
  until it has a conformance row.
- **Recommend, then install.** VS Code's recommended-extension dialog is how a
  user learns an extension exists. The host can lean on it: a workspace
  `.vscode/extensions.json` with `recommendations` lists the host (and any
  packs) as suggestions, and `contributes.extensionPack` makes an extension
  carry the ones it needs. Use it instead of a homegrown notification.

## Suggesting a runtime

The "recommended extension" dialog in VS Code is driven by two mechanisms, and
the docs page that explains them is
https://code.visualstudio.com/docs/editor/extension-marketplace#recommended-extensions :

- A `.vscode/extensions.json` file in a workspace, with a `recommendations`
  array. Opening that workspace shows each listed extension in the
  recommended-extension dialog with an Install button.
- The `contributes.extensionPack` and `contributes.extensionDependencies`
  manifest fields. A pack dependency (the `@vscode/wasm-wasi` case, which
  needs `ms-vscode.wasm-wasi-core`) is an `extensionDependencies`, not a
  recommendation.

For this project those two mechanisms cover most of it. The host ships in the
build, so it is never "recommended"; it is installed. The dialog becomes
relevant when a pack is published to a gallery, or when a workspace wants to
signal which runtime to use. Requesting a *new* runtime is a different path:
GitHub issues at https://github.com/plasma4/RuntimeCode/issues , and a useful
request names the niche (which capability or size point nothing on the list
covers), not just the language.

## Open items to settle while learning

- Pin real versions: this file's URLs are current as of writing, but RUNTIMES.md
  pins were written earlier (it names Pyodide 0.28.x while newer releases
  exist). The pack build resolves this: `packs/<id>/pack.json` pins each URL and
  digest, and a mismatch fails the build.
- Decide the WASI shim before writing pack code, because it changes the guest
  entry point. The `packload` and `nestedworker` spikes in RUNTIMES.md come
  first and can invalidate the architecture.
- Spike `zigc-wasm` before planning any C/C++/Zig pack. It decides two things
  at once: whether the bundled clang replaces browsercc, and what the install
  threshold for 500 MB-class packs should be. OPFS quota, not disk, is the
  binding constraint on the bulky tier.