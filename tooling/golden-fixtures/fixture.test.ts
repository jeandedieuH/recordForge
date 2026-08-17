import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  cursorTelemetryFileSchema,
  recordingConfigSchema,
  recordingStatusSchema,
  libraryRecordingSchema,
  projectSchema,
  renderPlanSchema,
} from "@recordforge/contracts"

interface EditorFixtureClip {
  kind?: string
  startMs: number
  durationMs: number
  sourceInMs?: number
  sourceOutMs?: number
  speed?: number
  [key: string]: unknown
}

interface EditorFixtureTrack {
  kind: string
  clips: EditorFixtureClip[]
}

interface EditorFixtureProject {
  format: string
  version: number
  sourceKind?: string
  assets: Array<{ role: string; cursorMetadata?: string; path?: string }>
  tracks: EditorFixtureTrack[]
  markers?: Array<{ timeMs: number }>
}

describe("Fixture Validation", () => {
  test("recording-config.json matches recordingConfigSchema", () => {
    const json = JSON.parse(readFileSync(join(__dirname, "recording-config.json"), "utf-8"))
    const parsed = recordingConfigSchema.parse(json)
    expect(parsed.profile).toBe("balanced")
    expect(parsed.source.kind).toBe("display")
  })

  test("recording-status.json matches recordingStatusSchema", () => {
    const json = JSON.parse(readFileSync(join(__dirname, "recording-status.json"), "utf-8"))
    const parsed = recordingStatusSchema.parse(json)
    expect(parsed.state).toBe("recording")
    expect(parsed.durationMs).toBe(15000)
  })

  test("library-recording.json matches libraryRecordingSchema", () => {
    const json = JSON.parse(readFileSync(join(__dirname, "library-recording.json"), "utf-8"))
    const parsed = libraryRecordingSchema.parse(json)
    expect(parsed.status).toBe("completed")
    expect(parsed.tags).toContain("demo")
  })

  test("render-plan.json matches the project-scoped renderPlanSchema", () => {
    const json = JSON.parse(readFileSync(join(__dirname, "render-plan.json"), "utf-8"))
    const parsed = renderPlanSchema.parse(json)
    expect(parsed.projectId).toBe("project-phase8")
    expect(parsed.gaps).toEqual([{ startMs: 3000, endMs: 5000 }])
    expect(parsed.segments[1].speed).toBe(1.5)
  })

  test("editor cursor fixture matches cursorTelemetryFileSchema", () => {
    const json = JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "editor-fixtures", "cursor-telemetry.json"),
        "utf-8",
      ),
    )
    const parsed = cursorTelemetryFileSchema.parse(json)

    expect(parsed.sourceWidth).toBe(1024)
    expect(parsed.sourceHeight).toBe(768)
    expect(parsed.events.some((event) => event.buttonEvent.startsWith("left"))).toBe(true)
    expect(parsed.events.some((event) => event.buttonEvent.startsWith("right"))).toBe(true)

    for (const [index, event] of parsed.events.entries()) {
      expect(event.sourceX).toBeGreaterThanOrEqual(0)
      expect(event.sourceX).toBeLessThanOrEqual(parsed.sourceWidth)
      expect(event.sourceY).toBeGreaterThanOrEqual(0)
      expect(event.sourceY).toBeLessThanOrEqual(parsed.sourceHeight)
      if (index > 0) expect(event.tMs).toBeGreaterThan(parsed.events[index - 1].tMs)
    }
  })

  test("editor project fixture includes the Phase 0 edge cases", () => {
    // This is a target-shape fixture; Phase 1 will publish the durable project schema.
    const project = JSON.parse(
      readFileSync(join(__dirname, "..", "fixtures", "editor-fixtures", "project.json"), "utf-8"),
    ) as EditorFixtureProject

    expect(project.format).toBe("recordforge.project")
    expect(project.version).toBe(1)
    expect(project.assets.map((asset) => asset.role)).toEqual(
      expect.arrayContaining([
        "screen",
        "webcam",
        "microphone",
        "system_audio",
        "cursor_events",
        "caption",
      ]),
    )

    const screenTrack = project.tracks.find((track) => track.kind === "screen")
    expect(screenTrack).toBeDefined()
    if (!screenTrack) throw new Error("screen track fixture is missing")
    expect(screenTrack.clips).toHaveLength(2)
    const firstScreenClip = screenTrack.clips[0]
    const slowedClip = screenTrack?.clips[1]
    expect(slowedClip).toMatchObject({ startMs: 5000, speed: 0.75 })
    expect(slowedClip).toBeDefined()
    if (
      !slowedClip ||
      slowedClip.sourceInMs === undefined ||
      slowedClip.sourceOutMs === undefined ||
      slowedClip.speed === undefined
    ) {
      throw new Error("slowed screen clip fixture is missing source timing")
    }
    expect(firstScreenClip.startMs + firstScreenClip.durationMs).toBe(3000)
    expect(slowedClip.startMs - (firstScreenClip.startMs + firstScreenClip.durationMs)).toBe(2000)
    expect((slowedClip.sourceOutMs - slowedClip.sourceInMs) / slowedClip.speed).toBe(
      slowedClip.durationMs,
    )

    expect(project.markers?.some((marker) => marker.timeMs === 5000)).toBe(true)

    const captions = readFileSync(
      join(__dirname, "..", "fixtures", "editor-fixtures", "captions.srt"),
      "utf-8",
    )
    expect(captions.split(/\r?\n\r?\n/)).toHaveLength(3)
    expect(captions).toMatch(/1\r?\n00:00:00,500 --> 00:00:02,000\r?\nOpen the project fixture\./)
    expect(captions).toMatch(
      /2\r?\n00:00:02,500 --> 00:00:04,500\r?\nFocus follows the recorded interaction\./,
    )

    const zoomClip = project.tracks.find((track) => track.kind === "zoom")?.clips[0]
    expect(zoomClip).toMatchObject({
      kind: "zoom-effect",
      startMs: 1000,
      durationMs: 1500,
      scale: 1.5,
      easing: "smooth",
    })
    expect(zoomClip?.target).toMatchObject({ x: 120, y: 96, width: 420, height: 300 })

    const maskClip = project.tracks.find((track) => track.kind === "masks")?.clips[0]
    expect(maskClip).toMatchObject({
      kind: "mask",
      startMs: 5000,
      durationMs: 1000,
      mode: "redaction",
      shape: "rectangle",
    })
  })

  test("editor overlay fixture includes annotations, titles, and external images", () => {
    const project = JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "editor-fixtures", "project-overlays.json"),
        "utf-8",
      ),
    ) as EditorFixtureProject

    const overlayTrack = project.tracks.find((track) => track.kind === "overlay")
    expect(overlayTrack).toBeDefined()
    if (!overlayTrack) throw new Error("overlay track fixture is missing")

    expect(overlayTrack.clips.map((clip) => clip.kind)).toEqual(
      expect.arrayContaining(["annotation", "text", "image"]),
    )
    expect(overlayTrack.clips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "annotation",
          annotationType: "rounded-rect",
          zIndex: 10,
        }),
        expect.objectContaining({
          kind: "text",
          primaryText: "Overlay Engine Demo",
          presetId: "title-modern",
        }),
        expect.objectContaining({
          kind: "image",
          assetId: "asset-external-logo",
          fit: "contain",
        }),
      ]),
    )

    const parsed = projectSchema.parse(project)
    expect(parsed.tracks.find((track) => track.kind === "overlay")?.clips).toHaveLength(4)
    expect(parsed.tracks.find((track) => track.kind === "overlay")?.clips[0]).toMatchObject({
      rotation: 0,
      zIndex: 10,
      overlayAnimation: {
        inType: "fade",
        outType: "fade",
        inDurationMs: 350,
        outDurationMs: 350,
        easing: "expo-out",
      },
    })
    expect(parsed.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "asset-external-logo",
          role: "graphic",
          kind: "image",
          path: "external-logo.svg",
          importStrategy: "copy",
          svgSafe: true,
        }),
      ]),
    )

    const svg = readFileSync(
      join(__dirname, "..", "fixtures", "editor-fixtures", "external-logo.svg"),
      "utf-8",
    )
    expect(svg).not.toMatch(/<script|on[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']https?:\/\//i)
    for (const asset of project.assets) {
      if (asset.path) expect(asset.path).not.toMatch(/^(?:[a-z]:[\\/]|[\\/])/i)
    }
  })

  test("editor no-cursor fixture represents imported media", () => {
    const project = JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "editor-fixtures", "project-no-cursor.json"),
        "utf-8",
      ),
    ) as EditorFixtureProject

    expect(project.sourceKind).toBe("imported")
    expect(project.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ cursorMetadata: "unavailable" })]),
    )
    expect(project.assets.map((asset) => asset.role)).not.toContain("cursor_events")
    expect(project.tracks.map((track) => track.kind)).not.toContain("cursor")
  })

  test("editor long fixture covers the five-minute performance case", () => {
    const project = JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "editor-fixtures", "project-long.json"),
        "utf-8",
      ),
    ) as EditorFixtureProject
    const screenClip = project.tracks.find((track) => track.kind === "screen")?.clips[0]

    expect(project.format).toBe("recordforge.project")
    expect(project.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "720p30_5m.mp4" })]),
    )
    expect(screenClip).toMatchObject({ durationMs: 300000, sourceOutMs: 300000 })
  })
})
