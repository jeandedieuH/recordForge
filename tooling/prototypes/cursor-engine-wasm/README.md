# Cursor Engine WASM Prototype

This is a **throwaway prototype** for the Rust+WASM cursor evaluator decision in `docs/adr/010-cursor-engine.md`.

## Scope

- Prove the same Rust code can evaluate cursor position, smoothing, idle, and click effects for both native export and WebAssembly preview.
- Run a parity smoke test against the Phase 0 V1/V2 cursor fixtures.
- Do not integrate into the desktop app; that is Phase 6 work.

## Build

### Native (parity smoke test)

```bash
cd tooling/prototypes/cursor-engine-wasm
./build-native.sh
```

### WebAssembly

```bash
cd tooling/prototypes/cursor-engine-wasm
./build-wasm.sh
```

Requires:
- `wasm-pack` (`cargo install wasm-pack`)
- `rustup target add wasm32-unknown-unknown`

## Output

- `src/lib.rs` implements the canonical evaluator.
- `tests/parity.rs` loads fixtures from `tooling/fixtures/cursor-fixtures/` and prints evaluated positions.
- `pkg/` is created by `build-wasm.sh` and contains the `.wasm` and JS glue.

## Status

This crate is intentionally not wired into the recordForge workspace. Phase 6 will either fold the evaluator into `apps/desktop/src-tauri` or create a shared `packages/cursor-engine` crate.
