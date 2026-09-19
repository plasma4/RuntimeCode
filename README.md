# RuntimeCode

A static, de-Microsoft'd build of VS Code for the browser. It ships as a plain
folder of files, with no server behind it, and is normally served from
[RuntimeFS](https://github.com/plasma4/RuntimeFS) at `/n/RuntimeCode/`.

This repo contains no VS Code source. It holds only the divergence from
upstream, plus the scripts that apply it to a checkout at `../vscode`.

## How it works

Three things happen to a pristine VS Code checkout, in this order:

1. `overlay/` is copied over it. Whole files, so they can never conflict.
2. `product.overlay.json` is deep-merged into `product.json`. A `null` value
   deletes an upstream key.
3. `patches/` is applied as a numbered series.

The ordering encodes a rule worth keeping: overlay and JSON merge beat patching.
Every patch is a tax you pay at every upgrade, so anything expressible as a
product key, an overlay file, or a post-build transform is done that way. The
series is currently four patches, which is about as small as it gets while still
producing a browser build that works.

Then `gulp` builds the `vscode-web` target, and `staticify.mjs` turns the result
into something a dumb static host can serve: it writes `index.html` from our own
bootstrap, copies in the RuntimeFS extension, renames the product in the built-in
strings that name it on screen, and repairs two things the build gets wrong for
this deployment. Finally `check-endpoints.mjs` refuses to let a Microsoft endpoint
sneak back in.

Output lands in `dist/`, in two parts that go to two different places. See
[Deploying](#deploying), and do not skip the second one.

The only thing that lives outside this repo is the upstream checkout, because it
is an input and it is enormous. It defaults to `../vscode`; set
`RUNTIMECODE_VSCODE` to put it anywhere else.

## Layout

| Path                    | Purpose                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `vscode.pin`            | Upstream release tag to build from (currently 1.137.0)                                |
| `product.overlay.json`  | Deep-merged over upstream `product.json`                                              |
| `overlay/`              | Whole files copied into the checkout                                                  |
| `patches/`              | Numbered patch series, each with its rationale in the header                          |
| `static/`               | Our bootstrap `index.html` and the Dev Preview host page                              |
| `extensions/runtimefs/` | The web extension providing the `rfs:` filesystem                                     |
| `scripts/`              | prepare, build, staticify, check-endpoints, check-deploy, upgrade, serve              |
| `fixtures/`             | Sample project served at `/n/<name>/` by `serve.mjs --simulate-rfs`                   |
| `test/`                 | Tests for the RuntimeFS extension and the build helpers, run with `node --test test/` |
| `spikes/`               | Standalone browser experiments                                                        |
| `dist/`                 | Build output, gitignored                                                              |

Environment variables: `RUNTIMECODE_VSCODE` for the upstream checkout,
`RUNTIMECODE_RFS` for a RuntimeFS checkout (only `serve.mjs --with-rfs` uses it),
`PORT` for the local server.

## Build

```sh
nvm use 24.18.0              # the version in ../vscode/.nvmrc
node scripts/prepare.mjs     # checkout pin, apply overlay + product + patches
node scripts/build.mjs       # gulp + staticify + endpoint gate
node scripts/serve.mjs       # http://127.0.0.1:8099
```

The version has to be named. `.nvmrc` belongs to the checkout, and nvm only
searches the current directory and its parents, so a bare `nvm use` here finds
nothing and leaves the shell on whatever node it had. `build.mjs` checks the
running version against that file and refuses to start on the wrong one, because
the failure otherwise arrives deep inside gulp.

`build.mjs` defaults to the fast path: unminified, using the `-ci` gulp variants
that reuse `out-build/`. Add `--min` for a release build and `--full` to force a
full recompile.

On an M5 with 48GB: `npm ci` takes about 5 minutes, a cold build about 15, and a
warm rebuild 33 seconds. That warm path only exists after one full build, and it
is worth protecting. Never `git clean` the checkout between upgrades.

### Toolchain notes

`scripts/shim/xcodebuild` exists because node-gyp detects the macOS toolchain
through pkgutil receipts, which are missing on this machine even though the
Command Line Tools are installed and `clang` works fine. Without the shim,
`npm ci` dies with "gyp: No Xcode or CLT version detected!". The shim answers
node-gyp's version probe and the real compiler still does the work.
`--ignore-scripts` is not a substitute, because esbuild and ripgrep download
real binaries in their postinstall.

Go through `npm run gulp`, never `npx gulp`. The repo's own script sets
`--max-old-space-size=8192`, and bypassing it fails with
`ERR_WORKER_OUT_OF_MEMORY`. `build.mjs` raises `NODE_OPTIONS` further because the
bundler's worker threads do not inherit the parent's heap setting.

Changing `product.overlay.json` requires a rebuild, not just a re-run of
`staticify.mjs`. Parts of the product config are baked into the bundle at build
time and read before any runtime override applies.

Upstream is not always buildable. `patches/0001` fixes a defect present on `main`
and on every tag we have built: `sessionChangesEditor.ts` overrides two
`protected` members without repeating the keyword, which widens them to public,
and the mangler rejects that outright. Expect to drop the patch once upstream
fixes it.

## Upgrading

```sh
node scripts/upgrade.mjs 1.138.0          # fast build
node scripts/upgrade.mjs 1.138.0 --min    # release build
```

That writes the pin, re-applies the divergence, reinstalls dependencies, and runs
a full build.

When a patch stops applying, fix it by hand in `../vscode` and then regenerate
that one patch from the working tree. Keep the prose header, which `git apply`
ignores:

```sh
cd ../vscode
{ sed '/^diff --git /q' p.patch | sed '$d'; git diff HEAD -- <paths>; } > p.patch.new
```

Never hand-write a `.patch` file. A patch whose `index` lines do not name real
blobs cannot 3-way merge, so `git apply` falls back to direct application and you
lose the warning you needed. One written that way quietly dropped four of its
hunks somewhere between 1.131.0 and 1.137.0, and the missing Welcome page entries
only turned up during the next upgrade.

## What cannot come out of the overlay

`defaultChatAgent` has to stay in `product.json`.
`welcomeOnboarding/browser/onboardingVariationA.ts:80` calls
`assertDefined(product.defaultChatAgent)` at module scope, and around 50 other
files read fields off it. Remove it and the workbench will not construct at all.

So Copilot is turned off twice over, in the two places that actually work. The
extension is not bundled, and `chat.disableAIFeatures` defaults to `true`, which
sets `sentiment.hidden` (`chatEntitlementService.ts:1507`) and takes the chat
status bar entry with it. Without that default the entry sits there advertising a
product this build cannot install: Open VSX carries neither `GitHub.copilot` nor
`GitHub.copilot-chat`, so the setup flow asks the gallery for an extension that is
not in it. Both halves are reversible. Point `extensionsGallery` at a registry
that has Copilot and set `chat.disableAIFeatures` to false, and the UI returns.

Upstream's `workbench.html` is unusable here. `build/next/index.ts:181-186` builds
the `web` target as "web workbench only (no browser shell)", so
`vs/code/browser/workbench/workbench.js` is never emitted and only `server-web`
gets it. `static/index.html` is our own bootstrap, calling the exported `create()`
directly. That is the supported embedder path, and it is where the RuntimeFS
providers plug in.

## Webviews

Webviews are blank in a naive static build: markdown preview, notebooks, the
settings UI, all of them. Three independent causes, each silent.

Webviews expect their own origin. The host page verifies that its
`location.hostname` equals a sha-256 of the parent origin, proving it sits on a
dedicated per-webview subdomain. A self-contained static folder has exactly one
origin, so that check can never pass. Patch 0003 accepts the explicit same-origin
case. The trade-off is deliberate and real: webview content is then not isolated
from workbench storage (localStorage, IndexedDB, OPFS). That matches what
RuntimeFS already documents for the folders it serves, but it does weaken webview
isolation specifically. Cross-origin deployments keep full validation.

The CSP pins a hash of the inline script. The host page's `script-src 'sha256-…'`
covers its own inline module, so patching that script invalidates the hash and the
browser blocks it silently. No error event, no reachable console entry, just a
webview that never hands-shakes. `staticify.mjs` recomputes the hash on every
build so this cannot recur.

`webviewEndpoint` must be absolute. `webviewElement.ts:585` does
`URI.parse(endpoint)` and compares `scheme://authority` against the origin of
incoming webview messages. A relative endpoint parses to `"://"` and every message
is dropped. `static/index.html` computes it from `window.location`, which keeps the
folder portable.

## Service workers, and why there are two

Two findings from `spikes/swtest`, both verified in a browser before any of this
was built.

A service worker cannot be registered from inside a RuntimeFS virtual folder.
Service worker script requests carry `serviceWorkers: 'none'`, so RuntimeFS's own
worker never sees the request and it 404s against the real origin. The same URL
fetched normally returns `200 text/javascript`. RuntimeCode therefore registers
`rc-webview-sw.js` as a real file at the RuntimeFS host root, passing the virtual
webview directory as an explicit narrower scope. The folder name is not part of
the wiring; the bootstrap derives the RuntimeFS base from the `/n/<folder>/` URL.

Service workers do not chain. Once the webview worker controls a client, requests
it declines to `respondWith` fall through to the network rather than back to
RuntimeFS, so it needs its own OPFS fallback. A worker inside a same-origin iframe
does see the same OPFS as RuntimeFS, which is what makes the extension-based
filesystem provider viable.

## The RuntimeFS extension

`extensions/runtimefs/` is a web extension, copied to `rc-extensions/` in the
output and registered by the bootstrap through `additionalBuiltinExtensions`. It
is plain CommonJS with no build step, because the web extension host loads
extensions with `new Function('module','exports','require', src)`
(`extHostExtensionService.ts:87`).

That rules out TypeScript, so the file is checked JavaScript instead: `@ts-check`
with JSDoc types, `extensions/runtimefs/jsconfig.json` in strict mode, and
`scripts/typecheck.mjs` to run `tsc` over it. That script also copies
`vscode.d.ts` out of the checkout into the gitignored `extensions/types/`, which
is how `require('vscode')` resolves without an npm install in this repo.

It provides the `rfs:` scheme, mapping `rfs:/<Folder>/<path>` onto OPFS
`rfs/<Folder>/<path>`, the same tree RuntimeFS serves from, so edits are live at
`/n/<Folder>/`. It reuses RuntimeFS's own coordination primitives rather than
racing them: the `rfs_registry_lock` around `rfs_system.json`, and the per-folder
`rfs_write_<name>` lock around writes.

Commands: Open RuntimeFS Folder, New RuntimeFS Folder, Import RuntimeFS Folder,
Export Folder Locally, Refresh RuntimeFS Cache.

Open RuntimeFS Folder creates as well as opens. The folder list carries a pinned
`New RuntimeFS Folder...` entry, and typing a name that is not on the list turns
it into `Create "<name>"`, the way the Git branch picker does. Typing into a
plain quick pick otherwise filters everything away and leaves the user looking
at an empty list with no way forward.

On the Welcome page, RuntimeFS folders are tinted with
`welcomePage.runtimeFSForeground` in both the Start list and Recent, and their
Recent entries show no path. A RuntimeFS folder is addressed by name alone, so
the path column could only ever render a bare `~`; the colour carries that
information instead.

Import RuntimeFS Folder appears under File and on the Welcome page in Chromium. It
uses the native directory picker, copies the selected directory into
`OPFS/rfs/<name>`, registers it with RuntimeFS, and opens it as the current
workspace. Replacing an existing folder needs an explicit confirmation.

Export Folder Locally is under File. It asks which RuntimeFS folder to export, then
streams that one folder through RuntimeFS's bundled LittleExport tar writer and the
browser's gzip stream before showing the local save picker. The archive has a
top-level folder named after the RuntimeFS folder, and never includes the rest of
OPFS or RuntimeFS's registry.

Two things worth knowing. Cache invalidation is relayed through the workbench,
because the extension host is a worker with no `ServiceWorkerContainer` and cannot
post `INVALIDATE_CACHE` to RuntimeFS's service worker itself; `static/index.html`
registers `runtimecode.internal.invalidateRfsCache` as an embedder command and the
extension calls it. And `watch()` is a no-op, because OPFS has no change
notification and `FileSystemObserver` is not available in a worker. Edits made
through the provider fire events. Changes made externally, by the RuntimeFS UI or
another tab, are not observed and need Refresh RuntimeFS Cache.

## Previews

Dev Preview opens in the side panel with `Cmd+L Cmd+P` (`Ctrl+Alt+L Ctrl+Alt+P`
elsewhere), or in a new tab with `Alt+Shift+L Alt+Shift+O`. It is hosted by
`rc-preview.html`, reloads when RuntimeFS broadcasts a cache invalidation, and
optionally injects Eruda. It needs these exact standalone Custom Headers lines on
the active RuntimeFS folder:

```text
* -> Cross-Origin-Embedder-Policy: require-corp
* -> Cross-Origin-Opener-Policy: same-origin
```

The prompt Dev Preview shows can add them and refresh RuntimeFS immediately. They
can also be maintained with `runtimecode.sameOrigin.enabled`, or the
Enable/Disable Dev Preview Same-Origin Headers commands.

True Preview (`Alt+Shift+L Alt+O`) opens the target `/n/<Folder>/…` URL directly.
It deliberately has no wrapper, no auto-reload, no cache-buster and no inspector,
so it behaves exactly as RuntimeFS serves the project.

Both need to know where RuntimeFS is, and the bootstrap derives it rather than
taking it as configuration. Served from inside a RuntimeFS folder, the URL says
it: everything before the `/n/` segment is the root, and nothing else could have
served that path. Served from real files on a server instead, RuntimeFS may
still be installed at the origin, and its worker's script URL gives the same
answer: `sw.js` computes its own base as `new URL("./", self.location)` and
`rfs.js` registers it with the default scope, so it controls every page in that
directory and not only the virtual ones. So RuntimeCode can sit at `<root>/rc/`
as ordinary server files, keep a 240 MB editor out of the user's OPFS quota, and
still preview `<root>/n/<Folder>/` normally.

Only when neither holds is the instance standalone, and then the command says so
rather than opening a tab that cannot work. `window.open` and `window.location`
are both unavailable in the extension host worker, so the bootstrap exposes
`runtimecode.internal.getRuntimeFsBase` and `runtimecode.internal.openExternalTab`
as embedder commands.

### Preview inspector

Toggle Preview Inspector is off by default and can be invoked from the Command
Palette or the side-preview toolbar. When enabled it lazy-loads Eruda into that
preview only, giving console evaluation, DOM inspection and network views.
`runtimecode.preview.inspector` persists the choice. The release build downloads
the pinned Eruda 3.4.3 asset, verifies its SHA-256 and places it in
`dist/app/rc-assets/`, so the deployed app does not depend on a third-party CDN
at preview time. A page that blocks injected scripts with a strict CSP shows an
inspector-unavailable message rather than having its CSP weakened.

## Deploying

The build produces two folders, and both have to be uploaded.

| Build output      | Goes to                                                                      | If you skip it                                      |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `dist/app/`       | any RuntimeFS folder, e.g. `/n/RC/`                                          | nothing loads at all                                |
| `dist/host-root/` | the RuntimeFS **host root**, beside RuntimeFS's own `index.html` and `sw.js` | every webview fails, with no useful console message |

Host root means the real origin path RuntimeFS is served from. If RuntimeFS lives
at `https://example.org/projects/RuntimeFS/`, the browser has to be able to fetch
`https://example.org/projects/RuntimeFS/rc-webview-sw.js`. Having that file only
inside `/n/<folder>/` does not work, for the reason in the service worker section
above.

Upload both halves on every upgrade, not just `app/`. The worker carries its own
version number, and the page that registers it passes the version it expects. A
stale host-root copy now refuses to install with a message saying so, rather than
silently serving resources from a worker the workbench has outgrown.

Check a live deployment before trusting it:

```sh
node scripts/check-deploy.mjs https://example.org/projects/RuntimeFS/n/RC/
```

### If webviews are blank

The symptom is `Could not register service worker: ... A bad HTTP response code
(404) was received when fetching the script`. It means `dist/host-root/` was
never uploaded, or landed inside the RuntimeCode folder instead of at the host
root. `check-deploy.mjs` tells you which.

One trap worth naming: a host that rewrites unknown paths to `index.html`
answers `200 text/html` instead of `404`, and registration still fails.
`check-deploy.mjs` checks the content type for exactly this reason.
