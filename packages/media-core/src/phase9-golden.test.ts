import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  projectSchema,
  projectToTimeline,
  type Project,
  type TimelineState,
  type ManualZoomSegment,
} from "@recordforge/domain"
import { buildRenderPlan } from "./render-plan"

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

describe("Phase 9 golden render plan", () => {
  it("builds a plan for the standard project fixture", () => {
    const state = loadTimeline("project.json")
    const plan = buildRenderPlan({ state, projectId: state.id })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.durationMs).toBe(9000)
    expect(plan.value.segments.length).toBeGreaterThanOrEqual(1)
    expect(plan.value.gaps).toEqual([{ startMs: 3000, endMs: 5000 }])
    expect(plan.value.zoomSegments.length).toBeGreaterThanOrEqual(1)
    expect(plan.value.cursorEffects.length).toBeGreaterThanOrEqual(1)
    expect(plan.value.masks.length).toBeGreaterThanOrEqual(1)
    expect(plan.value.captions.length).toBeGreaterThanOrEqual(1)
  })

  it("builds a plan for the no-cursor fixture with no cursor effects", () => {
    const state = loadTimeline("project-no-cursor.json")
    const plan = buildRenderPlan({ state, projectId: state.id })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.durationMs).toBe(5000)
    expect(plan.value.cursorEffects).toHaveLength(0)
    expect(state.tracks.some((track) => track.kind === "cursor")).toBe(false)
  })

  it("builds a selected-range plan for the long fixture", () => {
    const state = loadTimeline("project-long.json")
    const plan = buildRenderPlan({
      state,
      projectId: state.id,
      range: { startMs: 60_000, endMs: 120_000 },
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    expect(plan.value.durationMs).toBe(60_000)
    expect(plan.value.segments[0]?.outputStartMs).toBe(0)
  })
})
