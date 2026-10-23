import { describe, expect, it } from "vitest"
import { mediaJobOutputsSchema, type MediaJob } from "@recordforge/contracts"
import { latestCompletedExport } from "./media"

function makeJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id: "job-1",
    recordingId: "recording-1",
    kind: "export",
    status: "completed",
    progress: 1,
    stage: "done",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:05:00.000Z",
    completedAt: "2026-10-01T10:05:00.000Z",
    outputs: {
      ...mediaJobOutputsSchema.parse({}),
      outputPath: "C:/exports/rendered.mp4",
    },
    ...overrides,
  }
}

describe("latestCompletedExport", () => {
  it("returns the newest completed export with an output path", () => {
    const older = makeJob({ id: "old", completedAt: "2026-10-01T10:00:00.000Z" })
    const newer = makeJob({
      id: "new",
      completedAt: "2026-10-02T10:00:00.000Z",
      outputs: {
        ...mediaJobOutputsSchema.parse({}),
        outputPath: "C:/exports/latest.mp4",
      },
    })
    // Input order should not matter — the pick sorts by completion time.
    expect(latestCompletedExport([newer, older])?.id).toBe("new")
    expect(latestCompletedExport([older, newer])?.id).toBe("new")
  })

  it("ignores non-export jobs and unfinished exports", () => {
    const prepare = makeJob({
      id: "prepare",
      kind: "prepare",
      completedAt: "2026-10-03T10:00:00.000Z",
    })
    const runningExport = makeJob({
      id: "running",
      status: "running",
      completedAt: null,
    })
    const failedExport = makeJob({ id: "failed", status: "failed" })
    expect(latestCompletedExport([prepare, runningExport, failedExport])).toBeUndefined()
  })

  it("ignores completed exports without an output file on record", () => {
    const noOutput = makeJob({ outputs: mediaJobOutputsSchema.parse({}) })
    expect(latestCompletedExport([noOutput])).toBeUndefined()
  })

  it("returns undefined for recordings that were never exported", () => {
    expect(latestCompletedExport([])).toBeUndefined()
  })
})
