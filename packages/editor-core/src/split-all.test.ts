import { describe, expect, it } from "vitest"
import {
  defaultCursorSettings,
  type AnnotationClip,
  type AudioClip,
  type ManualZoomSegment,
  type ScreenClip,
  type TimelineState,
} from "@recordforge/contracts"
import {
  createEngine,
  createSplitAllClipsCommand,
  createSplitClipCommand,
  executeCommand,
  undoCommand,
  redoCommand,
} from "./index"

function makeMultiTrackState(): TimelineState {
  return {
    version: 1,
    id: "project-1",
    name: "Test project",
    recordingId: "rec-1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
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
    tracks: [
      {
        id: "track-screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-screen-1",
            kind: "screen",
            assetId: "rec-1",
            startMs: 0,
            durationMs: 30_000,
            sourceInMs: 0,
            sourceOutMs: 30_000,
            speed: 1,
          } as ScreenClip,
        ],
      },
      {
        id: "track-audio",
        kind: "audio",
        name: "Mic",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-audio-1",
            kind: "audio",
            assetId: "rec-1",
            streamIndex: 0,
            startMs: 0,
            durationMs: 30_000,
            sourceInMs: 0,
            sourceOutMs: 30_000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
          } as AudioClip,
        ],
      },
      {
        id: "track-overlay",
        kind: "overlay",
        name: "Text",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "clip-anno-1",
            kind: "annotation",
            assetId: "rec-1",
            startMs: 5_000,
            durationMs: 15_000, // 5000 to 20000
            sourceInMs: 0,
            sourceOutMs: 15_000,
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
            presetId: "",
            enabled: true,
            locked: false,
          } as AnnotationClip,
        ],
      },
      {
        id: "track-zoom",
        kind: "zoom",
        name: "Zoom",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [],
      },
    ],
    markers: [],
    zoomSegments: [
      {
        id: "zoom-1",
        startMs: 8_000,
        durationMs: 10_000, // 8000 to 18000
        target: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        scale: 2,
        easing: "smooth",
        transitionInMs: 300,
        transitionOutMs: 300,
        enabled: true,
        locked: false,
        mode: "auto",
        source: "click",
        preset: "developer",
      } as ManualZoomSegment,
    ],
  }
}

describe("split-all-clips command", () => {
  it("splits all intersecting clips across multiple unlocked tracks at razor position", () => {
    const engine = createEngine(makeMultiTrackState())
    const splitTimeMs = 12_000

    const result = executeCommand(engine, createSplitAllClipsCommand(splitTimeMs))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const present = result.value.history.present

    // Screen track should now have 2 clips
    const screenTrack = present.tracks.find((t) => t.id === "track-screen")!
    expect(screenTrack.clips.length).toBe(2)
    expect(screenTrack.clips[0].startMs).toBe(0)
    expect(screenTrack.clips[0].durationMs).toBe(12_000)
    expect(screenTrack.clips[0].sourceOutMs).toBe(12_000)
    expect(screenTrack.clips[1].startMs).toBe(12_000)
    expect(screenTrack.clips[1].durationMs).toBe(18_000)
    expect(screenTrack.clips[1].sourceInMs).toBe(12_000)

    // Audio track should now have 2 clips
    const audioTrack = present.tracks.find((t) => t.id === "track-audio")!
    expect(audioTrack.clips.length).toBe(2)
    expect(audioTrack.clips[0].durationMs).toBe(12_000)
    expect(audioTrack.clips[1].startMs).toBe(12_000)

    // Overlay text track should now have 2 clips
    const overlayTrack = present.tracks.find((t) => t.id === "track-overlay")!
    expect(overlayTrack.clips.length).toBe(2)
    expect(overlayTrack.clips[0].startMs).toBe(5_000)
    expect(overlayTrack.clips[0].durationMs).toBe(7_000) // 12000 - 5000
    expect(overlayTrack.clips[0].sourceInMs).toBe(0)
    expect(overlayTrack.clips[0].sourceOutMs).toBe(7_000)
    expect(overlayTrack.clips[1].startMs).toBe(12_000)
    expect(overlayTrack.clips[1].durationMs).toBe(8_000) // 20000 - 12000
    expect(overlayTrack.clips[1].sourceInMs).toBe(0)
    expect(overlayTrack.clips[1].sourceOutMs).toBe(8_000)

    // Zoom segment should also be split
    expect(present.zoomSegments?.length).toBe(2)
    const [leftZoom, rightZoom] = present.zoomSegments!
    expect(leftZoom.startMs).toBe(8_000)
    expect(leftZoom.durationMs).toBe(4_000) // 12000 - 8000
    expect(rightZoom.startMs).toBe(12_000)
    expect(rightZoom.durationMs).toBe(6_000) // 18000 - 12000
  })

  it("undoes and redoes splitting all clips in a single atomic history step", () => {
    const engine = createEngine(makeMultiTrackState())
    const splitResult = executeCommand(engine, createSplitAllClipsCommand(12_000))
    expect(splitResult.ok).toBe(true)
    if (!splitResult.ok) return

    // Undo should restore all tracks to 1 clip
    const undone = undoCommand(splitResult.value)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    const undoneScreen = undone.value.history.present.tracks.find((t) => t.id === "track-screen")!
    const undoneAudio = undone.value.history.present.tracks.find((t) => t.id === "track-audio")!
    const undoneOverlay = undone.value.history.present.tracks.find((t) => t.id === "track-overlay")!
    expect(undoneScreen.clips.length).toBe(1)
    expect(undoneAudio.clips.length).toBe(1)
    expect(undoneOverlay.clips.length).toBe(1)
    expect(undone.value.history.present.zoomSegments?.length).toBe(1)

    // Redo should restore the splits across all tracks
    const redone = redoCommand(undone.value)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return
    const redoneScreen = redone.value.history.present.tracks.find((t) => t.id === "track-screen")!
    const redoneAudio = redone.value.history.present.tracks.find((t) => t.id === "track-audio")!
    const redoneOverlay = redone.value.history.present.tracks.find((t) => t.id === "track-overlay")!
    expect(redoneScreen.clips.length).toBe(2)
    expect(redoneAudio.clips.length).toBe(2)
    expect(redoneOverlay.clips.length).toBe(2)
    expect(redone.value.history.present.zoomSegments?.length).toBe(2)
  })

  it("skips locked tracks and locked clips", () => {
    const state = makeMultiTrackState()
    // Lock audio track
    state.tracks[1].locked = true

    const engine = createEngine(state)
    const result = executeCommand(engine, createSplitAllClipsCommand(12_000))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const present = result.value.history.present
    // Screen was split
    expect(present.tracks[0].clips.length).toBe(2)
    // Audio was locked, remains 1 clip
    expect(present.tracks[1].clips.length).toBe(1)
  })

  it("fails when no clips or zoom segments intersect split time", () => {
    const engine = createEngine(makeMultiTrackState())
    // 50_000 is beyond the 30_000 duration of all clips
    const result = executeCommand(engine, createSplitAllClipsCommand(50_000))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("no_clips_to_split")
    }
  })

  it("splits synthetic overlay clips with sourceOutMs <= sourceInMs successfully", () => {
    const state = makeMultiTrackState()
    // Add a text clip with sourceInMs: 0, sourceOutMs: 0
    state.tracks.push({
      id: "track-titles",
      kind: "titles",
      name: "Titles",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "clip-title-1",
          kind: "text",
          assetId: "synthetic:text:1",
          startMs: 2_000,
          durationMs: 6_000,
          sourceInMs: 0,
          sourceOutMs: 0,
          speed: 1,
          primaryText: "Hello world",
          x: 80,
          y: 80,
          width: 300,
          height: 100,
        } as any,
      ],
    })

    const engine = createEngine(state)
    const splitResult = executeCommand(engine, createSplitClipCommand("clip-title-1", 4_000))
    expect(splitResult.ok).toBe(true)
    if (!splitResult.ok) return

    const titlesTrack = splitResult.value.history.present.tracks.find(
      (t) => t.id === "track-titles",
    )!
    expect(titlesTrack.clips.length).toBe(2)
    const [left, right] = titlesTrack.clips
    expect(left.startMs).toBe(2_000)
    expect(left.durationMs).toBe(2_000)
    expect(right.startMs).toBe(4_000)
    expect(right.durationMs).toBe(4_000)
  })

  it("splits synthetic overlay clips in split-all without error", () => {
    const state = makeMultiTrackState()
    state.tracks.push({
      id: "track-titles",
      kind: "titles",
      name: "Titles",
      muted: false,
      locked: false,
      solo: false,
      volume: 1,
      clips: [
        {
          id: "clip-title-2",
          kind: "text",
          assetId: "synthetic:text:2",
          startMs: 2_000,
          durationMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 0,
          speed: 1,
          primaryText: "Title 2",
          x: 80,
          y: 80,
          width: 300,
          height: 100,
        } as any,
      ],
    })

    const engine = createEngine(state)
    const splitResult = executeCommand(engine, createSplitAllClipsCommand(5_000))
    expect(splitResult.ok).toBe(true)
    if (!splitResult.ok) return
    const titlesTrack = splitResult.value.history.present.tracks.find(
      (t) => t.id === "track-titles",
    )!
    expect(titlesTrack.clips.length).toBe(2)
  })

  it("splits clips with non-1.0 speed factor maintaining exact adjacent boundaries", () => {
    const state = makeMultiTrackState()
    const screenTrack = state.tracks.find((t) => t.id === "track-screen")!
    screenTrack.clips[0] = {
      ...screenTrack.clips[0],
      startMs: 1_000,
      durationMs: 8_000,
      sourceInMs: 0,
      sourceOutMs: 10_000,
      speed: 1.25,
    } as ScreenClip

    const engine = createEngine(state)
    const splitTimeMs = 3_501
    const result = executeCommand(
      engine,
      createSplitClipCommand(screenTrack.clips[0].id, splitTimeMs),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const updatedTrack = result.value.history.present.tracks.find((t) => t.id === "track-screen")!
    expect(updatedTrack.clips.length).toBe(2)
    const [left, right] = updatedTrack.clips
    expect(left.startMs).toBe(1_000)
    expect(left.durationMs).toBe(2_501)
    expect(left.startMs + left.durationMs).toBe(right.startMs)
    expect(right.startMs).toBe(3_501)
    expect(right.durationMs).toBe(8_000 - 2_501)
    expect(left.durationMs + right.durationMs).toBe(8_000)
  })

  it("splits all clips with odd timestamps ensuring zero overlap failure", () => {
    const state = makeMultiTrackState()
    const engine = createEngine(state)
    const splitTimeMs = 7_333
    const result = executeCommand(engine, createSplitAllClipsCommand(splitTimeMs))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    for (const track of result.value.history.present.tracks) {
      if (track.kind === "screen" || track.kind === "audio") {
        expect(track.clips.length).toBe(2)
        const [left, right] = track.clips
        expect(left.startMs + left.durationMs).toBe(right.startMs)
        expect(right.startMs).toBe(splitTimeMs)
      }
    }
  })
})
