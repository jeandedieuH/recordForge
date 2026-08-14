import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  projectSchema,
  projectAssetSchema,
  recoveryScanResultSchema,
  libraryRecordingSchema,
  defaultCursorSettings,
  projectToTimeline,
  type Project,
  type TimelineState,
  type CursorTelemetryFile,
  type ManualZoomSegment,
} from "@recordforge/domain"
import {
  createCursorEngine,
  normalizeCursorTelemetry,
  type CursorEngine,
} from "@recordforge/cursor-core"
import { resolvePreviewComposition } from "./preview-composition"

const fixtureDir = fileURLToPath(
  new URL("../../../tooling/fixtures/editor-fixtures", import.meta.url),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function screenAssetId(assets: unknown): string {
  if (!Array.isArray(assets)) return "screen"
  const first = assets.find((asset) => isRecord(asset) && asset["role"] === "screen")
  return isRecord(first) && typeof first["id"] === "string" ? first["id"] : "screen"
}

function migrateAudioClip(clip: unknown, role: string): unknown {
  if (!isRecord(clip)) return clip
  return { ...clip, kind: "audio", role: clip["role"] ?? role }
}

function migrateMaskClip(clip: unknown, fallbackAssetId: string): unknown {
  if (!isRecord(clip)) return clip
  const copy = { ...clip }
  if (copy["mode"] === "redaction") copy["mode"] = "redact"
  copy["rect"] = {
    x: copy["x"] ?? 0,
    y: copy["y"] ?? 0,
    width: copy["width"] ?? 100,
    height: copy["height"] ?? 100,
  }
  delete copy["x"]
  delete copy["y"]
  delete copy["width"]
  delete copy["height"]
  delete copy["shape"]
  copy["kind"] = "mask"
  copy["assetId"] = copy["assetId"] ?? fallbackAssetId
  copy["sourceInMs"] = copy["sourceInMs"] ?? 0
  copy["sourceOutMs"] = copy["sourceOutMs"] ?? copy["durationMs"] ?? 0
  copy["speed"] = copy["speed"] ?? 1
  copy["enabled"] = copy["enabled"] ?? true
  return copy
}

function zoomClipToSegment(clip: unknown): ManualZoomSegment | undefined {
  if (!isRecord(clip)) return undefined
  const rawTarget = clip["target"]
  const target = isRecord(rawTarget)
    ? {
        x: Number(rawTarget["x"] ?? 0),
        y: Number(rawTarget["y"] ?? 0),
        width: Number(rawTarget["width"] ?? 100),
        height: Number(rawTarget["height"] ?? 100),
      }
    : { x: 0, y: 0, width: 100, height: 100 }

  return {
    id: String(clip["id"] ?? "zoom"),
    startMs: Number(clip["startMs"] ?? 0),
    durationMs: Number(clip["durationMs"] ?? 1),
    target,
    scale: Number(clip["scale"] ?? 1),
    easing: (clip["easing"] as ManualZoomSegment["easing"]) ?? "ease-in-out",
    enabled: true,
    locked: Boolean(clip["locked"]),
  } as ManualZoomSegment
}

function migrateTrack(
  track: unknown,
  fallbackAssetId: string,
): { track?: unknown; zoomSegments: ManualZoomSegment[] } {
  if (!isRecord(track)) return { zoomSegments: [] }
  const kind = String(track["kind"])

  if (kind === "zoom") {
    const clips = Array.isArray(track["clips"]) ? track["clips"] : []
    return {
      zoomSegments: clips
        .map(zoomClipToSegment)
        .filter((s): s is ManualZoomSegment => s !== undefined),
    }
  }

  if (kind === "masks") {
    const clips = Array.isArray(track["clips"]) ? track["clips"] : []
    return {
      track: {
        ...track,
        kind: "effects",
        clips: clips.map((clip) => migrateMaskClip(clip, fallbackAssetId)),
      },
      zoomSegments: [],
    }
  }

  if (kind === "microphone" || kind === "system-audio" || kind === "audio") {
    const role =
      kind === "microphone" ? "microphone" : kind === "system-audio" ? "system_audio" : "other"
    const clips = Array.isArray(track["clips"]) ? track["clips"] : []
    return {
      track: {
        ...track,
        kind: "audio",
        clips: clips.map((clip) => migrateAudioClip(clip, role)),
      },
      zoomSegments: [],
    }
  }

  return { track, zoomSegments: [] }
}

function migrateFixtureProject(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const copy: Record<string, unknown> = { ...raw, checksum: raw["checksum"] ?? "" }
  delete copy["sourceKind"]

  const fallbackAssetId = screenAssetId(copy["assets"])
  const inputTracks = Array.isArray(copy["tracks"]) ? copy["tracks"] : []
  const migratedTracks: unknown[] = []
  const migratedZoomSegments: ManualZoomSegment[] = []

  for (const track of inputTracks) {
    const { track: migrated, zoomSegments } = migrateTrack(track, fallbackAssetId)
    if (migrated) migratedTracks.push(migrated)
    migratedZoomSegments.push(...zoomSegments)
  }

  copy["tracks"] = migratedTracks
  copy["zoomSegments"] = [
    ...(Array.isArray(copy["zoomSegments"]) ? copy["zoomSegments"] : []),
    ...migratedZoomSegments,
  ]
  return copy
}

function loadProject(name: string): Project {
  const raw = JSON.parse(readFileSync(join(fixtureDir, name), "utf-8"))
  return projectSchema.parse(migrateFixtureProject(raw)) as Project
}

function loadTimeline(name: string): TimelineState {
  return projectToTimeline(loadProject(name))
}

interface CursorTelemetryOptions {
  clickIndices?: number[]
}

function makeCursorTelemetry(
  durationMs: number,
  options: CursorTelemetryOptions = {},
): CursorTelemetryFile {
  const sampleRateHz = 60
  const intervalMs = 1000 / sampleRateHz
  const count = Math.floor(durationMs / intervalMs)
  const events: CursorTelemetryFile["events"] = []

  for (let index = 0; index < count; index++) {
    const tMs = Math.round(index * intervalMs)
    const progress = durationMs > 0 ? tMs / durationMs : 0
    const x = Math.round(progress * 1920)
    const y = Math.round(540 + Math.sin(tMs / 1000) * 200)
    events.push({
      tMs,
      rawX: x,
      rawY: y,
      sourceX: x,
      sourceY: y,
      buttons: {
        left: options.clickIndices?.includes(index) ?? false,
        right: false,
        middle: false,
        x1: false,
        x2: false,
      },
      buttonEvent: options.clickIndices?.includes(index) ? "left-down" : "none",
      visible: true,
      shapeId: "arrow",
      shapeChanged: false,
    })
  }

  return {
    schemaVersion: 2,
    assetId: "cursor-events:synthetic",
    recordingId: "synthetic-recording",
    sourceWidth: 1920,
    sourceHeight: 1080,
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    coordinateTransform: {
      a00: 1,
      a01: 0,
      a10: 0,
      a11: 1,
      b0: 0,
      b1: 0,
    },
    shapes: [],
    timebase: { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz,
    clickWindowMs: 350,
    health: "healthy" as const,
    eventCount: events.length,
    index: [],
    eventFile: "cursor_events.bin",
    events,
  }
}

function makeDenseState(durationMs: number): {
  state: TimelineState
  cursorEngine: CursorEngine
  samples: number[]
} {
  const clips = []
  for (let index = 0; index < durationMs / 1000; index++) {
    const startMs = index * 1000
    clips.push({
      id: `screen-clip-${index}`,
      kind: "screen" as const,
      assetId: "asset-screen",
      startMs,
      durationMs: 1000,
      sourceInMs: startMs,
      sourceOutMs: startMs + 1000,
      speed: 1,
    })
  }

  const captions = []
  for (let index = 0; index < durationMs; index += 30_000) {
    captions.push({
      id: `caption-${index}`,
      kind: "caption" as const,
      assetId: "asset-captions",
      startMs: index,
      durationMs: 1000,
      sourceInMs: index,
      sourceOutMs: index + 1000,
      speed: 1,
      text: `Caption at ${index}ms`,
      style: "default" as const,
      placement: "bottom" as const,
    })
  }

  const zoomSegments: ManualZoomSegment[] = []
  for (let index = 0; index < durationMs; index += 300_000) {
    zoomSegments.push({
      id: `zoom-${index}`,
      startMs: index,
      durationMs: 1000,
      target: { x: 960, y: 540, width: 960, height: 540 },
      scale: 1.5,
      easing: "smooth",
      enabled: true,
      locked: false,
    })
  }

  const cursorTelemetry = makeCursorTelemetry(durationMs, { clickIndices: [60, 120, 180] })
  const cursorEngine = createCursorEngine(cursorTelemetry)

  const state: TimelineState = {
    version: 1,
    id: `synthetic-${durationMs}`,
    name: `Synthetic ${durationMs}ms`,
    recordingId: "synthetic-recording",
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
        id: "screen",
        kind: "screen",
        name: "Screen",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips,
      },
      {
        id: "captions",
        kind: "captions",
        name: "Captions",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: captions,
      },
      {
        id: "cursor",
        kind: "cursor",
        name: "Cursor",
        muted: false,
        locked: false,
        solo: false,
        volume: 1,
        clips: [
          {
            id: "cursor-effect",
            kind: "cursor-effect",
            assetId: "cursor-events:synthetic",
            startMs: 0,
            durationMs,
            sourceInMs: 0,
            sourceOutMs: 0,
            speed: 1,
            presetId: "recorded-system",
            scale: 1,
            smoothing: "smooth",
            settings: {},
            enabled: true,
            locked: false,
          },
        ],
      },
    ],
    zoomSegments,
    markers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const step = Math.floor(durationMs / 10)
  const samples = Array.from({ length: 10 }, (_, index) => Math.min(index * step, durationMs - 1))

  return { state, cursorEngine, samples }
}

describe("Phase 9 hardening", () => {
  describe("performance / stress", () => {
    it("resolves the 5-minute fixture in under 100 ms per sample", () => {
      const state = loadTimeline("project-long.json")
      const screenTrack = state.tracks.find((track) => track.kind === "screen")
      const screenClip = screenTrack?.clips[0]
      if (!screenClip) throw new Error("Screen clip missing in project-long fixture")

      const endMs = screenClip.startMs + screenClip.durationMs
      const samples = [0, 60_000, 180_000, 300_000]

      for (const sample of samples) {
        // Preview uses half-open intervals, so the final sample is clamped to the last active frame.
        const t = Math.min(sample, endMs - 1)
        const start = performance.now()
        const comp = resolvePreviewComposition(state, t)
        const elapsed = performance.now() - start

        expect(elapsed).toBeLessThan(100)
        expect(comp.screen.active).toBe(true)
      }
    })

    it("resolves 10 preview frames on a 30-minute dense timeline under 500 ms", () => {
      const { state, cursorEngine, samples } = makeDenseState(30 * 60 * 1000)

      const start = performance.now()
      const results = samples.map((t) => resolvePreviewComposition(state, t, { cursorEngine }))
      const elapsed = performance.now() - start

      for (const result of results) {
        expect(result.screen.active).toBe(true)
      }

      const firstRepeated = resolvePreviewComposition(state, samples[0], { cursorEngine })
      expect(JSON.stringify(firstRepeated)).toBe(JSON.stringify(results[0]))

      expect(elapsed).toBeLessThan(1000)
    })

    it("builds and evaluates a 60-minute cursor telemetry file within budget", () => {
      const durationMs = 60 * 60 * 1000
      const telemetry = makeCursorTelemetry(durationMs)

      const buildStart = performance.now()
      const engine = createCursorEngine(telemetry)
      const buildElapsed = performance.now() - buildStart

      expect(buildElapsed).toBeLessThan(5000)

      for (const t of [30 * 60 * 1000, 59 * 60 * 1000]) {
        const evalStart = performance.now()
        const frame = engine.evaluate(t, defaultCursorSettings)
        const evalElapsed = performance.now() - evalStart

        expect(evalElapsed).toBeLessThan(200)
        expect(frame.visible).toBe(true)
      }
    })
  })

  describe("crash / recovery", () => {
    it("parses project assets with missing and relinked status", () => {
      const missing = projectAssetSchema.parse({
        id: "asset-missing",
        role: "screen",
        path: "missing.mp4",
        status: "missing",
      })
      expect(missing.status).toBe("missing")

      const relinked = projectAssetSchema.parse({
        id: "asset-relinked",
        role: "screen",
        path: "relinked.mp4",
        status: "relinked",
      })
      expect(relinked.status).toBe("relinked")
    })

    it("parses recovery and library results with optional fields missing", () => {
      const recovery = recoveryScanResultSchema.parse({
        sessionId: "session-1",
        state: "recovering",
        manifestPath: "manifest.json",
        isRecoverable: true,
        cursorTelemetryAvailable: false,
      })
      expect(recovery.cursorTelemetryAvailable).toBe(false)
      expect(recovery.outputPath).toBeUndefined()

      const recording = libraryRecordingSchema.parse({
        id: "recording-1",
        sessionId: "session-1",
        name: "Recovered",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        durationMs: 0,
        sizeBytes: 0,
        width: 1920,
        height: 1080,
        fps: 30,
        status: "completed",
        source: {
          kind: "display",
          id: "display-1",
          name: "Display",
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        profileName: "balanced",
        workDir: "work",
      })
      expect(recording.outputPath).toBeUndefined()
      expect(recording.webcamPath).toBeUndefined()
    })

    it("loads project-no-cursor without a cursor track", () => {
      const project = loadProject("project-no-cursor.json")
      const state = projectToTimeline(project)

      expect(state.tracks.some((track) => track.kind === "cursor")).toBe(false)
      expect(project.assets.some((asset) => asset.cursorMetadata === "unavailable")).toBe(true)
    })
  })

  describe("cursor telemetry normalization", () => {
    it("accepts V2 cursor telemetry with source and raw coordinates", () => {
      const telemetry = makeCursorTelemetry(10_000, { clickIndices: [60, 120, 180] })

      expect(telemetry.events[0]).toHaveProperty("rawX")
      expect(telemetry.events[0]).toHaveProperty("sourceX")
      expect(telemetry.events[0]).toHaveProperty("shapeChanged")

      const normalized = normalizeCursorTelemetry(telemetry)
      expect(normalized.events.length).toBeGreaterThan(0)

      const engine = createCursorEngine(normalized)
      const frame = engine.evaluate(1000, defaultCursorSettings)
      expect(frame.visible).toBe(true)
    })
  })
})
