# Editor Phase 0 Baseline

> **Status:** Phase 0 baseline in progress
> **Scope:** Current editor behavior before the durable project/editor implementation
> **Fixture source:** `tooling/fixtures/editor-fixtures/`
> **Related:** `docs/benchmarks/editor-p0-reproductions.md`

This document records the baseline that later editor phases must beat. It intentionally distinguishes code evidence from Windows/manual evidence.

## Current Capability Baseline

| Area                               | Current baseline                                        | Evidence type                               | Phase 0 status                      |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| New editor open                    | Recording-to-timeline bootstrap works                   | Source inspection and existing tests        | Recorded                            |
| Existing project reopen            | Edits are regenerated and lost                          | Source inspection                           | Reproduced                          |
| Split/delete/ripple command engine | Core commands have unit coverage                        | Vitest                                      | Passing baseline                    |
| Direct timeline drag/move          | Move command exists; UI interaction is absent           | Source inspection                           | Reproduced                          |
| Proxy generation                   | Rust job path exists                                    | Rust/source inspection                      | Hardware/runtime validation pending |
| Thumbnail consumption              | Derivatives are generated; editor does not render them  | Source inspection                           | Reproduced                          |
| Waveform consumption               | PNG is available; peak JSON is not used by timeline     | Source inspection                           | Reproduced                          |
| Camera preview/export              | Camera state exists; compositor path is incomplete      | Source inspection                           | Reproduced                          |
| Canvas styling                     | Fields exist; full preview/export application is absent | Source inspection                           | Reproduced                          |
| Captions                           | Schema/command only                                     | Source inspection                           | Reproduced                          |
| Manual zoom                        | No implementation                                       | Source inspection                           | Reproduced                          |
| Masks                              | No implementation                                       | Source inspection                           | Reproduced                          |
| Cursor preview                     | Visual baseline exists                                  | Source inspection and cursor contract tests | Partial                             |
| Cursor export                      | Rust compositor exists                                  | Rust source/tests                           | Partial                             |
| Cursor parity after edits          | Mapping differs between React and Rust                  | Source inspection                           | Reproduced                          |
| Export plan                        | Screen/audio plan exists                                | Vitest                                      | Partial                             |
| Export cancellation                | Not connected to durable scheduler                      | Source inspection                           | Reproduced                          |
| Long-project timeline              | No accepted 60-minute measurement                       | Manual benchmark                            | Not measured                        |

## Fixture Coverage

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
| Cursor positions and left/right click events | `cursor-telemetry.json`              |
| Caption timing and styling input             | `captions.srt`                       |
| Five-minute performance source               | `720p30_5m.mp4` via `--include-long` |
| Imported media without cursor metadata       | `project-no-cursor.json`             |

Generated media is ignored by Git and must be recreated locally. Use `--include-long` when generating the five-minute performance source. The checked-in JSON/SRT files are deterministic input data and do not contain machine-specific paths.

## Measurements To Capture Later

| Metric                        | Method                                                          | Current value                        | Required evidence          |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------ | -------------------------- |
| Project open time             | Open 5-, 30-, and 60-minute projects; record median             | Not measured                         | Windows baseline machine   |
| Project reopen correctness    | Edit, close, reopen, compare serialized state                   | Fails before persistence             | Automated integration test |
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

- `docs/specs/editor-capability-matrix.md` is complete.
- `docs/specs/editor-phase-0-decisions.md` is approved.
- `docs/benchmarks/editor-p0-reproductions.md` is reproducible from code or controlled fixtures.
- Fixture generation succeeds or has a documented FFmpeg prerequisite failure.
- The current baseline is not presented as an editor release gate until measurements are captured.
