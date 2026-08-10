# Project Format Specification

> **Status:** Draft — Phase 1  
> **Scope:** Defines the on-disk project file format, asset registry, versioning, and persistence rules  
> **Owner:** `packages/domain`, `packages/contracts`, Rust `projects` module

---

## 1. Overview

A recordForge **project** is an editable timeline referencing immutable recording assets. Projects are non-destructive — all edits are metadata references into source media. The project file is the single source of truth for the editor state.

---

## 2. On-Disk Format

### 2.1 File location

Projects are stored alongside their source recording:

```
sessions/{session_id}/
    session.json           # Recording manifest
    output.mp4             # Immutable original
    project.json           # Project file (editor state)
    project.json.bak       # Last known good backup
    derivatives/
        proxy/proxy.mp4
        thumbnails/
        waveform/
```

### 2.2 `project.json` Schema

```jsonc
{
  "format": "recordforge.project",
  "version": 1,
  "id": "project-uuid",
  "name": "Recording abc12345",
  "recordingId": "session-uuid",
  "canvas": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "background": "#000000",
    "padding": 0,
    "borderRadius": 0,
    "shadow": false,
  },
  "assets": [
    {
      "id": "asset-uuid-screen",
      "role": "screen",
      "path": "output.mp4", // Relative to project dir
      "status": "available",
      "durationMs": 180000,
      "width": 1920,
      "height": 1080,
      "fps": 30,
      "hasAudio": true,
      "streamIndex": null,
    },
    {
      "id": "asset-uuid-webcam",
      "role": "webcam",
      "path": "webcam_000.mp4",
      "status": "available",
      "durationMs": 180000,
      "width": 1280,
      "height": 720,
      "fps": 30,
      "hasAudio": false,
      "streamIndex": null,
    },
  ],
  "tracks": [
    {
      "id": "track-uuid-screen",
      "kind": "screen",
      "name": "Screen",
      "muted": false,
      "locked": false,
      "solo": false,
      "volume": 1.0,
      "clips": [
        {
          "id": "clip-uuid",
          "kind": "screen",
          "assetId": "asset-uuid-screen",
          "startMs": 0,
          "durationMs": 180000,
          "sourceInMs": 0,
          "sourceOutMs": 180000,
          "speed": 1.0,
        },
      ],
    },
  ],
  "markers": [],
  "zoomSegments": [],
  "smartZoomSettings": {
    "preset": "product-demo",
    "minDwellMs": 700,
    "dwellTolerancePx": 12,
    "clickLeadInMs": 220,
    "clickDurationMs": 1100,
    "dwellLeadInMs": 160,
    "dwellTailMs": 540,
    "minSegmentDurationMs": 500,
    "maxSegmentDurationMs": 2400,
    "safeEdgePadding": 32,
    "targetScale": 1.5,
    "includeClicks": true,
    "includeDwells": true
  },
  "exportSettings": {
    "preset": "default-mp4",
    "codec": "h264",
    "container": "mp4",
    "captionMode": "burn-in",
    "range": null,
  },
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:05:00Z",
  "checksum": "sha256:abc...",
}
```

### 2.3 Checksum

The `checksum` field holds `sha256:<hex>` where the hex value is the SHA-256 digest of the canonical JSON of the project object with the `checksum` field removed. Rust recomputes it on every atomic save and validates it on every load, falling back to `project.json.bak` when the primary file is corrupt.

---

### 2.4 Asset fields

| Field         | Type      | Required | Description                                               |
| ------------- | --------- | -------- | --------------------------------------------------------- |
| `id`          | string    | yes      | UUID that clips use as `assetId`                          |
| `role`        | string    | yes      | One of the roles in §3.1                                  |
| `path`        | string    | yes      | Path relative to the project directory                    |
| `status`      | string    | no       | `available` (default), `missing`, or `relinked`          |
| `durationMs`  | integer   | no       | Cached source duration in milliseconds                    |
| `width`       | integer   | no       | Cached video width                                        |
| `height`      | integer   | no       | Cached video height                                       |
| `fps`         | float     | no       | Cached frame rate                                         |
| `hasAudio`    | boolean   | no       | Whether the source has at least one audio stream          |
| `streamIndex` | integer   | no       | Optional FFmpeg stream index used for multi-stream files  |

## 3. Asset Registry

### 3.1 Asset Roles

| Role            | Description                          | Source                                    |
| --------------- | ------------------------------------ | ----------------------------------------- |
| `screen`        | Primary screen/window/region capture | Recording session                         |
| `microphone`    | Independent mic audio track          | Native WASAPI capture                     |
| `system_audio`  | Independent system audio track       | Native WASAPI loopback                    |
| `webcam`        | Webcam sidecar video                 | Separate FFmpeg process                   |
| `cursor_events` | Cursor position/click metadata       | Editor Phase 5 capture/editor integration |
| `image`         | User-imported image overlay          | Manual import                             |
| `caption`       | Text/subtitle data                   | User-created                              |

### 3.2 Asset Resolution

Assets store paths relative to the project directory. Rust resolves absolute paths at load time:

```rust
let absolute = project_dir.join(&asset.path);
// Validate: absolute.starts_with(project_dir) — containment check
```

**Security rule:** The render pipeline NEVER accepts paths from React/IPC. It resolves paths from asset IDs through the project's asset registry.

### 3.3 Missing Asset Handling

If an asset file is missing on project load:

1. Set its `status` to `missing` in the project file
2. Mark the asset as missing in the UI
3. Offer a "Relink" action for the user to locate the file
4. Do not allow export with missing assets
5. Do not silently skip missing assets

---

## 4. Versioning and Migration

### 4.1 Format and version fields

Every project file has a `format` discriminator and a `version` integer. Parsers must check both before loading.

The current runtime `TimelineState.version = 1` is not a persisted project format because the editor does not currently save it. Durable project version 1 is reserved for the shape defined by this document and must not be inferred from the runtime state.

### 4.2 Forward-only migration

The initial durable project format is version 1. Future migrations must be added to this table before a new project version is released:

| From | To  | Changes |
| ---- | --- | ------- |
| 1    | 2   | TBD     |

### 4.3 Migration rules

- Migrations are run automatically on project load
- Each migration step is applied in order
- The original file is backed up to `project.json.bak` before migration
- If migration fails, the original is preserved and an error is shown

---

## 5. Persistence Rules

### 5.1 Atomic writes

Projects are written atomically using the same temp-file + rename pattern as manifests:

1. Serialize to JSON
2. Write to `project.json.tmp`
3. Rename → `project.json`
4. Update `project.json.bak` (copy of previous version)

### 5.2 Autosave

- Autosave triggers after every command that modifies the project (debounced to 2 seconds)
- Autosave writes to `project.json` via atomic write
- A manual save indicator shows dirty/saving/saved/error states

### 5.3 Backup snapshots

- Before destructive operations (delete track, ripple delete), create a snapshot
- Snapshots are stored as `project.{timestamp}.json.bak` (max 5, oldest pruned)

---

## 6. SQLite Index

Projects are indexed in the `projects` table for library queries:

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    project_json TEXT NOT NULL,   -- Full JSON for quick load
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);
CREATE INDEX idx_projects_recording ON projects(recording_id);
```

---

## 7. Current Implementation Gaps

| Gap                     | Current State                                          | Required                                            |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| No project persistence  | Projects regenerated with new IDs on every editor open | Load/save `project.json`                            |
| No asset registry       | `recordingId` assumed to be single-file                | Asset array with roles                              |
| No autosave             | —                                                      | Debounced atomic writes                             |
| No dirty state tracking | —                                                      | Dirty/saving/saved/error indicators                 |
| No backup snapshots     | —                                                      | Pre-destructive snapshots                           |
| No migration            | —                                                      | Version-gated forward-only migration                |
| History unbounded       | Editor command history grows without limit             | Cap at N commands, coalesce adjacent                |
| No checksum             | —                                                      | SHA-256 of project content for corruption detection |

---

## 8. Time Semantics

A recordForge project uses three coordinate systems for time:

| Coordinate | Description | Source of truth |
| ---------- | ----------- | --------------- |
| Source     | A position in an immutable source asset (ms) | Asset file and `clip.sourceInMs` / `clip.sourceOutMs` |
| Timeline   | A position in the editable project (ms) | `clip.startMs` and `clip.durationMs` on tracks |
| Output     | A position in the final rendered/previewed file (ms) | Render plan `outputStartMs` / `outputEndMs` or preview playhead |

### 8.1 Clip time model

Each clip stores five time fields:

- `startMs` — position on the timeline where the clip begins.
- `durationMs` — how long the clip occupies on the timeline.
- `sourceInMs` — source time corresponding to `startMs`.
- `sourceOutMs` — source time corresponding to `startMs + durationMs`.
- `speed` — playback rate. `durationMs = (sourceOutMs - sourceInMs) / speed`.

### 8.2 Default output mapping

By default, the output timeline preserves the timeline position of every clip. This means an intentional gap (a span with no clip on the relevant track) becomes silence or black filler. The total output duration is the maximum `startMs + durationMs` across all clips and markers.

### 8.3 Squeeze/gapless mapping

A caller may request a compressed output (`squeezeGaps: true`). In that mode the output removes the duration of all gaps and plays only clip content. Audio, video, and overlay segments must use the same squeezed output coordinate system so they remain synchronized.

### 8.4 Marker behavior

Markers are timeline-level references. Under edit commands they behave as follows:

- **Trim/split** — markers keep their timeline time unless the clip they were anchored to is removed or the marker falls in a trimmed-away range.
- **Ripple delete** — markers inside the deleted time range are removed; markers after the deleted range shift left by the deleted duration.
- **Trim timeline ends** — markers outside the trimmed range are removed; markers inside shift to the new start.

### 8.5 Track locks and timing

A locked track cannot be modified by direct clip commands or ripple delete. Ripple delete still removes the same output time window from unlocked tracks; locked tracks keep their clips unchanged. This preserves the editor's intent while protecting finished tracks from accidental edits.
