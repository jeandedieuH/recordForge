import { describe, expect, it } from "vitest"
import type { Project, TimelineState } from "@recordforge/contracts"
import { defaultProjectExportSettings } from "@recordforge/contracts"
import {
  clampOverlayStartMs,
  ensureCameraLayoutTrack,
  getOverlayContentEndMs,
  getScreenContentEndMs,
  getTimelineContentEndMs,
  getTotalDuration,
  projectToTimeline,
  timelineToProject,
} from "./timeline"

function makeTimeline(): TimelineState {
  const now = "2026-11-14T00:00:00.000Z"
  return {
    version: 1,
    id: "timeline-1",
    name: "Timeline",
    recordingId: "recording-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
    } as TimelineState["canvas"],
    tracks: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "screen-1",
            kind: "screen",
            assetId: "recording-1",
            startMs: 0,
            durationMs: 10_000,
            sourceInMs: 0,
            sourceOutMs: 10_000,
            speed: 1,
          },
        ],
      },
      {
        id: "titles",
        kind: "titles",
        name: "Titles",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "title-1",
            kind: "text",
            assetId: "synthetic:text:title-1",
            startMs: 12_000,
            durationMs: 4_000,
            sourceInMs: 0,
            sourceOutMs: 4_000,
            speed: 1,
            primaryText: "End card",
          } as TimelineState["tracks"][number]["clips"][number],
        ],
      },
    ],
    markers: [{ id: "marker-1", timeMs: 16_000, label: "End", color: "#ffffff" }],
    zoomSegments: [],
    createdAt: now,
    updatedAt: now,
  }
}

describe("timeline duration", () => {
  it("distinguishes buttery editor duration from the rendered video end", () => {
    const timeline = makeTimeline()
    expect(getTotalDuration(timeline)).toBe(16_000)
    expect(getScreenContentEndMs(timeline)).toBe(10_000)
    expect(getOverlayContentEndMs(timeline)).toBe(16_000)
    expect(getTimelineContentEndMs(timeline)).toBe(16_000)
  })

  it("does not extend the content end for muted overlay tracks", () => {
    const timeline = makeTimeline()
    timeline.tracks[1]!.muted = true
    expect(getOverlayContentEndMs(timeline)).toBe(0)
    expect(getTimelineContentEndMs(timeline)).toBe(10_000)
  })

  it("clamps an overlay that would start after the last frame so it stays visible", () => {
    expect(clampOverlayStartMs(10_000, 4_000, 10_000)).toBe(6_000)
    expect(clampOverlayStartMs(12_000, 4_000, 10_000)).toBe(6_000)
    expect(clampOverlayStartMs(4_000, 4_000, 10_000)).toBe(4_000)
  })

  it("leaves endpoints untouched when there is no rendered video", () => {
    expect(clampOverlayStartMs(8_000, 4_000, 0)).toBe(8_000)
  })
})

describe("camera layout lane anchor", () => {
  function withCamera(timeline: TimelineState): TimelineState {
    return {
      ...timeline,
      tracks: [
        timeline.tracks[0]!,
        {
          id: "camera",
          kind: "camera",
          name: "Camera",
          muted: false,
          locked: false,
          solo: false,
          volume: 1,
          clips: [],
        },
        ...timeline.tracks.slice(1),
      ],
    }
  }

  it("inserts the lane right below the camera track and is idempotent", () => {
    const state = ensureCameraLayoutTrack(withCamera(makeTimeline()))
    const kinds = state.tracks.map((track) => track.kind)
    expect(kinds).toEqual(["screen", "camera", "camera-layouts", "titles"])
    const again = ensureCameraLayoutTrack(state)
    expect(again).toBe(state)
  })

  it("is not persisted: saving strips the lane and loading re-adds it", () => {
    const timeline = ensureCameraLayoutTrack(withCamera(makeTimeline()))
    const project: Project = {
      format: "recordforge.project",
      version: 1,
      id: timeline.id,
      name: timeline.name,
      recordingId: timeline.recordingId,
      canvas: timeline.canvas,
      assets: [],
      tracks: timeline.tracks,
      markers: timeline.markers,
      zoomSegments: [],
      cameraLayouts: [],
      exportSettings: defaultProjectExportSettings,
      createdAt: timeline.createdAt,
      updatedAt: timeline.updatedAt,
      checksum: "",
    }
    const saved = timelineToProject(timeline, project)
    expect(saved.tracks.some((track) => track.kind === "camera-layouts")).toBe(false)

    const reloaded = projectToTimeline({ ...project, tracks: saved.tracks })
    expect(reloaded.tracks.some((track) => track.kind === "camera-layouts")).toBe(true)
  })
})
