# Capture and Recovery Test Plan

> **Status:** Draft — Phase 0  
> **Scope:** Test scenarios for capture state machine, segment lifecycle, crash recovery, and forced-exit behavior

---

## 1. State Machine Tests (Rust unit tests)

### 1.1 Happy path transitions

| Test | Input | Expected |
|------|-------|----------|
| `test_idle_to_recording` | `start()` with valid config | State → `Recording`, session ID returned |
| `test_recording_to_paused` | `pause()` while recording | State → `Paused`, segment finalized |
| `test_paused_to_recording` | `resume()` while paused | State → `Recording`, new segment started |
| `test_recording_to_completed` | `stop()` while recording | State → `Completed`, output.mp4 exists |
| `test_paused_to_completed` | `stop()` while paused | State → `Completed`, segments concatenated |

### 1.2 Guard clause tests

| Test | Input | Expected |
|------|-------|----------|
| `test_start_while_recording` | `start()` while already recording | Error: "a recording is already active" |
| `test_pause_when_idle` | `pause()` when idle | Error: "no active recording" |
| `test_resume_when_idle` | `resume()` when idle | Error: "no active recording" |
| `test_stop_when_idle` | `stop()` when idle | Error: "no active recording" |
| `test_resume_when_recording` | `resume()` while recording | Error: "recording is already in progress" |
| `test_start_unknown_profile` | `start()` with profile="nonexistent" | Error: "unknown profile" |
| `test_start_no_source` | `start()` with empty source | Error or IPC validation failure |

### 1.3 Marker tests

| Test | Input | Expected |
|------|-------|----------|
| `test_marker_during_recording` | `insert_marker()` while recording | Marker added to manifest |
| `test_marker_during_pause` | `insert_marker()` while paused | Marker added with accumulated timestamp |
| `test_marker_when_idle` | `insert_marker()` when idle | Error: "no active recording" |

---

## 2. Segment and Manifest Tests (Rust unit tests)

### 2.1 Manifest persistence

| Test | Action | Verification |
|------|--------|-------------|
| `test_manifest_created_on_start` | Start recording | `session.json` exists in work dir |
| `test_manifest_updated_on_pause` | Pause recording | Manifest state = "paused" |
| `test_manifest_updated_on_resume` | Resume recording | Manifest state = "recording", new fragment |
| `test_manifest_updated_on_stop` | Stop recording | Manifest state = "completed", outputPath set |
| `test_manifest_atomic_write` | Write manifest | `session.json.tmp` does not exist after write |
| `test_manifest_rewrite_is_atomic_and_durable` | Write, mutate, and rewrite manifest | Existing manifest is replaced and the latest state can be read |

### 2.2 Fragment lifecycle

| Test | Action | Verification |
|------|--------|-------------|
| `test_fragment_created_on_start` | Start recording | Fragment 0 in manifest, `validated: false` |
| `test_fragment_validated_on_pause` | Pause recording | Fragment validated, sizeBytes > 0 |
| `test_new_fragment_on_resume` | Resume after pause | Fragment index incremented |
| `test_only_validated_fragments_concatenated` | Stop with mixed fragments | Only `validated: true` segments in output |
| `test_recording_insert_is_idempotent` | Insert the same manifest twice | One SQLite row and the same library ID on retry |

---

## 3. Recovery Tests (Rust integration tests)

### 3.1 Recovery scan

| Test | Setup | Expected |
|------|-------|----------|
| `test_scan_empty_sessions_dir` | Empty sessions dir | Empty results |
| `test_scan_completed_session` | Manifest with state=completed | Skipped (not in results) |
| `test_scan_recording_with_fragments` | Manifest state=recording, 2 validated fragments | `isRecoverable: true` |
| `test_scan_recording_no_fragments` | Manifest state=recording, 0 fragments | `isRecoverable: false` |
| `test_scan_corrupt_manifest` | Invalid JSON in session.json | Result with `validationError` |
| `test_scan_missing_manifest` | Session dir without session.json | Not in results |

### 3.2 Recovery execution

| Test | Setup | Expected |
|------|-------|----------|
| `test_recover_with_fragments` | 2 validated fragments, no output.mp4 | Segments concatenated, library entry created |
| `test_recover_existing_output` | Valid output.mp4 already exists | Use existing output, create library entry |
| `test_recover_no_valid_fragments` | 0 validated fragments | Error: "no valid fragments" |
| `test_recover_updates_manifest` | Recovery successful | Manifest state = "completed" |

### 3.3 Recovery deletion (P0.7)

| Test | Input | Expected |
|------|-------|----------|
| `test_delete_valid_session` | Valid UUID session ID | Session dir removed |
| `test_delete_path_traversal` | `session_id = "../../"` | **MUST FAIL** — path traversal blocked |
| `test_delete_path_traversal_encoded` | `session_id = "..%2F.."` | **MUST FAIL** |
| `test_delete_nonexistent_session` | Non-existent UUID | No error (idempotent) |
| `test_delete_non_uuid` | `session_id = "not-a-uuid"` | Error: invalid session ID |

---

## 4. Forced-Exit Scenarios (Integration / Manual)

### 4.1 Process kill during recording

| Scenario | Setup | Kill Method | Verification |
|----------|-------|-------------|-------------|
| Kill during first segment (no rollover) | Start 1080p30, record 10s | `taskkill /f` | Fragmented MP4/physical segment is surfaced when the interrupted container remains readable; periodic rollover remains a follow-up |
| Kill after first rollover | Record > rollover interval | `taskkill /f` | Finalized segments recovered |
| Kill during pause | Pause recording, then kill | `taskkill /f` | All prior segments recovered |
| Kill during stop/finalization | Trigger stop, kill during concat | `taskkill /f` | Segments available, output.mp4 may be corrupt |
| Power loss simulation | Record 5 min | Kill power/VM | Manifest + validated segments on disk |

### 4.2 Recovery after forced exit

| Scenario | Verification |
|----------|-------------|
| App restart after kill | Recovery scan finds incomplete session |
| User recovers session | output.mp4 created from fragments, library entry added |
| User discards session | Session directory removed cleanly |
| Multiple incomplete sessions | All shown in recovery UI |

---

## 5. Manual QA Scenarios

### 5.1 Capture correctness

| Scenario | Steps | Expected |
|----------|-------|----------|
| Display capture 1080p30 | Select display → Balanced → Start → Record 1 min → Stop | Clean 1080p30 MP4, no artifacts |
| Window capture (P0.2) | Select a window → Start → Move window → Stop | Currently: desktop crop. Required: tracks window |
| Window minimized | Start window capture → Minimize target → Stop | Graceful handling |
| Region capture | Select region → Start → Record 30s → Stop | Correct bounds, no distortion |
| Non-16:9 region (P0.5) | Select 4:3 or ultrawide region | Currently: distorted. Required: aspect preserved |
| Mixed DPI | 125% scaling display → Capture | Correct coordinates and content |

### 5.2 Audio correctness

| Scenario | Steps | Expected |
|----------|-------|----------|
| Mic only | Enable mic, disable system audio → Record → Stop | Audio in output from mic |
| System audio (P0.3) | Enable system audio, disable mic → Record → Stop | Currently: may fail without Stereo Mix |
| Mic + system (P0.4) | Enable both → Record → Stop → Check tracks | Currently: single mixed track |
| No audio | Disable all audio → Record → Stop | Valid video-only MP4 |
| Audio device disconnect | Record with mic → Unplug mic during recording | Warning, continue video |
