# RuntimeCode

A static, de-Microsoft'd build of VS Code for the browser. Easily ship a plain folder of files, with optional extension components with their own licenses to support other languages (TODO: Python, JS, C...)

RuntimeCode is not affiliated with or endorced by Microsoft.

## Building

You **must** have the [Microsoft VSCode repo](https://github.com/microsoft/vscode) cloned at `../vscode` in order to build. Note that 24GB RAM is recommended for a cold build (or an overnight build session, with potential custom configuration necessary) and 16GB for warm ones.

```sh
nvm use 24.18.0
node scripts/prepare.mjs     # checkout pin, apply overlay + product + patches
node scripts/build.mjs       # gulp + staticify + endpoint gate
node scripts/serve.mjs       # http://127.0.0.1:8099
```

## Upgrading

```sh
node scripts/upgrade.mjs 1.138.0          # fast build
node scripts/upgrade.mjs 1.138.0 --min    # release build
```

Those commands will update the pinned version, reinstall dependencies, and run a full build.

Patch-fixing notes: it's possible to fix by hand in `../vscode` and then regenerate that one patch from the working tree. You can write non-code text in the header safely for explanations. Do NOT hand-write `.patch` files.

## RuntimeFS integration/explanation

TODO
