// View-state and media-error-keying logic for ProcessedPreviewDialog. The
// rendered states are proven in the dev-harness browser captures (Radix
// portals need a real DOM); these tests pin the pure selection rules —
// especially the dead-end where an old playback error suppressed a rebuilt
// player's mount.
import { describe, expect, it } from "vitest"
import { computePreviewView, mediaErrorApplies, type MediaError } from "./processed-preview-dialog"

const err = (overrides: Partial<MediaError> = {}): MediaError => ({
  jobId: "job-1",
  src: "tauri://asset/a.mp4",
  message: "dead file",
  ...overrides,
})

describe("mediaErrorApplies", () => {
  it("applies only to the exact job+source pair that raised it", () => {
    expect(mediaErrorApplies(err(), "job-1", "tauri://asset/a.mp4")).toBe("dead file")
    // Rebuild admitted a new job: the old error must not suppress the mount.
    expect(mediaErrorApplies(err(), "job-2", "tauri://asset/a.mp4")).toBeNull()
    // Same job, freshly published file path.
    expect(mediaErrorApplies(err(), "job-1", "tauri://asset/b.mp4")).toBeNull()
    // No source mounted at all.
    expect(mediaErrorApplies(err(), "job-1", null)).toBeNull()
    expect(mediaErrorApplies(null, "job-1", "tauri://asset/a.mp4")).toBeNull()
  })
})

describe("computePreviewView", () => {
  const completedJob = { status: "completed" }

  it("shows exactly one state — submission error wins over everything", () => {
    // A retry that failed to submit must not display beside the previous
    // completed player's still-cached job.
    expect(
      computePreviewView({
        submissionError: "missing assets",
        building: false,
        job: completedJob,
        hasOutput: true,
        activeVideoError: null,
      }),
    ).toBe("submission-error")
    // Even while a prior job still reads running in the store.
    expect(
      computePreviewView({
        submissionError: "missing assets",
        building: true,
        job: { status: "running" },
        hasOutput: false,
        activeVideoError: null,
      }),
    ).toBe("submission-error")
  })

  it("prioritizes building over a stale completed job", () => {
    expect(
      computePreviewView({
        submissionError: null,
        building: true,
        job: completedJob,
        hasOutput: true,
        activeVideoError: null,
      }),
    ).toBe("building")
  })

  it("recovers: completed job with a foreign-keyed error still plays", () => {
    // The old videoError belongs to job-1; job-2 completed on the same file
    // path — the player must mount (onLoadedData can then clear the error).
    expect(
      computePreviewView({
        submissionError: null,
        building: false,
        job: completedJob,
        hasOutput: true,
        activeVideoError: null,
      }),
    ).toBe("completed")
    expect(
      computePreviewView({
        submissionError: null,
        building: false,
        job: completedJob,
        hasOutput: true,
        activeVideoError: "dead file",
      }),
    ).toBe("playback-error")
  })

  it("maps failed/cancelled to job-error and missing job to empty", () => {
    const base = { submissionError: null, building: false, activeVideoError: null }
    expect(computePreviewView({ ...base, job: { status: "failed" }, hasOutput: false })).toBe(
      "job-error",
    )
    expect(computePreviewView({ ...base, job: { status: "cancelled" }, hasOutput: false })).toBe(
      "job-error",
    )
    expect(computePreviewView({ ...base, job: null, hasOutput: false })).toBe("empty")
    // Completed status but nothing to play — surface empty, not a broken player.
    expect(computePreviewView({ ...base, job: completedJob, hasOutput: false })).toBe("empty")
  })
})
