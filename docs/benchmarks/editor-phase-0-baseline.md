# Editor Phase 0 Baseline

> **Status:** Phase 0 baseline recorded
> **Scope:** Current editor behavior before the durable project/editor implementation
> **Fixture source:** `tooling/fixtures/editor-fixtures/`, `tooling/fixtures/cursor-fixtures/`
> **Related:** `docs/benchmarks/editor-p0-reproductions.md`, `docs/specs/editor-action-contract.md`, `docs/adr/010-cursor-engine.md`

This document records the baseline that later editor phases must beat. It intentionally distinguishes code evidence from Windows/manual evidence.

## Current Capability Baseline

| Area                               | Current baseline                                        | Evidence type                               | Phase 0 status                      |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| New editor open                    | Recording-to-timeline bootstrap and project load both work | Source inspection and existing tests        | Recorded                            |
| Existing project reopen            | Project persistence exists; revision-aware save and locks are incomplete | Source inspection                           | Reproduced                          |
| Split/delete/ripple command engine | Core commands have unit coverage                        | Vitest                                      | Passing baseline                    |
| Direct timeline drag/move          | Drag interaction and snap exist; draft/validate/commit/cancel is incomplete | Source inspection                           | Reproduced                          |
| Proxy generation                   | Rust job path exists                                    | Rust/source inspection                      | Hardware/runtime validation pending |
| Thumbnail consumption              | Derivatives are generated; editor does not render them  | Source inspection                           | Reproduced                          |
| Waveform consumption               | PNG is available; peak JSON is not used by timeline     | Source inspection                           | Reproduced                          |
| Camera preview/export              | Camera preview and render-plan overlay path exist       | Source inspection                           | Reproduced                          |
| Canvas styling                     | Canvas schema and render-plan consumption exist         | Source inspection                           | Reproduced                          |
| Captions                           | SRT/VTT import, command, and preview exist              | Source inspection                           | Reproduced                          |
| Manual zoom                        | Zoom segment schema, target clamping, and render plan exist | Source inspection                           | Reproduced                          |
| Masks                              | Mask preview, add/update commands, and render plan exist | Source inspection                           | Reproduced                          |
| Cursor preview                     | Visual baseline exists; CSS click effect is not project-time | Source inspection and cursor contract tests | Reproduced                          |
| Cursor export                      | Rust compositor exists                                  | Rust source/tests                           | Reproduced                          |
| Cursor parity after edits          | Mapping and coordinate fitting differ between React and Rust | Source inspection                           | Reproduced                          |
| Export plan                        | Screen, audio, overlays, captions, masks, zoom, and cursor effects represented | Vitest                                      | Reproduced                          |
| Export cancellation                | Not connected to durable scheduler                      | Source inspection                           | Reproduced                          |
| Long-project timeline              | No accepted 60-minute measurement                       | Manual benchmark                            | Not measured                        |

## Editor Fixture Coverage

The Phase 0 editor fixture bundle must cover:

| Case                                         | Fixture                              |
| -------------------------------------------- | ------------------------------------ |
| 16:9 screen source                           | `1080p30_10s.mp4`                    |
| 4:3 screen source                            | `4_3_aspect_10s.mp4`                 |
| Ultrawide screen source                      | `ultrawide_10s.mp4`                  |
| Camera video asset                           | `camera_10s.mp4`                     |
| Microphone audio asset                       | `microphone_10s.wav`                 |
| System audio asset                           | `system_audio_10s.wav`               |
| Intentional timeline gap and speed change    | `project.json`                       |
| Explicit cuts and locked tracks              | `project-cuts-locks.json`            |
| Duplicate source ranges                      | `project-duplicate-ranges.json`      |
| Cursor positions and left/right click events | `cursor-telemetry.json`              |
| Caption timing and styling input             | `captions.srt`                       |
| Five-minute performance source               | `720p30_5m.mp4` via `--include-long` |
| Imported media without cursor metadata       | `project-no-cursor.json`             |

## Cursor Fixture Coverage

The Phase 0 cursor fixture bundle is in `tooling/fixtures/cursor-fixtures/` and covers:

| Category | Fixture files |
| -------- | ------------- |
| 100% DPI | `cursor-v1-100dpi-10s.json` |
| 125% DPI | `cursor-v1-125dpi-10s.json` |
| 150% DPI | `cursor-v1-150dpi-10s.json` |
| Mixed DPI | `cursor-v1-mixed-dpi-10s.json` |
| Negative virtual-desktop coordinates | `cursor-v1-negative-coords-10s.json` |
| Region capture | `cursor-v1-region-capture-10s.json` |
| Window capture | `cursor-v1-window-capture-10s.json` |
| Left/right clicks | `cursor-v1-left-clicks-10s.json`, `cursor-v1-right-clicks-10s.json` |
| Idle intervals | `cursor-v1-idle-intervals-10s.json` |
| Pause/resume and recovery gaps | `cursor-v1-pause-resume-10s.json`, `cursor-v1-recovery-gap-10s.json` |
| V2 physical pixels, topology, shape/hotspot | `cursor-v2-*.json` |
| Comprehensive 30s edge case | `cursor-comprehensive-30s.json` |

See `tooling/fixtures/cursor-fixtures/README.md` for the full inventory and `tooling/fixtures/cursor-fixtures/generate.ts` for the deterministic recipe.

## Measurements To Capture Later

| Metric                        | Method                                                          | Current value                        | Required evidence          |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------ | -------------------------- |
| Project open time             | Open 5-, 30-, and 60-minute projects; record median             | Not measured                         | Windows baseline machine   |
| Project reopen correctness    | Edit, close, reopen, compare serialized state                   | Fails before revision-aware save     | Automated integration test |
| Timeline first render         | Measure until project content is interactive                    | Not measured                         | Browser/editor harness     |
| Playback drift                | Compare video element time and timeline playhead for 60 seconds | Not measured                         | Automated fixture test     |
| Cursor preview/source mapping | Compare expected telemetry event at selected timeline times     | Diverges after edits                 | Shared fixture test        |
| Thumbnail memory              | Measure with 60-minute thumbnail manifest                       | Not measured                         | Windows baseline machine   |
| Waveform render time          | Measure peak rendering for all audio tracks                     | Not measured                         | Browser/editor harness     |
| Export render duration        | Export fixture at each preset                                   | Not measured                         | Windows baseline machine   |
| Export cancellation cleanup   | Cancel at each render stage and inspect files/jobs              | Fails before durable job integration | Rust integration test      |
| Preview/export parity         | Compare golden frames and audio durations                       | Not measured                         | Cross-language fixtures    |

## Measurement Protocol

1. Use the machine recorded in `docs/benchmarks/baseline-machine.md` after its OS/hardware values are filled in.
2. Generate the fixture bundle before each clean run.
3. Close non-essential applications and wait 30 seconds after startup.
4. Run each measurement three times and record the median.
5. Record the fixture name, project size, derivative state, and export preset.
6. Keep raw logs redacted and exclude user media paths.
7. Record whether the result is automated, Windows manual, or hardware-unverified.

## Phase 0 Exit Evidence

- `docs/specs/editor-capability-matrix.md` is updated to the current branch.
- `docs/specs/editor-phase-0-decisions.md` is approved.
- `docs/specs/editor-action-contract.md` is frozen.
- `docs/adr/010-cursor-engine.md` is recorded and a throwaway prototype is in `tooling/prototypes/cursor-engine-wasm`.
- `docs/benchmarks/editor-p0-reproductions.md` is reproducible from code or controlled fixtures.
- `tooling/fixtures/editor-fixtures/` and `tooling/fixtures/cursor-fixtures/` contain deterministic fixtures and generation succeeds.
- `docs/specs/editor-minimum-window-sizes.md` defines the supported window sizes and the reference screenshot protocol.
- The current baseline is not presented as an editor release gate until measurements are captured.
