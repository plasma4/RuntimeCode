# homepage/

The landing page. **AGPL-3.0, and the only folder here that is.** Everything
else in this repo is MIT, and the two are kept apart by being different folders
with different build outputs. `scripts/check-licenses.mjs` asserts that, so
moving a file from here into `static/` or `extensions/` fails the build rather
than quietly relicensing the editor.

`index.html` is currently an empty valid document. It exists so
`scripts/homepage.mjs` has something to copy and `scripts/build.mjs` runs end to
end; there is no site yet.

There is no build step, on purpose. Hand-written HTML and one stylesheet, no web
fonts and no third-party requests, so `node scripts/homepage.mjs` is a copy plus
two checks. A landing page advertising a static, serverless, telemetry-free
editor should not itself need a toolchain or a CDN.

`LICENSE` must stay the verbatim AGPL-3.0 text from
<https://www.gnu.org/licenses/agpl-3.0.txt>. `homepage.mjs` checks for it by
name and refuses a paraphrase.

This README does not ship. `homepage.mjs` skips it, along with `.DS_Store` and
`node_modules/`; the `LICENSE` beside it is the part the public needs and is
kept.
