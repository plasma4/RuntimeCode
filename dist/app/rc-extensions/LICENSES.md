# Extension licenses

Each folder here is a separate work with its own terms. The workbench they
load into is MIT; an extension is not, unless its own license says so.

The web extension host loads each of these by reading one source file and
calling `new Function(...)`, so no extension is linked into or bundled with
the workbench. They are aggregated, not combined.

| Extension | License | Full text |
| --- | --- | --- |
| Lua (wasmoon) (`lua-wasmoon`) | MIT | [`lua-wasmoon/LICENSE`](lua-wasmoon/LICENSE) |
| Python (RuntimeCode) (`python-rc`) | MIT | [`python-rc/LICENSE`](python-rc/LICENSE) |
| Runtime Host (`runtime-host`) | MIT | [`runtime-host/LICENSE`](runtime-host/LICENSE) |
| RuntimeFS (`runtimefs`) | MIT | [`runtimefs/LICENSE`](runtimefs/LICENSE) |
