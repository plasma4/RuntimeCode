# Working on RuntimeCode

Every command here runs against the vscode checkout at `../vscode`, which is an
input to this repo and not part of it. `prepare` re-applies our divergence to
that checkout, `build` turns it into `dist/`, and `serve` hosts what you just
built.

```sh
nvm use                                # 24.18.0, per ../vscode/.nvmrc
node scripts/prepare.mjs               # overlay/, product.overlay.json, patches/
node scripts/build.mjs                 # gulp + staticify + endpoint gate  (--min to minify, --full to recompile)
node scripts/serve.mjs                 # http://127.0.0.1:8099
node scripts/serve.mjs --simulate-rfs  # the same build under /n/RuntimeCode/, fixtures at /n/<name>/
node --test test/                      # the RuntimeFS extension
node scripts/typecheck.mjs             # tsc over extensions/; run once so the editor stops complaining
node scripts/upgrade.mjs 1.138.0       # pin a new upstream tag and rebuild
node scripts/check-deploy.mjs https://example.org/projects/RuntimeFS/n/RC/
```

Changing `extensions/`, `static/` or `scripts/`? `build.mjs` is enough, and a
warm one takes about half a minute. Changing `product.overlay.json`, `overlay/`
or `patches/`? Run `prepare.mjs` first, and expect a longer build.

The extensions are checked JavaScript, not TypeScript, because the web extension
host loads them with `new Function('module','exports','require', src)` and there
is no build step to compile a `.ts` file with. `typecheck.mjs` copies
`vscode.d.ts` out of the checkout into `extensions/types/`, which is gitignored,
and runs `tsc` from the checkout. Until it has run once, the editor cannot
resolve `require('vscode')` and reports a few hundred errors in one file.

There are no npm scripts, because this repo has no dependencies of its own. Both
halves of `dist/` have to be uploaded on every deploy; see the deploy table in
[README.md](README.md).
