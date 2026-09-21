# Python (RuntimeCode)

The host shell for Python in the browser: one Run command, one terminal, three
interchangeable runtimes (Pyodide, CPython on WASI, MicroPython), plus the pack
autosystem (install / uninstall / cleanup) that every language's runtimes
install through.

- `Python: Run File` / `Python: Run Selection` — run through a pseudoterminal.
- `Python: Select Runtime...` — pick the runtime a run uses, showing tiers,
  sizes and install state.
- `Python: Install Runtime Pack...` / `Uninstall Runtime Pack...` / `Clean Up
  Orphaned Pack Folders` — the pack autosystem (RUNTIMES.md M2). Packs are
  copied from `/n/RC-Packs/` into OPFS, verified by digest, and registered in
  `rfs/.runtimecode/packs.json` for the bootstrap to load on reload.
- `Python: Show Runtime Diagnostics` — what this deployment can do, what each
  runtime claims, and where its bytes were looked for.

No runtime wasm ships in this build. `scripts/packs.mjs` produces `dist/packs/`
from pinned sources; until a pack is installed and its engine's `createSession`
is written (RUNTIMES.md M3), a run ends in a preflight report instead of program
output. That report is the honest answer to "why did nothing run".