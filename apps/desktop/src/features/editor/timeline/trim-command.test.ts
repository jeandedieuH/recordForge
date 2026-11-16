import { describe, expect, it } from "vitest"
import {
  type ImageClip,
  type ScreenClip,
  type TimelineState,
  type TimelineTrack,
  defaultCursorSettings,
} from "@recordforge/contracts"
import { applyCommand, type CommandRecord } from "@recordforge/editor-core"
import { buildTrimCommand } from "./trim-command"

// The gesture HUD and the committed command must agree on where a trim may
// stop. When they disagree the drag looks correct and the release snaps the
// clip back to its pre-gesture geometry.

const RECORDING_MS = 20_000

function canvas(): TimelineState["canvas"] {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    background: "#000000",
    padding: 0,
    borderRadius: 0,
    shadow: false,
    cursorSettings: defaultCursorSettings,
  }
}

function screenClip(overrides: Partial<ScreenClip> = {}): ScreenClip {
  return {
    id: "screen-clip",
    kind: "screen",
    assetId: "recording-screen",
    startMs: 0,
    durationMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    speed: 1,
    ...overrides,
  }
}

function imageClip(overrides: Partial<ImageClip> = {}): ImageClip {
  return {
    id: "image-clip",
    kind: "image",
    assetId: "image-asset",
    startMs: 16_000,
    durationMs: 4_000,
    sourceInMs: 0,
    sourceOutMs: 4_000,
    speed: 1,
    x: 100,
    y: 100,
    width: 400,
    height: 300,
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
    zIndex: 0,
    opacity: 1,
    borderRadius: 0,
    borderWidth: 0,
    borderColor: "#ffffff",
    shadowEnabled: false,
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowBlur: 0,
    fit: "contain",
    animationIn: "fade",
    animationOut: "fade",
    overlayAnimation: {
      inType: "fade",
      outType: "fade",
      inDurationMs: 350,
      outDurationMs: 350,
      easing: "expo-out",
    },
    enabled: true,
    locked: false,
    ...overrides,
  }
}

function track(kind: TimelineTrack["kind"], clips: TimelineTrack["clips"]): TimelineTrack {
  return {
    id: `${kind}-track`,
    kind,
    name: kind,
    muted: false,
    locked: false,
    solo: false,
    volume: 1,
    clips,
  }
}

function state(clips: TimelineTrack[]): TimelineState {
  return {
    version: 1,
    id: "timeline",
    name: "Timeline",
    recordingId: "rec-1",
    canvas: canvas(),
    tracks: clips,
    markers: [],
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
  }
}

function appliedClip(command: CommandRecord, base: TimelineState) {
  if (command.kind !== "trim-clip") throw new Error(`unexpected command ${command.kind}`)
  const result = applyCommand(base, command)
  if (!result.ok) throw new Error(result.error.message)
  return result.value.tracks
    .flatMap((entry) => entry.clips)
    .find((clip) => clip.id === command.clipId)
}

const metadata = { durationMs: RECORDING_MS } as Parameters<typeof buildTrimCommand>[2]

describe("buildTrimCommand", () => {
  it("extends a graphic overlay past the length of the recording", () => {
    const base = state([track("graphics", [imageClip({ startMs: 0, durationMs: 4_000 })])])
    const result = buildTrimCommand(
      { clipId: "image-clip", edge: "end", edgeTimeMs: 25_000 },
      base,
      metadata,
    )
    if (!result.ok) throw new Error(result.error.message)

    const next = appliedClip(result.value.command, base)
    // 0s -> 25s over a 20s recording. Clamping the source range to the
    // recording pinned the clip at 20s, so the release undid the drag.
    expect(next).toMatchObject({ startMs: 0, durationMs: 25_000 })
  })

  it("extends a b-roll layer past its own asset length", () => {
    const base = state([track("media", [imageClip({ startMs: 0, durationMs: 4_000 })])])
    const result = buildTrimCommand(
      { clipId: "image-clip", edge: "end", edgeTimeMs: 30_000 },
      base,
      metadata,
    )
    if (!result.ok) throw new Error(result.error.message)

    expect(appliedClip(result.value.command, base)).toMatchObject({ durationMs: 30_000 })
  })

  it("extends an overlay's leading edge by growing the clip, not by shifting it", () => {
    const base = state([track("graphics", [imageClip({ startMs: 16_000, durationMs: 4_000 })])])
    const result = buildTrimCommand(
      { clipId: "image-clip", edge: "start", edgeTimeMs: 12_000 },
      base,
      metadata,
    )
    if (!result.ok) throw new Error(result.error.message)

    // The right edge holds at 20s; the clip grows from 4s to 8s.
    expect(appliedClip(result.value.command, base)).toMatchObject({
      startMs: 12_000,
      durationMs: 8_000,
    })
  })

  it("still stops screen media at the end of the recording", () => {
    const base = state([track("screen", [screenClip({ sourceOutMs: RECORDING_MS })])])
    const result = buildTrimCommand(
      { clipId: "screen-clip", edge: "end", edgeTimeMs: 30_000 },
      base,
      metadata,
    )
    if (!result.ok) throw new Error(result.error.message)

    // 10s clip, 20s of media: extending to 30s is capped at the source end.
    expect(appliedClip(result.value.command, base)).toMatchObject({ durationMs: RECORDING_MS })
  })

  it("re-extends trimmed screen media back to the source end", () => {
    const base = state([track("screen", [screenClip({ durationMs: 4_000, sourceOutMs: 4_000 })])])
    const result = buildTrimCommand(
      { clipId: "screen-clip", edge: "end", edgeTimeMs: 12_000 },
      base,
      metadata,
    )
    if (!result.ok) throw new Error(result.error.message)

    expect(appliedClip(result.value.command, base)).toMatchObject({ durationMs: 12_000 })
  })
})
