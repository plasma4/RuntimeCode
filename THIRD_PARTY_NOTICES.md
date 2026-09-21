# Third-Party Notices

RuntimeCode redistributes Microsoft's VS Code along with various third-party
components. The editor and everything in this repository that builds it are MIT.
Two things are not covered by that, deliberately: extensions, which each carry
their own license in their own folder, and `homepage/`, which is AGPL-3.0.

Contents

`scripts/staticify.mjs` writes `dist/app/LICENSE` and
`dist/app/ThirdPartyNotices.txt` into every build. That second file is, in order:

1. this document,
2. the per-extension notices, generated from each extension's manifest,
3. the upstream checkout's `LICENSE.txt`,
4. the upstream checkout's `ThirdPartyNotices.txt`.

Nothing here duplicates the upstream file, which is 180 KB and changes with
every VS Code release; it is read from `$RUNTIMECODE_VSCODE` during the build so
it can never go stale. For the same reason the extension notices are generated
rather than written out here: a hand-maintained list is a list that goes stale
the first time someone adds an extension in a hurry.

## RuntimeCode

Licensed under the MIT License; see [LICENSE](LICENSE). That covers the
bootstrap in `static/`, the patch series, the overlay, and everything under
`scripts/` — in short, the editor as built.

## Extensions

Every folder under `extensions/` is a separate work with its own terms, and
ships with its own license file beside its code. `scripts/check-licenses.mjs`
fails the build if one does not.

The current set (`runtimefs`, `runtime-host`, `lua-wasmoon`, `python-rc`) is
RuntimeCode's own and MIT, so today the distinction costs nothing. It exists for
what comes next: per [RUNTIMES.md](RUNTIMES.md) and [NEXT.md](NEXT.md), several
of the runtime packs worth shipping are GPL, and they need somewhere to live
that does not relicense the host.

That works because the web extension host loads an extension by reading one
source file and calling `new Function('module','exports','require', src)`
(`extHostExtensionService.ts:87`). Extensions are never linked into
`workbench.web.main.js` and never share a compilation unit with it. The
resulting aggregation is what lets a GPL extension sit beside an MIT workbench
without either license reaching the other, and the build preserves it
physically: each extension keeps its own directory, its own manifest and its own
license text, all the way into `dist/app/rc-extensions/`.

Two rules keep it honest, both from NEXT.md: never patch a vendored runtime and
fold the patch into the host, and record where a copyleft extension's
corresponding source lives. The second is enforced — a GPL or AGPL extension
must declare `"runtimecode": { "source": ... }` in its manifest, naming either an
upstream revision or `"in-tree"` when the shipped folder is the complete source.

`dist/app/rc-extensions/LICENSES.md` is the generated index of all of this, and
it ships inside the artifact so a reader who downloaded only `dist/app/` can
answer the question without leaving the folder.

## Homepage

`homepage/` is AGPL-3.0-or-later and is the only part of this repository that is
not MIT. It builds to `dist/homepage/`, a separate artifact from `dist/app/`,
and the license gate refuses to let AGPL text appear anywhere under `dist/app/`
outside `rc-extensions/`. It covers the landing page's markup, stylesheet and
artwork, and nothing else: not the editor, not the extensions, and not anything
written using them.

## VS Code (Code - OSS)

`dist/app/` is a compiled copy of [microsoft/vscode](https://github.com/microsoft/vscode)
at the tag pinned in `vscode.pin`. Copyright (c) 2015 - present Microsoft
Corporation, licensed under the MIT License. The product has been modified and
rebranded; the modifications live in this repository, not in a fork.

RuntimeCode is not affiliated with or endorsed by Microsoft.

## Bundled dependencies

The web package bundles the production dependencies listed in
`dist/app/package.json` (xterm, katex, `vscode-oniguruma`, `vscode-textmate`,
the `@vscode/*` packages, and so on), the built-in extensions under
`dist/app/extensions/`, and the `node_modules/` tree those extensions need.
Their notices are part of the upstream `ThirdPartyNotices.txt` appended at
build time. Extensions that ship their own `ThirdPartyNotices.txt` or license
files keep them in place under `dist/app/extensions/`.

## Eruda

The opt-in Dev Preview inspector vendors Eruda 3.4.3 into
`dist/app/rc-assets/eruda.js`. MIT:

```text
The MIT License (MIT)

Copyright (c) 2016-present liriliri

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## wasmoon (Lua runtime pack)

`extensions/lua-wasmoon/` vendors wasmoon 1.16.0 (the UMD and the wasm module)
and ships the upstream license beside them as
`assets/LICENSE-wasmoon`. wasmoon is MIT:

```text
MIT License

Copyright (c) 2023 Gabriel Francisco

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The wasm module embeds Lua 5.4 itself, which is also MIT:

```text
Copyright © 1994–2026 Lua.org, PUC-Rio.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Language packs

Per [RUNTIMES.md](RUNTIMES.md), every runtime pack added later must record its
license in `dist/packs/<id>/pack.json` and emit the upstream license into
`dist/packs/<id>/LICENSE`. That is a separate artifact from `dist/app/` and is
not covered by the file above. Until that pipeline exists (M2), the in-tree Lua
pack records its upstream tarball and per-asset digests in
`extensions/lua-wasmoon/pack.json` and ships the upstream license under its
`assets/`; `test/luapack.test.mjs` checks both.
