# ADR 010: Cursor Evaluation Engine — Rust+WASM vs Compiled Motion Plan

> **Status:** Proposed — Phase 0 architecture decision  
> **Date:** 2026-08-10  
> **Scope:** How the editor preview and export share one canonical cursor evaluator  
> **Related:** `editor-ui-cursor-imrovement-plan.md`, `packages/cursor-core/src/index.ts`, `apps/desktop/src-tauri/src/exports/cursor.rs`

## Context

The editor currently evaluates the cursor in two places:

- **Preview (React/TypeScript):** `packages/cursor-core/src/index.ts` provides `findCursorEventAtTime`, `smoothCursorPosition`, `fitCursorPoint`, and `isCursorIdle`. The overlay in `custom-cursor-overlay.tsx` uses these to render an SVG cursor with Tailwind CSS click feedback.
- **Export (Rust):** `apps/desktop/src-tauri/src/exports/cursor.rs` provides `CursorRenderer`, which rasterizes the cursor into each output frame.

The two paths differ in:

1. Coordinate fitting (DPI scale, capture bounds, canvas padding).
2. Click-effect timing (CSS animation in preview vs. project-time calculation in Rust).
3. Zoom application order and clamping.
4. Asset representation (React SVG vs. Rust primitive rendering).

The plan requires a single canonical evaluator used by both preview and export, deterministic seeking, and low-end performance.

## Decision

Use a **Rust+WASM evaluator** as the canonical cursor engine. The same Rust code is compiled once to WebAssembly for the React preview and linked natively for the Rust export. This is the preferred path.

A **compiled motion-plan fallback** is approved only if the Rust+WASM path cannot meet the following acceptance criteria during Phase 6 prototyping:

- Same frame output within 0.5 pixel and 1 output frame between WASM and native.
- 60-minute telemetry evaluates in < 4 ms per frame on the Windows 11 baseline machine.
- Total compiled artifact size < 2 MB.
- No blocking synchronous calls between the React main thread and the evaluator.

If the fallback is needed, it must still use the same Rust core compiled to a motion plan that is consumed by both preview and export, preserving parity.

## Options Considered

### Option A: Rust core compiled to WebAssembly (chosen)

- **Preview:** `packages/cursor-core` loads the WASM module and calls `evaluate_frame(time_ms, canvas, zoom, settings)`.
- **Export:** Tauri links the same crate natively.
- **Pros:**
  - Single source of truth for coordinate fitting, smoothing, click effects, idle, shape resolution, and zoom.
  - Seek-safe and project-time based by construction.
  - V2 metadata (physical pixels, affine transform, topology, shapes) is owned by the language that already captures it.
- **Cons:**
  - Adds a `wasm32-unknown-unknown` target and build step.
  - Adds a JavaScript/WASM bridge for asset transfer and frame evaluation.
  - Requires keeping the Rust core free of async I/O and threading assumptions that do not map to WASM.

### Option B: Compiled motion plan consumed by both sides

- **Approach:** At project open, Rust or a Tauri command compiles the telemetry and settings into a motion plan (key-frame list, spline segments, click effect intervals, shape change markers). The plan is sent to the React preview as a compact JSON/binary structure and to the Rust export as a serializable plan. Both sides implement the same interpreter.
- **Pros:**
  - Moves expensive work to a one-time compilation step.
  - Preview can run at high frequency without scanning the full telemetry array each frame.
  - Smaller runtime surface area in the browser thread.
- **Cons:**
  - Still requires two interpreters (TypeScript and Rust) that must be proven equivalent.
  - Compilation step must run on every edit that affects cursor timing or range.
  - Does not naturally solve the current shape/hotspot and asset representation split.

### Option C: Keep two implementations and add parity tests

- **Approach:** Improve the existing TypeScript and Rust code and cover them with golden tests.
- **Pros:**
  - No new build pipeline.
- **Cons:**
  - Does not eliminate the root cause of parity drift.
  - Maintaining two click-effect, smoothing, and zoom implementations is unsustainable as V2 metadata grows.
  - Rejected.

## Consequences

- `packages/cursor-core` becomes a thin TypeScript wrapper around the WASM module plus high-level helpers (range lookup, effect merging, time mapping).
- `apps/desktop/src-tauri/src/exports/cursor.rs` is refactored into a shared crate that can be built for both native and `wasm32` targets.
- Cursor assets (shape icons, hotspots) are rasterized or packed into a manifest that both preview and export consume.
- The CSS `animate-ping` click effect is replaced by a project-time evaluation function.
- A V1→V2 normalization adapter must live in Rust so old telemetry can be evaluated by the new engine.

## Phase 0 Prototype

Phase 0 does not build the full engine. It records the decision and produces a **prototype artifact** in `tooling/prototypes/cursor-engine-wasm`.

The prototype artifact contains:

1. `Cargo.toml` and `src/lib.rs` for a minimal `cursor-evaluator` crate that builds the core algorithms:
   - event index search,
   - EMA smoothing,
   - coordinate fitting with DPI/capture bounds,
   - idle detection,
   - click-effect progress,
   - zoom transform.
2. `build-wasm.sh` and `build-native.sh` scripts that compile the crate for `wasm32-unknown-unknown` and `x86_64-pc-windows-msvc`.
3. `tests/parity.rs` golden tests that run the native build against the V1/V2 fixtures and assert deterministic output.

The crate is intentionally throwaway. Phase 6 will either fold it into `apps/desktop/src-tauri` as a shared module or keep it as a separate `packages/cursor-engine` workspace member.

## Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| WASM bundle size grows with Rust dependencies | Keep the evaluator crate `no_std`-friendly or limit dependencies; strip debug info. |
| Main-thread jank from large asset transfers | Use `SharedArrayBuffer`/WASM memory with a compact cursor asset manifest. |
| `wasm32` target not installed | Add `rustup target add wasm32-unknown-unknown` to setup docs; keep native-only CI gate until installed. |
| V1 telemetry compatibility | Implement a Rust `CursorTelemetryV1Adapter` that converts V1 fields into the V2 evaluation model. |
| Compiled motion plan becomes necessary | Preserve a motion-plan serialization seam in the evaluator so a fallback can reuse the same core. |

## Acceptance Criteria for Closing This ADR

- [ ] `tooling/prototypes/cursor-engine-wasm` builds for `wasm32-unknown-unknown`.
- [ ] Native build passes parity tests for `cursor-v1-100dpi-10s.json` through `cursor-v2-topology-multi-10s.json`.
- [ ] A simple HTML page (or React test harness) can load the WASM module and render the same cursor position as the Rust export for the same input.
- [ ] The decision is either confirmed, modified, or reverted with a new ADR before Phase 6 implementation.
