# Recovery and Session Format Specification

> **Status:** Draft — Phase 0  
> **Scope:** On-disk session format, manifest schema, fragment lifecycle, recovery protocol  
> **Owner:** Rust `capture::manifest`, `capture::recovery`, `capture::session`

---

## 1. Session Directory Layout

Each recording session creates a directory under `{app_data_dir}/sessions/{session_id}/`:

```
sessions/
  {uuid}/
    session.json           # The manifest (authoritative session state)
    session.json.tmp       # Atomic write temporary (renamed to session.json)
    seg_000.mp4            # First video segment
    seg_001.mp4            # Second video segment (after pause/resume or rollover)
    webcam_000.mp4         # Webcam sidecar for segment 0 (if enabled)
    output.mp4             # Concatenated final output (created on stop/recovery)
    derivatives/           # Phase 4: proxy, thumbnails, waveform
      metadata/
      proxy/
      thumbnails/
      waveform/
```

---

## 2. Manifest Schema (`session.json`)

```jsonc
{
  "version": 1,
  "sessionId": "uuid-string",
  "state": "recording",        // RecorderState enum value
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:05:00Z",
  "source": {                  // Redacted copy of CaptureSource
    "kind": "display",
    "id": "display-0",
    "name": "Display 1",
    "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
  },
  "profileName": "balanced",
  "workDir": "C:\\Users\\...\\sessions\\{uuid}",
  "outputPath": "C:\\Users\\...\\sessions\\{uuid}\\output.mp4",
  "fragments": [
    {
      "index": 0,
      "fileName": "seg_000.mp4",
      "startedAt": "2026-01-01T00:00:03Z",
      "stoppedAt": "2026-01-01T00:00:33Z",
      "durationMs": 30000,
      "sizeBytes": 15728640,
      "validated": true          // FFprobe-verified after stop
    }
  ],
  "markers": [
    {
      "id": "uuid",
      "label": "Important moment",
      "timestampMs": 15000,
      "createdAt": "2026-01-01T00:00:18Z"
    }
  ],
  "totalRecordedMs": 30000,
  "stats": {                   // Populated at stop time
    "framesProcessed": 900,
    "fps": 30.0,
    "speed": 1.0,
    "exitCode": 0,
    "durationMs": 30000,
    "outputSizeBytes": 15728640
  }
}
```

---

## 3. Fragment Lifecycle

A fragment represents a single continuous FFmpeg capture segment.

```mermaid
stateDiagram-v2
    [*] --> Active : FFmpeg started
    Active --> Stopped : FFmpeg quit signal sent
    Stopped --> Validated : FFprobe check passes (size > 1KB, valid container)
    Stopped --> Invalid : FFprobe fails or size < 1KB
    Validated --> [*] : Available for concatenation and recovery
    Invalid --> [*] : Skipped during concatenation
```

### Fragment Fields

| Field | Type | Description |
|-------|------|-------------|
| `index` | `u32` | Zero-based segment index |
| `fileName` | `string` | File name relative to `workDir` (e.g., `seg_000.mp4`) |
| `startedAt` | `datetime` | UTC timestamp when FFmpeg started |
| `stoppedAt` | `datetime?` | UTC timestamp when FFmpeg stopped (null if still active) |
| `durationMs` | `u64?` | Duration reported by FFmpeg stderr parsing |
| `sizeBytes` | `u64?` | File size after stop |
| `validated` | `bool` | Whether FFprobe confirmed the segment is a valid MP4 |

---

## 4. Manifest Write Protocol

### Atomic writes
The manifest is written atomically using a temp-file + rename pattern:
1. Serialize to JSON pretty-print
2. Write to `session.json.tmp`
3. Rename `session.json.tmp` → `session.json`

On Windows, `std::fs::rename` is atomic within the same volume.

### Write triggers
The manifest MUST be written on every state transition:
- `Recording` → opened
- Fragment validated (segment rollover)
- `Paused` → fragment finalized
- `Recording` resumed → new fragment started
- `Stop` → final fragment validated, `outputPath` set, state → `Completed`
- Marker added
- Stats updated

### Current gap
The manifest is written during state transitions, but there is no periodic write during continuous recording. If FFmpeg is killed during the first segment before any rollover, the manifest reflects `Recording` state but the only fragment has `validated: false`, making recovery impossible.

**Required fix (Phase 2):** Periodic segment rollover (e.g., every 30 seconds) during continuous recording, independent of pause/resume.

---

## 5. Recovery Protocol

### 5.1 Startup Scan

On app startup, scan `sessions/` for directories containing `session.json`:

```rust
for each session_dir in sessions/:
    manifest = read(session_dir/session.json)
    if manifest.state != Completed:
        classify as recovery candidate
```

### 5.2 Recovery Classification

| Manifest State | Valid Fragments | Existing `output.mp4` | Classification |
|----------------|----------------|----------------------|----------------|
| `completed` | Any | Any | Skip (already done) |
| `recording`/`paused`/`finalizing` | > 0 | No | Recoverable — concat fragments |
| `recording`/`paused`/`finalizing` | > 0 | Yes (> 1KB) | Already recovered or partial — use existing output |
| `recording`/`paused`/`finalizing` | 0 | No | Unrecoverable — no valid data |
| `failed` | Any | Any | Show error; offer manual recovery or delete |
| Unreadable manifest | — | — | Report as corrupt; offer delete |

### 5.3 Recovery Execution

1. Collect all fragments where `validated == true && sizeBytes > 0`
2. Sort by `index`
3. Create FFmpeg concat demuxer file
4. Run `ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4`
5. Validate output with FFprobe
6. Update manifest: `state → Completed`, `outputPath → output.mp4`
7. Insert into library database as `recovered` status

### 5.4 Recovery Deletion

**Current security gap (P0.7):** `delete_recovery_session` joins an IPC-supplied `session_id` string directly into a path:

```rust
// CURRENT (UNSAFE):
let work_dir = sessions_dir.join(session_id);
std::fs::remove_dir_all(&work_dir);
```

**Required fix:** Validate that `session_id` is a valid UUID and that the resolved path is contained within `sessions_dir`.

---

## 6. Session Assets (Phase 2+)

Each session will track multiple asset types:

| Asset Kind | File Pattern | Track Independence |
|------------|-------------|-------------------|
| `screen` | `seg_NNN.mp4` | Primary video track |
| `microphone` | `mic_NNN.wav` | Separate audio (Phase 2: WASAPI) |
| `system_audio` | `sys_NNN.wav` | Separate audio (Phase 2: WASAPI loopback) |
| `webcam` | `webcam_NNN.mp4` | Separate timestamped video |
| `marker` | In manifest | Metadata only |
| `cursor_events` | `cursor.json` | Metadata (Phase 6) |

### Current gap (P0.4)
Microphone and system audio are currently mixed into the screen segment's audio track by FFmpeg's `-f dshow` input. They are not independently controllable in the editor. Phase 2 separates them using WASAPI capture into independent files.

---

## 7. Version Migration

| Version | Changes |
|---------|---------|
| 1 (current) | Initial schema; single video segment + mixed audio |
| 2 (Phase 2) | Add asset registry; separate audio tracks; periodic rollover config |
| 3 (Phase 5) | Add project reference; derivative recipe versions |

Manifests are forward-only. A v2 reader must handle v1 manifests by treating the single segment as a combined screen+audio asset.
