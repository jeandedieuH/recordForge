# Media Export Test Plan

> **Status:** Draft — Phase 8 implementation
> **Scope:** Golden media comparison, partial output cleanup, cancel behavior, export pipeline validation

---

## 1. Export Correctness Tests

### 1.1 Simple export (stream copy)

| Test | Input | Expected Output |
|------|-------|----------------|
| `test_export_copy` | 30s 1080p30 recording | Identical copy at destination |
| `test_export_file_integrity` | Exported MP4 | FFprobe: valid container, correct duration, correct codecs |
| `test_export_preserves_audio` | Recording with audio | Audio track present and correct duration |
| `test_export_video_only` | Recording without audio | Video-only MP4 |

### 1.2 Trim export

| Test | Input | Expected Output |
|------|-------|----------------|
| `test_trim_start` | Trim first 5s from 30s clip | 25s output |
| `test_trim_end` | Trim last 5s from 30s clip | 25s output |
| `test_trim_middle` | Keep 10s-20s of 30s clip | 10s output |
| `test_trim_zero_duration` | Trim where start == end | Error: zero duration |
| `test_trim_inverted_range` | start > end | Error: invalid range |
| `test_trim_beyond_duration` | end > total duration | Error or clamp to duration |

### 1.3 Render plan export (Phase 8)

| Test | Input | Expected Output |
|------|-------|----------------|
| `test_render_single_segment` | One full clip | Output matches source |
| `test_render_multiple_segments` | Three clips concatenated | Correct total duration |
| `test_render_with_gaps` | Two clips with 2s gap | Gap filled with black/silence |
| `test_render_speed_change` | Clip at 2× speed | Duration = source / 2 |
| `test_render_audio_mix` | Mic at 50%, system at 100% | Both tracks mixed at specified volumes |
| `test_render_webcam_pip` | Screen + webcam overlay | Webcam visible at specified position |
| `test_render_canvas` | 1080p canvas with padding | Output matches canvas dimensions |
| `test_render_camera_speed` | Camera clip at 2× speed | Overlay timing matches preview |
| `test_render_captions_masks_cursor` | Combined Phase 7 effects | All enabled effects are present or export is blocked |
| `test_render_selected_range` | Selected timeline range | Output starts at zero and preserves internal gaps |

---

## 2. Partial Output and Cleanup Tests

### 2.1 Atomic output

| Test | Expected |
|------|----------|
| `test_export_writes_partial` | During export, `.partial` file exists, final file does not |
| `test_export_renames_on_complete` | After export, final file exists, `.partial` does not |
| `test_export_validates_before_rename` | FFprobe runs on `.partial` before rename |
| `test_export_corrupt_partial` | If FFprobe fails, `.partial` deleted, error reported |

### 2.2 Cancel cleanup

| Test | Action | Expected |
|------|--------|----------|
| `test_cancel_during_export` | Start export, cancel at 50% | `.partial` file deleted, no final file |
| `test_cancel_race_completion` | Cancel right as export finishes | Either cancel succeeds (no file) or completion wins (file exists) |
| `test_cancel_idempotent` | Cancel twice | Second cancel is no-op |

---

## 3. Export Job Persistence Tests (P0.10)

### 3.1 Phase 8 lifecycle contract

| Concern | Phase 8 behavior |
|---------|------------------|
| Job persistence | Export request is stored in `media_jobs.options` before the worker starts |
| Job identity | Scheduler-created id is used from command response through completion/cancellation/retry |
| Cancellation | AtomicBool is checked between stages and while cursor frames are streamed |
| App restart | Pending/running export rows are reloaded from persisted options |
| Retry | Failed/cancelled row is re-queued with the same id and stale partial files removed |

### 3.2 Job lifecycle tests

| Test | Expected |
|------|----------|
| `test_export_job_persisted` | Job row exists in `media_jobs` before FFmpeg starts |
| `test_export_job_progress` | Progress updates emitted during export |
| `test_export_job_completed` | Job status = "completed", outputs contain path |
| `test_export_job_failed` | On FFmpeg error, job status = "failed", error message set |
| `test_export_job_cancelled` | On cancel, job status = "cancelled", partial cleaned |
| `test_export_job_restart` | App restart with pending export → job resumed |
| `test_export_retry_same_identity` | Retry failed export | Same job id, no stale partial/published output |

---

## 4. Golden Media Validation

### 4.1 Fixture generation

Use synthetic media fixtures for deterministic validation:

```bash
# Generate a 10s 1080p30 test video with audio
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=10" \
       -f lavfi -i "sine=frequency=440:duration=10" \
       -c:v libx264 -preset ultrafast -crf 23 \
       -c:a aac -b:a 128k \
       -y test_1080p30_10s.mp4
```

### 4.2 Validation criteria

| Check | Method | Tolerance |
|-------|--------|-----------|
| Duration | FFprobe `format.duration` | ± 100ms |
| Resolution | FFprobe `streams[0].width/height` | Exact |
| Frame count | FFprobe `streams[0].nb_frames` | ± 1 frame |
| Video codec | FFprobe `streams[0].codec_name` | Exact |
| Audio codec | FFprobe `streams[1].codec_name` | Exact |
| Audio sample rate | FFprobe `streams[1].sample_rate` | Exact |
| File size | `fs::metadata` | Within 10% of expected |
| Container valid | FFprobe exits with 0 | Exact |

---

## 5. Export UI Integration Tests

| Test | Steps | Expected |
|------|-------|----------|
| `test_export_button_connected` | Open editor → Click Export | Export dialog appears (not disconnected) |
| `test_export_shows_progress` | Start export | Progress bar visible with percentage |
| `test_export_shows_completion` | Export finishes | Success toast with file size/path |
| `test_export_shows_error` | Export fails (disk full) | Error toast with actionable message |
| `test_export_cancel_button` | Start export → Cancel | Export stopped, toast confirms cancellation |

---

## 6. Edge Cases

| Test | Scenario | Expected |
|------|----------|----------|
| `test_export_disk_full` | Export to full disk | Error before or during write; no corrupt file |
| `test_export_readonly_dest` | Export to read-only directory | Error with permission message |
| `test_export_overwrite` | Export to existing file | Confirmation dialog; overwrite or rename |
| `test_export_long_path` | Path > 260 chars on Windows | Extended path prefix or error |
| `test_export_special_chars` | Filename with spaces, unicode | Correct file created |
| `test_export_network_path` | UNC path destination | Handled or blocked with message |
