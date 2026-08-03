# P0 Blocker Bug Reproductions

> **Status:** Phase 0 Baseline  
> **Scope:** Reproductions, failure modes, and verification tests for P0.1–P0.10

---

## Summary Matrix

| ID | Title | Domain | Reproduction Method | Status |
|----|-------|--------|---------------------|--------|
| **P0.1** | Crash during first segment unrecoverable | Capture / Recovery | Rust test `test_p0_1_first_segment_crash_unrecoverable` | Confirmed |
| **P0.2** | Window capture uses desktop crop / occlusion | Native capture | Manual test scenario in `docs/test-plans/capture-recovery.md` §5.1 | Confirmed |
| **P0.3** | System audio fails without Stereo Mix | Native audio | Manual test scenario in `docs/test-plans/capture-recovery.md` §5.2 | Confirmed |
| **P0.4** | Mic + system audio mixed in single track | Native audio | Manual test scenario in `docs/test-plans/capture-recovery.md` §5.2 | Confirmed |
| **P0.5** | Non-16:9 aspect ratio distorted | Native capture | Manual test scenario in `docs/test-plans/capture-recovery.md` §5.1 | Confirmed |
| **P0.6** | Manifest/DB state ordering on stop | Capture / Storage | Rust test in `tests/p0_blocker_tests.rs` | Confirmed |
| **P0.7** | Path traversal in `delete_recovery_session` | Security | Rust test `test_p0_7_path_traversal_in_delete_recovery_session` | Confirmed |
| **P0.8** | Recording deletion non-atomic | Storage | Rust test `test_p0_8_delete_recording_non_atomic` | Confirmed |
| **P0.9** | `migrate_v2` drops existing recording data | Database | Rust test `test_p0_9_migrate_v2_destroys_recordings` | Confirmed |
| **P0.10** | Export fails on incomplete / partial output | Export | Manual test scenario in `docs/test-plans/media-export.md` §3 | Confirmed |

---

## Detailed Reproductions

### P0.1 — Crash Recovery During First Segment
- **Root Cause**: Fragments are only created and validated upon `pause()` or `stop()`. Continuous recording during the initial segment does not periodically flush or validate fragments.
- **Impact**: Force-quitting or crashing prior to the first pause/stop loses all captured media even if FFmpeg wrote data.
- **Verification**: `test_p0_1_first_segment_crash_unrecoverable` verifies that `scan_recovery` returns `is_recoverable: false` when state is `Recording` with 0 validated fragments.

### P0.2 — Window Capture Occlusion and DPI Crop
- **Root Cause**: Window capture uses bounding rectangle crop on GDI display capture (`gdigrab`) rather than native Graphics Capture / BitBlt window handle.
- **Impact**: If the window is occluded by another window, moving, or minimized, the recording captures whatever is physically on screen at those coordinates.

### P0.3 — System Audio Failure Without Stereo Mix
- **Root Cause**: FFmpeg invokes `-f dshow` with DirectShow audio devices, requiring an active virtual audio router or hardware "Stereo Mix" device.
- **Impact**: Standard Windows 10 laptops without Stereo Mix enabled fail to capture system audio.

### P0.4 — Mixed Audio Tracks
- **Root Cause**: Microphone and system audio are combined directly into the MP4 container's single audio stream via FFmpeg filter.
- **Impact**: Editor cannot adjust microphone and system audio levels independently.

### P0.5 — Non-16:9 Aspect Ratio Distortion
- **Root Cause**: Presets scale non-16:9 source bounds directly to fixed profile resolution (e.g. 1920x1080) without pillarboxing/letterboxing.
- **Impact**: Stretched/squished video for 4:3, ultrawide, or custom region recordings.

### P0.6 — Manifest vs. Database Ordering
- **Root Cause**: On stop, database insert occurs after file concatenation, but manifest write and cleanup lack transactional boundaries.

### P0.7 — Path Traversal in `delete_recovery_session`
- **Root Cause**: `sessions_dir.join(session_id)` is passed directly to `std::fs::remove_dir_all` without checking if `session_id` is a valid UUID or verifying path containment.
- **Impact**: Malicious or malformed IPC payload `session_id = "../path"` deletes arbitrary directories outside the app sandbox.
- **Verification**: `test_p0_7_path_traversal_in_delete_recovery_session` demonstrates deletion of arbitrary directory outside `sessions_dir`.

### P0.8 — Non-Atomic Recording Deletion
- **Root Cause**: `delete_recording` executes SQL `DELETE FROM recordings` first. If file removal fails (file locked, missing), the DB record is already gone, leaking orphaned files.
- **Verification**: `test_p0_8_delete_recording_non_atomic` verifies DB row removal happens regardless of file system state.

### P0.9 — Data Destruction in `migrate_v2`
- **Root Cause**: `migrate_v2` executes `DROP TABLE IF EXISTS recordings`.
- **Impact**: Upgrading schema wipes user database.
- **Verification**: `test_p0_9_migrate_v2_destroys_recordings` demonstrates data wipe.

### P0.10 — Export Partial Output Handling
- **Root Cause**: Export writes directly to output destination without `.partial` extension or validation stage, leaving corrupt partial files if cancelled or crashed.
