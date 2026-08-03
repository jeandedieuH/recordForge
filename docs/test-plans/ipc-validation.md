# IPC Validation Test Plan

> **Status:** Draft — Phase 0  
> **Scope:** Malformed IPC input, path traversal, unauthorized operations, DTO drift detection

---

## 1. Input Validation Tests

### 1.1 Recording commands

| Test | Command | Input | Expected |
|------|---------|-------|----------|
| `test_start_empty_source` | `start_recording` | Config with empty source | Validation error |
| `test_start_negative_bounds` | `start_recording` | Source bounds width=-1 | Validation error |
| `test_start_invalid_profile` | `start_recording` | `profile: "nonexistent"` | Error: "unknown profile" |
| `test_start_missing_device` | `start_recording` | `microphoneDeviceId: "fake"` | Warning; recording proceeds without mic |
| `test_marker_empty_label` | `insert_marker` | `label: ""` | Accepted (empty labels allowed) |
| `test_marker_oversized_label` | `insert_marker` | 10,000 char label | Accepted but truncated or limited |

### 1.2 Library commands

| Test | Command | Input | Expected |
|------|---------|-------|----------|
| `test_delete_empty_id` | `delete_recording` | `recording_id: ""` | Error: "recording not found" |
| `test_delete_non_uuid_id` | `delete_recording` | `recording_id: "not-a-uuid"` | Error: "recording not found" |
| `test_delete_sql_injection` | `delete_recording` | `recording_id: "'; DROP TABLE recordings;--"` | Error (parameterized query safe) |
| `test_tag_special_chars` | `add_recording_tag` | `tag: "<script>alert(1)</script>"` | Accepted (stored as-is; rendered safely) |

### 1.3 Recovery commands

| Test | Command | Input | Expected |
|------|---------|-------|----------|
| `test_recover_non_uuid` | `recover_session` | `session_id: "../../../etc/passwd"` | Error: invalid session ID |
| `test_delete_recovery_traversal` | `delete_recovery_session` | `session_id: "../../"` | **P0.7**: Error (path traversal blocked) |
| `test_recover_nonexistent` | `recover_session` | Valid UUID but no session | Error: "manifest not found" |

### 1.4 Media commands

| Test | Command | Input | Expected |
|------|---------|-------|----------|
| `test_prepare_nonexistent_recording` | `prepare_media` | Invalid recording ID | Error: "recording not found" |
| `test_prepare_zero_height` | `prepare_media` | `proxyHeight: 0` | Validation error (min 180) |
| `test_prepare_negative_interval` | `prepare_media` | `thumbnailIntervalSec: -1` | Validation error (min 1) |
| `test_cancel_nonexistent_job` | `cancel_media_job` | Invalid job ID | Error or no-op |

### 1.5 Export commands

| Test | Command | Input | Expected |
|------|---------|-------|----------|
| `test_export_path_traversal` | `export_timeline` | `outputPath: "C:\\Windows\\system32\\evil.mp4"` | Error: blocked destination |
| `test_export_input_path_traversal` | `export_timeline` | Render plan with `inputPath: "C:\\secret.txt"` | Error: paths must use asset IDs |
| `test_export_unc_path` | `export_timeline` | `outputPath: "\\\\server\\share\\file.mp4"` | Error or blocked |

---

## 2. DTO Drift Detection

### 2.1 Golden fixture tests

For each shared DTO, maintain a JSON fixture that is parsed by both TypeScript and Rust:

| Fixture | TypeScript Schema | Rust Struct |
|---------|------------------|-------------|
| `recording-config.json` | `recordingConfigSchema` | `RecordingConfig` |
| `recording-status.json` | `recordingStatusSchema` | `RecordingStatus` |
| `library-recording.json` | `libraryRecordingSchema` | `LibraryRecording` |
| `media-job.json` | `mediaJobSchema` | `MediaJob` |
| `render-plan.json` | `renderPlanSchema` | `RenderPlan` |
| `diagnostics-report.json` | `diagnosticsReportSchema` | `DiagnosticsReport` |
| `encoder-info.json` | `encoderInfoSchema` | `EncoderInfo` |
| `capture-source.json` | `captureSourceSchema` | `CaptureSource` |

### 2.2 Drift detection flow

```
CI step:
1. TypeScript test: parse each fixture with Zod schema → assert success
2. Rust test: deserialize each fixture with serde → assert success
3. Round-trip: Rust serialize → TypeScript parse → assert equal
4. Fail CI if any fixture fails either side
```

### 2.3 Known drift areas

| DTO | TypeScript | Rust | Drift |
|-----|-----------|------|-------|
| `RenderPlan` | Uses `inputPath: string` | Uses `input_path: String` | Both accept paths from frontend (security gap) |
| `RecorderState` | `z.enum([...])` with kebab-case | `#[serde(rename_all = "lowercase")]` | Rust uses lowercase, TS uses kebab-case for some values |
| `MediaJobOutputs` | Optional fields | `Default::default()` | Semantically compatible but untested |

---

## 3. Serde Deserialization Edge Cases

| Test | Input | Expected |
|------|-------|----------|
| `test_extra_fields_ignored` | JSON with unknown fields | Deserialization succeeds (serde default) |
| `test_missing_optional_fields` | JSON without optional fields | Deserialization succeeds with defaults |
| `test_wrong_type_rejected` | `durationMs: "not a number"` | Deserialization error |
| `test_null_required_field` | `sessionId: null` | Deserialization error |
| `test_empty_array` | `fragments: []` | Deserialization succeeds |
| `test_unicode_strings` | `name: "日本語テスト"` | Deserialization succeeds |
| `test_very_long_string` | 1MB string in name field | Deserialization succeeds (or size-limited) |

---

## 4. Rate and Size Limits

| Concern | Test | Expected |
|---------|------|----------|
| Rapid IPC calls | 100 `recording_status` calls in 1s | All succeed, no mutex starvation |
| Large payload | Export with 10,000 render segments | Accepted or rejected with clear limit |
| Concurrent commands | `start` + `stop` in rapid succession | Mutex prevents race; one succeeds, one errors |
