# Working on RuntimeCode

Every command here runs against the vscode checkout at `../vscode`, which is an
input to this repo and not part of it. `prepare` re-applies our divergence to
that checkout, `build` turns it into `dist/`, and `serve` hosts what you just
built.

```sh
nvm use 24.18.0                        # the version in ../vscode/.nvmrc
node scripts/prepare.mjs               # overlay/, product.overlay.json, patches/
node scripts/build.mjs                 # gulp + staticify + homepage + the two gates  (--min to minify, --full to recompile)
node scripts/homepage.mjs              # just the landing page; needs no vscode checkout
node scripts/check-licenses.mjs        # every extension states its terms, and AGPL stays out of app/
node scripts/serve.mjs                 # http://127.0.0.1:8099  (also /app/ and /homepage/)
node scripts/serve.mjs --simulate-rfs  # the same build under /n/RuntimeCode/, fixtures at /n/<name>/
node scripts/serve.mjs --coi           # ...plus COOP+COEP, for measuring cross-origin isolation
node --test test/                      # the RuntimeFS extension and the build helpers
node scripts/typecheck.mjs             # tsc over extensions/; run once so the editor stops complaining
node scripts/upgrade.mjs 1.138.0       # pin a new upstream tag and rebuild
node scripts/check-deploy.mjs https://example.org/projects/RuntimeFS/n/RC/
```

Changing `extensions/`, `static/` or `scripts/`? `build.mjs` is enough, and a
warm one takes about half a minute. Changing `product.overlay.json`, `overlay/`
or `patches/`? Run `prepare.mjs` first, and expect a longer build. Changing
`homepage/`? `homepage.mjs` alone, which is instant and does not read the
checkout at all.

`build.mjs` refuses to start if the checkout is not prepared. Anything that
resets the vscode tree — a `git reset --hard`, a tag checkout, an interrupted
upgrade — silently drops the whole divergence, and every downstream step keeps
working: gulp builds, staticify rebrands from `product.overlay.json` on its own,
the endpoint gate passes, and `dist/` looks finished. What it actually contains
is an unpatched workbench with blank webviews and no RuntimeFS entries on the
Welcome page. The check is `git apply --reverse --check` per patch, which
succeeds only when the patch is already in the tree.

## Adding an extension

A directory under `extensions/` with a `package.json` is an extension, and the
build treats it as one. It needs two things it will not build without:

- a `"license"` field holding an SPDX id, and
- a `LICENSE` file beside the code.

A GPL or AGPL extension also needs `"runtimecode": { "source": ... }` in its
manifest, naming either the exact upstream revision the shipped binary was built
from or `"in-tree"` when the folder is the complete corresponding source. See
the Licensing section in [README.md](README.md) for why the boundary is drawn at
the folder.

Register it in `static/index.html` as an `additionalBuiltinExtensions` entry and
add its `jsconfig.json` to `PROJECTS` in `scripts/typecheck.mjs`. Everything
else — the copy into `rc-extensions/`, the license index, the notices — is
generated.

`--coi` is the only thing `serve.mjs` will ever inject a header for. Cross-origin
isolation comes from the document's response headers, which in production are
RuntimeFS Custom Headers on the folder, so nothing a static build does can turn
it on locally. Everything the dev server hosts is same-origin, so `require-corp`
costs nothing here; measure what it breaks against a real deployment.

## Exercising Dev Preview locally

Dev Preview needs to find RuntimeFS, and it looks in two places: the `/n/`
segment of its own URL, and the script URL of the service worker controlling the
page. Plain `serve.mjs` offers neither, so the command reports standalone rather
than opening a tab that cannot work.

`--with-rfs` serves a real RuntimeFS at `/`, so once its UI has been opened once
and the worker is registered with scope `/`, the build at `/rc/` is controlled by
it and the second derivation finds the root. Whether the rest of that layout
holds up is unverified: RuntimeFS's worker then sees every request for the
workbench's own assets too, and `sw.js:535` rewrites a non-virtual URL into a
virtual one when the referrer is virtual. A page at `/rc/` has a non-virtual
referrer and should pass straight through, but that is reasoning, not a
measurement. `NETWORK_ALLOWLIST_PREFIXES` at `sw.js:2` is the hook for making it
explicit. Test it before treating the server-path layout as supported.

Two ways to get a `/n/` URL, and they answer different questions.

`node scripts/serve.mjs --simulate-rfs` puts the build at `/n/RuntimeCode/` and
`fixtures/` at `/n/<name>/`. Open http://127.0.0.1:8099/n/RuntimeCode/. Good for
URL derivation, the wrapper page, the Custom Headers prompt, the inspector, and
True Preview. It cannot show you a live edit: the preview iframe is served from
`fixtures/` on disk by this server, while the editor reads `rfs:` out of OPFS.
Same URL, two different stores. A workspace whose name has no fixture behind it
previews as a 404; name it `TestProject` and it previews that fixture, and goes
on previewing it however much you edit the OPFS copy.

`node scripts/serve.mjs --with-rfs` serves a RuntimeFS checkout at `/`. Upload
`dist/app/` through the RuntimeFS UI as a folder, open `/n/<that folder>/`, and
you are running what ships. This is the only local setup where RuntimeFS's
service worker serves the preview out of OPFS, which means it is the only one
that tests the loop that matters: save, `INVALIDATE_CACHE`, iframe reload, new
content. The `/rc/` mount that mode also provides is standalone, and Dev Preview
will refuse there for the same reason as above.

The extensions are checked JavaScript, not TypeScript, because the web extension
host loads them with `new Function('module','exports','require', src)` and there
is no build step to compile a `.ts` file with. `typecheck.mjs` copies
`vscode.d.ts` out of the checkout into `extensions/types/`, which is gitignored,
and runs `tsc` from the checkout. Until it has run once, the editor cannot
resolve `require('vscode')` and reports a few hundred errors in one file.

There are no npm scripts, because this repo has no dependencies of its own. Both
halves of the editor in `dist/` have to be uploaded on every deploy, and
`dist/homepage/` is a third, independent artifact under a different license; see
the deploy table in [README.md](README.md).
