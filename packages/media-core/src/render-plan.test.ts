import { describe, expect, it } from "vitest"
import type { LibraryRecording, TimelineState } from "@recordforge/domain"
import { buildRenderPlan } from "./render-plan"

function makeTimeline(clipCount = 1): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
    },
    tracks: [
      {
        id: "track-1",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: Array.from({ length: clipCount }, (_, index) => ({
          id: `clip-${index}`,
          kind: "screen" as const,
          assetId: "rec-1",
          startMs: index * 20_000,
          durationMs: 20_000,
          sourceInMs: index * 20_000,
          sourceOutMs: (index + 1) * 20_000,
          speed: 1,
        })),
      },
    ],
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const recording: LibraryRecording = {
  id: "rec-1",
  sessionId: "session-1",
  name: "Test recording",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  durationMs: 60_000,
  sizeBytes: 0,
  width: 1920,
  height: 1080,
  fps: 30,
  status: "completed",
  tags: [],
  source: {
    kind: "display",
    id: "display-1",
    name: "Display 1",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  },
  profileName: "balanced",
  outputPath: "/tmp/rec-1/output.mp4",
  workDir: "/tmp/rec-1",
  markers: [],
}

describe("render-plan", () => {
  it("builds a plan from a single screen clip", () => {
    const plan = buildRenderPlan({
      state: makeTimeline(),
      recording,
      outputPath: "/tmp/export.mp4",
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.segments).toHaveLength(1)
    expect(plan.value.segments[0].sourceInMs).toBe(0)
    expect(plan.value.segments[0].sourceOutMs).toBe(20_000)
    expect(plan.value.segments[0].outputStartMs).toBe(0)
    expect(plan.value.segments[0].outputEndMs).toBe(20_000)
    expect(plan.value.audio?.muted).toBe(false)
  })

  it("builds a plan with continuous output times", () => {
    const plan = buildRenderPlan({
      state: makeTimeline(3),
      recording,
      outputPath: "/tmp/export.mp4",
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.segments).toHaveLength(3)
    expect(plan.value.segments[0].outputStartMs).toBe(0)
    expect(plan.value.segments[0].outputEndMs).toBe(20_000)
    expect(plan.value.segments[1].outputStartMs).toBe(20_000)
    expect(plan.value.segments[1].outputEndMs).toBe(40_000)
    expect(plan.value.segments[2].outputStartMs).toBe(40_000)
    expect(plan.value.segments[2].outputEndMs).toBe(60_000)
  })

  it("fails when the recording has no output path", () => {
    const badRecording = { ...recording, outputPath: undefined }
    const plan = buildRenderPlan({
      state: makeTimeline(),
      recording: badRecording,
      outputPath: "/tmp/export.mp4",
    })
    expect(plan.ok).toBe(false)
  })
})
