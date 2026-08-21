import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type AnnotationClip,
  type AudioClip,
  type ManualZoomSegment,
  type ScreenClip,
  type TimelineState,
  type TimelineTrack,
} from "@recordforge/contracts"
import {
  createEngine,
  createRippleDeleteClipCommand,
  createRippleDeleteClipsCommand,
  createRippleDeleteRangeCommand,
  createDeleteRangeCommand,
  executeCommand,
  getManualZoomSegments,
} from "./index"

function makeLanesState(): TimelineState {
  const screenTrack: TimelineTrack = {
    id: "track-screen",
    kind: "screen",
    name: "Screen",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [
      {
        id: "screen-1",
        assetId: "screen-asset",
        kind: "screen",
        startMs: 0,
        durationMs: 5_000,
        sourceInMs: 0,
        sourceOutMs: 5_000,
        speed: 1,
      } as ScreenClip,
      {
        id: "screen-2",
        assetId: "screen-asset",
        kind: "screen",
        startMs: 5_000,
        durationMs: 5_000,
        sourceInMs: 5_000,
        sourceOutMs: 10_000,
        speed: 1,
      } as ScreenClip,
      {
        id: "screen-3",
        assetId: "screen-asset",
        kind: "screen",
        startMs: 10_000,
        durationMs: 10_000,
        sourceInMs: 10_000,
        sourceOutMs: 20_000,
        speed: 1,
      } as ScreenClip,
    ],
  }

  const audioTrack: TimelineTrack = {
    id: "track-audio",
    kind: "audio",
    name: "Microphone",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [
      {
        id: "audio-1",
        assetId: "audio-asset",
        kind: "audio",
        startMs: 0,
        durationMs: 20_000,
        sourceInMs: 0,
        sourceOutMs: 20_000,
        speed: 1,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
      } as AudioClip,
    ],
  }

  const annotationsTrack: TimelineTrack = {
    id: "track-annotations",
    kind: "annotations",
    name: "Annotations",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [
      {
        id: "anno-1",
        assetId: "anno-asset",
        kind: "annotation",
        startMs: 6_000,
        durationMs: 3_000,
        sourceInMs: 0,
        sourceOutMs: 3_000,
        speed: 1,
        annotationType: "rectangle",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        zIndex: 0,
        opacity: 1,
        strokeColor: "#38bdf8",
        strokeWidth: 4,
        strokeStyle: "solid",
        fillColor: "#38bdf8",
        fillOpacity: 0,
        cornerRadius: 8,
        arrowEndHead: "arrow",
        arrowStartHead: "none",
        shadowEnabled: false,
        shadowColor: "rgba(0, 0, 0, 0.5)",
        shadowBlur: 8,
        textColor: "#ffffff",
        fontSize: 16,
        animationIn: "fade",
        animationOut: "fade",
        overlayAnimation: {
          inType: "fade",
          outType: "fade",
          inDurationMs: 350,
          outDurationMs: 350,
          easing: "expo-out",
        },
        presetId: "",
        enabled: true,
        locked: false,
      } as AnnotationClip,
    ],
  }

  const zoomTrack: TimelineTrack = {
    id: "track-zoom",
    kind: "zoom",
    name: "Zoom",
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips: [],
  }

  const zoomSegments: ManualZoomSegment[] = [
    {
      id: "zoom-1",
      startMs: 6_000,
      durationMs: 2_000,
      target: { x: 400, y: 300, width: 960, height: 540 },
      scale: 2,
      easing: "smooth",
      enabled: true,
      locked: false,
      mode: "manual",
    },
    {
      id: "zoom-2",
      startMs: 14_000,
      durationMs: 3_000,
      target: { x: 800, y: 600, width: 960, height: 540 },
      scale: 1.5,
      easing: "cinematic",
      enabled: true,
      locked: false,
      mode: "auto",
      source: "click",
    },
  ]

  return {
    version: 1,
    id: "test-lanes-project",
    name: "Lanes Test",
    recordingId: "rec-1",
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#000000",
      padding: 0,
      borderRadius: 0,
      shadow: false,
      cursorSettings: defaultCursorSettings,
    },
    tracks: [screenTrack, audioTrack, annotationsTrack, zoomTrack],
    markers: [
      { id: "marker-intro", timeMs: 1_000, label: "Intro", color: "#f59e0b" },
      { id: "marker-mid", timeMs: 7_000, label: "Action", color: "#f59e0b" },
      { id: "marker-outro", timeMs: 16_000, label: "Outro", color: "#f59e0b" },
    ],
    zoomSegments,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  }
}

describe("Ripple Delete Across All Timeline Lanes", () => {
  it("shifts subsequent smart zooms, manual zooms, annotations, and markers when ripple deleting a range", () => {
    const engine = createEngine(makeLanesState())
    // Ripple delete range [2,000, 4,000] (duration: 2,000ms)
    const result = executeCommand(engine, createRippleDeleteRangeCommand(2_000, 4_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present

    // Screen track: screen-1 sliced at [2,000, 4,000] -> left piece [0, 2,000], right piece [2,000, 3,000]; screen-2 shifted to [3,000, 8,000]
    const screenClips = state.tracks[0].clips
    expect(screenClips[0]).toMatchObject({ id: "screen-1", startMs: 0, durationMs: 2_000 })
    expect(screenClips[1]).toMatchObject({ startMs: 2_000, durationMs: 1_000 })
    expect(screenClips[2]).toMatchObject({ id: "screen-2", startMs: 3_000, durationMs: 5_000 })

    // Audio track: sliced at 2,000, second piece shifted left by 2,000
    const audioClips = state.tracks[1].clips
    expect(audioClips).toHaveLength(2)
    expect(audioClips[0]).toMatchObject({ startMs: 0, durationMs: 2_000 })
    expect(audioClips[1]).toMatchObject({ startMs: 2_000, durationMs: 16_000 })

    // Annotations track: anno-1 was at [6,000, 9,000], now at [4,000, 7,000]
    const annoClips = state.tracks[2].clips
    expect(annoClips[0]).toMatchObject({ id: "anno-1", startMs: 4_000, durationMs: 3_000 })

    // Zoom segments:
    // zoom-1 was at [6,000, 8,000], now at [4,000, 6,000]
    // zoom-2 was at [14,000, 17,000], now at [12,000, 15,000]
    const zooms = getManualZoomSegments(state)
    expect(zooms).toHaveLength(2)
    expect(zooms[0]).toMatchObject({ id: "zoom-1", startMs: 4_000, durationMs: 2_000 })
    expect(zooms[1]).toMatchObject({ id: "zoom-2", startMs: 12_000, durationMs: 3_000 })

    // Markers:
    // marker-intro at 1,000 (before cut) unchanged
    // marker-mid was at 7,000, now at 5,000
    // marker-outro was at 16,000, now at 14,000
    expect(state.markers).toEqual([
      { id: "marker-intro", timeMs: 1_000, label: "Intro", color: "#f59e0b" },
      { id: "marker-mid", timeMs: 5_000, label: "Action", color: "#f59e0b" },
      { id: "marker-outro", timeMs: 14_000, label: "Outro", color: "#f59e0b" },
    ])
  })

  it("fuses a spanning zoom segment seamlessly when ripple deleting in the middle of it", () => {
    const base = makeLanesState()
    // Place a continuous 10s zoom segment spanning [2,000, 12,000]
    base.zoomSegments = [
      {
        id: "zoom-span",
        startMs: 2_000,
        durationMs: 10_000,
        target: { x: 500, y: 500, width: 960, height: 540 },
        scale: 2,
        easing: "smooth",
        enabled: true,
        locked: false,
      },
    ]

    const engine = createEngine(base)
    // Ripple delete 3s in the middle of the zoom: [5,000, 8,000]
    const result = executeCommand(engine, createRippleDeleteRangeCommand(5_000, 8_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present
    const zooms = getManualZoomSegments(state)

    // The zoom segment should remain a single continuous fused segment spanning [2,000, 9,000] (duration 7,000ms)
    expect(zooms).toHaveLength(1)
    expect(zooms[0]).toMatchObject({
      id: "zoom-span",
      startMs: 2_000,
      durationMs: 7_000,
    })
  })

  it("splits a spanning zoom segment into two when using non-ripple delete-range", () => {
    const base = makeLanesState()
    base.zoomSegments = [
      {
        id: "zoom-span",
        startMs: 2_000,
        durationMs: 10_000,
        target: { x: 500, y: 500, width: 960, height: 540 },
        scale: 2,
        easing: "smooth",
        enabled: true,
        locked: false,
      },
    ]

    const engine = createEngine(base)
    // Delete range [5,000, 8,000] WITHOUT ripple
    const result = executeCommand(engine, createDeleteRangeCommand(5_000, 8_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present
    const zooms = getManualZoomSegments(state)

    // Two disjoint pieces leaving the 3s gap
    expect(zooms).toHaveLength(2)
    expect(zooms[0]).toMatchObject({ id: "zoom-span", startMs: 2_000, durationMs: 3_000 })
    expect(zooms[1]).toMatchObject({ startMs: 8_000, durationMs: 4_000 })
  })

  it("merges overlapping multi-clip selections before ripple deleting so zoom positions do not desync", () => {
    const base = makeLanesState()
    // screen-1 is [0, 5,000], screen-2 is [5,000, 10,000]
    // Select screen-1 and screen-2 to ripple delete together
    const engine = createEngine(base)
    const result = executeCommand(engine, createRippleDeleteClipsCommand(["screen-1", "screen-2"]))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present

    // screen-3 was at [10,000, 20,000], now shifted left by 10,000 to start at 0
    const screenClips = state.tracks[0].clips
    expect(screenClips).toHaveLength(1)
    expect(screenClips[0]).toMatchObject({ id: "screen-3", startMs: 0, durationMs: 10_000 })

    // zoom-2 was at [14,000, 17,000], now shifted left by 10,000 to [4,000, 7,000]
    const zooms = getManualZoomSegments(state)
    // zoom-1 was at [6,000, 8,000] (within the deleted 0-10,000 range), so it was deleted
    expect(zooms).toHaveLength(1)
    expect(zooms[0]).toMatchObject({ id: "zoom-2", startMs: 4_000, durationMs: 3_000 })
  })

  it("ripple deletes a zoom segment directly, shifting all subsequent video, audio, annotation, and zoom lanes", () => {
    const base = makeLanesState()
    const engine = createEngine(base)

    // Ripple delete zoom-1 ([6,000, 8,000], duration 2,000)
    const result = executeCommand(engine, createRippleDeleteClipCommand("zoom-1"))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present

    // zoom-1 deleted, zoom-2 shifted left by 2,000 (from 14,000 to 12,000)
    const zooms = getManualZoomSegments(state)
    expect(zooms).toHaveLength(1)
    expect(zooms[0]).toMatchObject({ id: "zoom-2", startMs: 12_000, durationMs: 3_000 })

    // screen-2 (was [5,000, 10,000]) was cut between 6,000 and 8,000 -> spliced into [5,000, 6,000] and [6,000, 8,000]
    const screenClips = state.tracks[0].clips
    expect(screenClips[0]).toMatchObject({ id: "screen-1", startMs: 0, durationMs: 5_000 })
    expect(screenClips[3]).toMatchObject({ id: "screen-3", startMs: 8_000, durationMs: 10_000 })

    // marker-mid (was at 7,000) inside deleted range is removed; marker-outro shifted from 16,000 to 14,000
    expect(state.markers).toEqual([
      { id: "marker-intro", timeMs: 1_000, label: "Intro", color: "#f59e0b" },
      { id: "marker-outro", timeMs: 14_000, label: "Outro", color: "#f59e0b" },
    ])
  })

  it("preserves zoom segments when the zoom track is locked during ripple delete", () => {
    const base = makeLanesState()
    // Lock the zoom track
    const zoomTrack = base.tracks.find((t) => t.kind === "zoom")!
    zoomTrack.locked = true

    const engine = createEngine(base)
    // Ripple delete range [2,000, 4,000]
    const result = executeCommand(engine, createRippleDeleteRangeCommand(2_000, 4_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present

    // Screen track clips shifted
    expect(state.tracks[0].clips[0]).toMatchObject({ id: "screen-1", startMs: 0, durationMs: 2_000 })
    expect(state.tracks[0].clips[1]).toMatchObject({ startMs: 2_000, durationMs: 1_000 })
    expect(state.tracks[0].clips[2]).toMatchObject({ id: "screen-2", startMs: 3_000, durationMs: 5_000 })

    // Zoom segments remain untouched at original timestamps because the zoom track is locked
    const zooms = getManualZoomSegments(state)
    expect(zooms).toHaveLength(2)
    expect(zooms[0]).toMatchObject({ id: "zoom-1", startMs: 6_000, durationMs: 2_000 })
    expect(zooms[1]).toMatchObject({ id: "zoom-2", startMs: 14_000, durationMs: 3_000 })
  })

  it("preserves an individually locked zoom segment during ripple delete", () => {
    const base = makeLanesState()
    base.zoomSegments![0].locked = true // zoom-1 locked

    const engine = createEngine(base)
    // Ripple delete range [2,000, 4,000]
    const result = executeCommand(engine, createRippleDeleteRangeCommand(2_000, 4_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const state = result.value.history.present
    const zooms = getManualZoomSegments(state)

    // zoom-1 remained at 6,000 because it's locked
    expect(zooms[0]).toMatchObject({ id: "zoom-1", startMs: 6_000, durationMs: 2_000 })
    // zoom-2 shifted left by 2,000 from 14,000 to 12,000
    expect(zooms[1]).toMatchObject({ id: "zoom-2", startMs: 12_000, durationMs: 3_000 })
  })
})
