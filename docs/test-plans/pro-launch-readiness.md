# Pro Workflow Launch Readiness

Date: 2026-10-18

Scope: keystroke badges, Smart Cut, finishing-effect preview, Instant Share,
direct YouTube publishing, and multi-format export. This is a feature-scoped
production-readiness pass, not a certification of the entire application.

## Release Decision

Do not infer release readiness from a green unit-test suite alone. The desktop
work, hosted-service access controls, live upload acceptance, and the
cross-platform release checks below are separate gates.

The hosted service lives in the separate `recordforge-cloud` repository.
Only its local source has been inspected during this pass. No deployment,
remote data query, real upload, credential change, or cloud-resource change
is authorized by this document.

## Confirmed Baseline Defects

| Area              | Observed defect                                                                                                                                           | Required outcome                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Smart Cut         | The multi-stream graph maps the already-consumed `[a]` label. FFmpeg rejects the graph, and the unchecked exit status turns failure into an empty result. | Map the final detection pad, report process failures, and test with real multi-stream audio.                                  |
| Smart Cut         | Source-media timestamps are applied directly to an edited timeline.                                                                                       | Analyze the edited audio graph so trim, move, speed, gain, mute, solo, and imported-audio decisions use output-timeline time. |
| Preview           | Audio mastering, cards, webcam background, and badges are export-only controls.                                                                           | Provide editable finishing controls in the editor and a local processed preview using the real renderer.                      |
| Keystrokes        | A later keypress replaces the entire previous badge window, erasing its earlier visible portion.                                                          | Truncate the previous window at the new press without retroactively removing it.                                              |
| Keystrokes        | Raw capture times are not remapped through cuts, speed changes, selected ranges, and chunk-local output clocks.                                           | Use explicit source-to-output windows and half-open visibility intervals in preview and export.                               |
| Keystroke privacy | Shift-only typing is captured; the sampler continues through paused wall-clock time.                                                                      | Reject printable typing combinations and align each captured segment to recorded-video time.                                  |
| Webcam background | Only camera overlays are processed; a camera-only recording's primary stream is skipped.                                                                  | Process the primary camera without changing its audio or ordinary screen recordings.                                          |
| Cards/captions    | Intro duration shifts embedded chapters but not the SRT sidecar.                                                                                          | Shift sidecar cue times by the actual intro duration.                                                                         |
| Batch export      | Every incoming export update replaces the displayed primary job.                                                                                          | Track all batch members and keep the selected/primary output stable.                                                          |
| Batch export      | The current canvas is resized even when no alternate format was requested.                                                                                | Preserve the primary canvas's exact dimensions; reuse smart layout only for actual variants.                                  |
| Instant Share     | Shared-link list and renewal wrappers expect envelopes, but native commands return an array and a number.                                                 | Align the IPC adapters with the actual native response shapes.                                                                |
| Instant Share     | Upload metadata is taken from current editor settings rather than the completed export.                                                                   | Resolve the selected completed job, actual media metadata, shifted chapters, and actual sidecars natively.                    |
| BYO sharing       | A signed S3 API endpoint is treated as a public player URL.                                                                                               | Require a configured anonymous public/CDN base URL for static player sharing.                                                 |
| YouTube           | Retry can resend an unconfirmed chunk and treats completed sessions without a recovered video ID as a reason to create a new upload.                      | Resume from the server-confirmed offset and recover completed video identity without duplicate publication.                   |
| YouTube OAuth     | The loopback listener has no deadline, and query parameters are not URL-decoded before code exchange.                                                     | Bound the flow, parse callback parameters correctly, support cancellation, and report connection failures accurately.         |

### Hosted-Service Blocker

The hosted viewer emits `og:video` with the direct playback URL even when a
share is password-protected or expired. The backing R2 object URL is public
and derived from the share identifier. Hiding the URL in HTML alone does not
make password protection effective.

Before advertising protected hosted links, require an approved server-side
access-control design and private storage configuration. Verify both the
viewer/manifest and direct object access. A visual password gate is not an
access-control test.

The hosted source also needs focused ownership, expiry, upload-finalization,
and quota-concurrency checks. Those are not validated by desktop tests.

## Acceptance Gates

### Smart Cut

- A generated tone/silence/tone recording yields the expected pause.
- A second audible source prevents a mixed-audio pause from being cut.
- Trim, movement, speed, mute, and solo affect detection as they affect export.
- Leading and trailing gaps have a zero-based analysis clock.
- Padding preserves speech boundaries; an all-silent recording cannot be
  entirely deleted.
- Every proposed cut is individually reviewable and can be auditioned.
- Editing, switching recordings, cancellation, and stale async completion
  cannot apply old ranges or leave scanning permanently active.
- Selected cuts are one undoable operation; affected locks block safely.
- A failed process, missing audio, or failed save is actionable, not an
  indistinguishable empty result.

### Finishing Preview

- Editor and export controls use the same saved project settings.
- The processed preview uses the real native rendering path, including
  mastering, cards, background processing, badges, and watermark.
- Normal source preview and processed preview are labeled distinctly.
- Preview is opt-in, cancellable, resource-gated, and limited in output
  resolution and retained cache files.
- A changed project revision invalidates the displayed processed result.
- Preview jobs cannot replace real export progress, trigger sharing, or
  resume automatically as real exports after restart.
- Cards' added duration and sidecar offsets agree with the delivered file.
- Camera-only and camera-overlay background processing both work.

### Keystroke Badges

- Badges appear in the ordinary editor canvas and processed preview.
- Position, display duration, and size settings survive save/reopen.
- Cuts, repeated source segments, speed changes, ranges, and chunk seams
  preserve the same badge windows.
- Plain/shifted typing, Option typing, and AltGr text are excluded.
- Pause/resume does not retain paused input or introduce wall-clock drift.
- Unsupported capture platforms and missing permissions are explained.

### Batch Export

- Current-canvas export preserves exact project geometry.
- Each requested variant uses the same variant builder as its preview.
- Validate the complete batch before admitting any job.
- Destinations are unique; an occupied destination cannot silently return a
  different render request as if it were the requested output.
- Each file has stable progress, result, cancellation, retry, and reveal.
- Aggregate progress does not claim success while another output is pending
  or failed.
- Publishing targets an explicitly selected finished file; automatic sharing,
  when armed, applies once to the newly submitted primary output only.

### Publishing

- Share and YouTube requests identify completed real export jobs, not
  arbitrary caller-supplied file paths or mutable editor metadata.
- Upload state and results survive navigation within the running app.
- Progress is correlated with the right job; cancel and retry are explicit.
- Clipboard failure leaves a visible link and never reports a successful copy.
- Hosted limits fail before reserving an upload where locally determinable.
- BYO sharing requires public serving configuration and does not claim that
  hiding a download button or using a public bucket provides access control.
- YouTube status handling distinguishes incomplete, complete, expired,
  authentication failure, rate limit, transport failure, and server failure.
- Session credentials remain in the OS vault; retries cannot publish a
  duplicate after an ambiguous completion response.
- Audience and visibility are explicit, and caption failure is reported
  separately from successful video publication.
- Real uploads are a separate, user-approved acceptance step.

## Validation Ledger

Initial worktree: clean.

Baseline commands passed before implementation:

```text
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop test -- src/features/export
bun run --cwd packages/editor-core test
bun run --cwd packages/contracts test
```

The baseline comprised 31 export tests, 505 editor-core tests, and 123
contract tests. These counts describe the baseline, not the final suite.

Pinned Windows FFmpeg/FFprobe 9.0.1 are available. The broken multi-stream
graph has been reproduced with synthetic media. The repaired graph detects
the inserted silent interval.

The first Smart Cut implementation passed targeted native and TypeScript
checks. Review found additional async-state and review-list issues; those
checks are not treated as final acceptance.

Final commands, evidence artifacts, remaining limitations, and release
acceptance status must be recorded after the complete implementation review.

### Continued Review: 2026-10-19

These are intermediate results, not a release sign-off.

- Rendering the actual Smart Cut controls with `react-dom/server` reproduced
  `SelectItem must be used within SelectContent`. Logic-only tests and
  TypeScript checks did not catch the missing Radix content wrapper.
- Mocking only the native IPC transport reproduced both shared-link contract
  failures: `list_shares` returns an array, and `renew_share` returns a
  timestamp, while the frontend wrappers expect objects.
- Two new measurement regressions failed before the Smart Cut clock fix:
  non-finite timestamps were accepted as NOPTS, and an unstamped leading
  measurement fabricated silence at timeline zero.
- The analysis graph now assigns timestamps from the actual sample count
  after 20 ms framing. Unknown timestamps remain coverage holes; invalid or
  overlapping measurements fail closed rather than becoming proposed cuts.
- `cargo test --offline -j 1 --lib exports::audio_analysis::tests -- --nocapture`
  passed 23 tests with no skips. Real-FFmpeg loud-room, quiet-room, continuous
  sound, digital silence, mixed-track, trim/move/speed, and gain fixtures
  passed without changing the frozen calibration expectations.
- The initial Windows test link failed with LNK1104. A process/file ownership
  check found no running test executable; one offline retry linked normally.
  No unrelated processes were terminated.

Measurement evidence is retained in
`%TEMP%/recordforge-baseline-20261018-100703/metadata-parser-red.log` and
`%TEMP%/recordforge-baseline-20261018-100703/audio-analysis-clock-green.log`.
Preview, batch, publishing, and browser acceptance remain open until their
correction passes and final evidence review are complete.

### Frozen Renderer Captures

The first complete finishing-harness run rendered 15 synthetic cases. All five
aspect rasters, exact frame counts, 30/60 fps, card transition frames, shifted
SRT/VTT and embedded chapters, chunk-seam badge windows, and primary-camera
replacement/blur samples passed their lead-authored checks. All 15 native
delivery manifests also matched the captured FFprobe facts.

That run did not pass Studio Audio acceptance: Gentle and Strong differed by
only about 0.014 dB in the fixed noisy interval. The original capture is kept
under `lead-render-fixtures-20261019/outputs/1dda10a18b5f/`; its failed check is
not relabeled as a pass.

Controlled DSP experiments over the same frozen input found that adaptive
wavelet profiling preserved the tested tonal foreground while producing the
requested 6/12/18 dB noise attenuation across normal and quieter gains. An
offline synthetic-speech fixture starting without a room-tone prefix measured
3.2-3.7 dB SNR improvement and less than 0.3 dB voice-projection change for that
candidate. These are synthetic checks, not a claim of universal speech quality.
The older FFT time-domain speech comparison is not used for a voice-loss claim
because its waveform latency was not aligned.

The native mastering configuration now uses the tested adaptive wavelet budget
mapping. A new real-render regression capture is still required after that
change; the earlier geometry/timing captures remain frozen evidence.

## External Acceptance Still Required

- Approved hosted-service hardening and private-media access verification.
- User-approved live hosted, BYO-bucket, and YouTube uploads, including
  interruption/retry and cancellation.
- Visual and audible review with representative speech/noise and webcam
  footage; synthetic masks do not validate segmentation quality.
- Native Windows capture plus macOS and Linux release acceptance. Portable
  helper tests are not proof of native input permissions or platform capture.
