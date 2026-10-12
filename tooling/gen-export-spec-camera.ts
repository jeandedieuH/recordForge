/**
 * THROWAWAY (M4 export measurement): build render plans + ExportHarnessSpec
 * JSONs for a real camera-only session directory (one containing
 * `output.mp4`). Produces two plan variants from the same recording:
 *
 *   A — camera defaults as the editor produces them (padding 0, radius 0,
 *       no zooms, source-size canvas).
 *   B — a screen-style project on the same footage (padding 24, radius 24,
 *       two manual zoom segments).
 *
 *   bun run tooling/gen-export-spec-camera.ts <sessionDir> <outDir>
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  createProjectFromRecording,
  projectToTimeline,
  type LibraryRecording,
  type MediaMetadata,
} from "@recordforge/domain"
import { buildRenderPlan } from "@recordforge/media-core"

const sessionDir = process.argv[2]
const outDir = process.argv[3] ?? join(sessionDir, "specs")
if (!sessionDir) {
  console.error("usage: gen-export-spec-camera.ts <sessionDir> <outDir>")
  process.exit(2)
}

const defaultBinDir = resolve(import.meta.dir, "../apps/desktop/src-tauri/target/release")
const ffmpeg = process.env.RF_FFMPEG ?? join(defaultBinDir, "ffmpeg.exe")
const ffprobe = process.env.RF_FFPROBE ?? join(defaultBinDir, "ffprobe.exe")
const outputPath = join(sessionDir, "output.mp4")
if (!existsSync(outputPath)) {
  console.error(`no output.mp4 in ${sessionDir}`)
  process.exit(2)
}

// Probe the capture into a MediaMetadata — same shape the library stores.
interface FfprobeStream {
  index: number
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  duration?: string
  start_time?: string
}
const probe = JSON.parse(
  execFileSync(ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    outputPath,
  ]).toString(),
) as { streams: FfprobeStream[]; format: { duration?: string; format_name?: string } }
const toFps = (rate?: string) => {
  if (!rate) return 30
  const [num, den] = rate.split("/").map(Number)
  return den ? num / den : num
}
const videoStream = probe.streams.find((s) => s.codec_type === "video")!
const fps = toFps(videoStream.r_frame_rate)
const durationMs = Math.round(Number(probe.format.duration ?? 0) * 1000)
const metadata: MediaMetadata = {
  recordingId: "m4-camera-bench",
  path: outputPath,
  durationMs,
  width: videoStream.width ?? 0,
  height: videoStream.height ?? 0,
  fps,
  hasAudio: probe.streams.some((s) => s.codec_type === "audio"),
  streams: probe.streams.map((s) => ({
    index: s.index,
    kind: s.codec_type === "video" ? ("video" as const) : ("audio" as const),
    codec: s.codec_name ?? "unknown",
    startMs: Math.round(Number(s.start_time ?? 0) * 1000),
    durationMs: Math.round(Number(s.duration ?? 0) * 1000),
    ...(s.codec_type === "video" ? { width: s.width, height: s.height, fps } : {}),
  })),
  format: { name: probe.format.format_name ?? "mp4" },
  updatedAt: new Date().toISOString(),
}
const durationSeconds = (durationMs / 1000).toFixed(2)
console.log(
  `probe: ${metadata.width}x${metadata.height} @ ${fps}fps, ${durationSeconds}s, ` +
    `audio=${metadata.hasAudio}`,
)

const recording = {
  id: "m4-camera-bench",
  sessionId: "m4-session",
  name: "Camera m4session",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  durationMs,
  sizeBytes: 0,
  width: videoStream.width ?? 0,
  height: videoStream.height ?? 0,
  fps,
  status: "completed",
  tags: [],
  source: {
    kind: "camera",
    id: "Integrated Webcam",
    name: "Integrated Webcam",
    bounds: { x: 0, y: 0, width: metadata.width, height: metadata.height },
  },
  profileName: "camera-balanced",
  outputPath,
  webcamPath: null,
  workDir: sessionDir,
  thumbnailPath: null,
  markers: [],
} as LibraryRecording

// The editor persists `createProjectFromRecording` output; the export builds
// a plan from `projectToTimeline(project)` — mirror that exact flow.
const project = createProjectFromRecording(recording, metadata)
const assetPaths: Record<string, string> = {}
for (const asset of project.assets) {
  if (asset.path) assetPaths[asset.id] = join(sessionDir, asset.path)
}

const settings = {
  preset: "default-mp4",
  codec: "h264",
  encoder: "auto",
  container: "mp4",
  captionMode: "burn-in",
  chapterMode: "embed",
} as const

mkdirSync(outDir, { recursive: true })

function emit(tag: string, mutate: (state: ReturnType<typeof projectToTimeline>) => void) {
  const state = projectToTimeline(project)
  mutate(state)
  const result = buildRenderPlan({
    state,
    projectId: project.id,
    settings: settings as any,
    captionMode: "burn-in",
    chapterMode: "embed",
    assets: project.assets,
    cursorTelemetry: null,
  })
  if (!result.ok) {
    console.error(`plan ${tag} failed:`, result.error)
    process.exit(1)
  }
  const plan = result.value
  writeFileSync(join(outDir, `plan_${tag}.json`), JSON.stringify(plan, null, 1))
  const canvas = plan.canvas as { width: number; height: number; fps: number }
  console.log(
    `plan ${tag}: ${canvas.width}x${canvas.height} @${canvas.fps} dur=${plan.durationMs}ms ` +
      `segs=${plan.segments.length} zoom=${plan.zoomSegments.length} cursorFx=${plan.cursorEffects.length} ` +
      `overlays=${plan.overlays.length} gaps=${plan.gaps.length}`,
  )
  for (const single of [false, true]) {
    const spec = {
      plan,
      settings,
      assetPaths,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      outputPath: join(outDir, `render_${tag}_${single ? "single" : "chunked"}.mp4`),
      forceSinglePass: single,
    }
    writeFileSync(join(outDir, `spec_${tag}_${single ? "single" : "chunked"}.json`), JSON.stringify(spec))
  }
}

emit("camera", () => {})

emit("screenstyle", (state) => {
  state.canvas.padding = 24
  state.canvas.borderRadius = 24
  const w = state.canvas.width
  const h = state.canvas.height
  state.zoomSegments = [
    {
      id: "zoom-manual-1",
      startMs: Math.min(3_000, Math.round(durationMs * 0.1)),
      durationMs: Math.min(5_000, Math.round(durationMs * 0.2)),
      target: { x: w * 0.18, y: h * 0.18, width: w / 1.8, height: h / 1.8 },
      scale: 1.8,
      easing: "smooth",
      enabled: true,
      locked: false,
      mode: "follow-cursor",
      source: "manual",
      preset: "manual-only",
    },
    {
      id: "zoom-manual-2",
      startMs: Math.min(12_000, Math.round(durationMs * 0.55)),
      durationMs: Math.min(5_000, Math.round(durationMs * 0.2)),
      target: { x: w * 0.35, y: h * 0.3, width: w / 2.2, height: h / 2.2 },
      scale: 2.2,
      easing: "smooth",
      enabled: true,
      locked: false,
      mode: "follow-cursor",
      source: "manual",
      preset: "manual-only",
    },
  ]
})

console.log("specs written to", resolve(outDir))
