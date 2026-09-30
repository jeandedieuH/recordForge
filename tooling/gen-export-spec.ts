/**
 * Dev tool: build a render plan + ExportHarnessSpec from a real on-disk
 * project.json so the export_harness binary can drive the real Rust pipeline
 * against actual user data (no Tauri UI needed).
 *
 *   bun run tooling/gen-export-spec.ts <sessionDir> <outDir> [rangeStartMs rangeEndMs]...
 *
 * Emits per range: spec_chunked_<s>_<e>.json and spec_single_<s>_<e>.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { timelineStateSchema } from "@recordforge/contracts"
import { createCursorEngine } from "@recordforge/cursor-core"
import { buildRenderPlan } from "@recordforge/media-core"

const sessionDir = process.argv[2]
const outDir = process.argv[3] ?? join(sessionDir, "specs")
const ranges: Array<[number, number]> = []
for (let i = 4; i + 1 < process.argv.length + 1; i += 2) {
  const a = Number(process.argv[i])
  const b = Number(process.argv[i + 1])
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) ranges.push([a, b])
}
if (!sessionDir) {
  console.error("usage: gen-export-spec.ts <sessionDir> <outDir> [startMs endMs]...")
  process.exit(2)
}
if (ranges.length === 0) ranges.push([0, Number.MAX_SAFE_INTEGER])

const project = JSON.parse(readFileSync(join(sessionDir, "project.json"), "utf8"))
const state = timelineStateSchema.parse({
  ...project,
  version: 1,
})

// Decode the V2 cursor_events.bin (RFCT magic, u32 version, u64 count, 32-byte records)
const meta = JSON.parse(readFileSync(join(sessionDir, "cursor_telemetry.json"), "utf8"))
const bin = readFileSync(join(sessionDir, meta.eventFile ?? "cursor_events.bin"))
if (bin.subarray(0, 4).toString("latin1") !== "RFCT") throw new Error("bad event file magic")
const count = Number(bin.readBigUInt64LE(8))
const shapes = meta.shapes ?? []
const events: any[] = []
for (let i = 0; i < count; i++) {
  const o = 16 + i * 32
  const flags = bin[o + 28]
  const prev = events[i - 1]
  const prevFlags = prev ? prev._flags : 0
  const down = (flags & ~prevFlags) !== 0
  const up = (~flags & prevFlags) !== 0
  const held = flags !== 0 && !down
  events.push({
    tMs: Number(bin.readBigUInt64LE(o)),
    rawX: bin.readInt32LE(o + 8),
    rawY: bin.readInt32LE(o + 12),
    sourceX: bin.readDoubleLE(o + 16),
    sourceY: bin.readFloatLE(o + 24),
    buttons: {
      left: (flags & 1) !== 0,
      right: (flags & 2) !== 0,
      middle: (flags & 4) !== 0,
      x1: (flags & 8) !== 0,
      x2: (flags & 16) !== 0,
    },
    buttonEvent: down ? "left-down" : up ? "left-up" : held ? "left-held" : "none",
    visible: bin[o + 30] !== 0,
    shapeId: shapes[bin[o + 31]]?.shapeId ?? "unknown",
    shapeChanged: i > 0 && shapes[bin[o + 31]]?.shapeId !== events[i - 1].shapeId,
    _flags: flags,
  })
}
for (const e of events) delete e._flags
const telemetry = { ...meta, events }
const engine = createCursorEngine(telemetry)
console.log(`events=${events.length} engine=${engine ? "ok" : "null"}`)

mkdirSync(outDir, { recursive: true })

const assetPaths: Record<string, string> = {}
for (const asset of project.assets ?? []) {
  if (asset.path) assetPaths[asset.id] = join(sessionDir, asset.path)
}
// Cursor telemetry asset resolves by its metadata path.
const cursorAsset = (project.assets ?? []).find((a: any) => a.role === "cursor_events")
if (cursorAsset) assetPaths[cursorAsset.id] = join(sessionDir, "cursor_telemetry.json")

// FFmpeg/FFprobe sidecars: override via env, else use the repo's release
// sidecars downloaded by `bun run setup:ffmpeg`.
const defaultBinDir = resolve(
  import.meta.dir,
  "../apps/desktop/src-tauri/target/release",
)
const ffmpeg = process.env.RF_FFMPEG ?? join(defaultBinDir, "ffmpeg.exe")
const ffprobe = process.env.RF_FFPROBE ?? join(defaultBinDir, "ffprobe.exe")

for (const [startMs, endMs] of ranges) {
  const isFull = startMs === 0 && endMs === Number.MAX_SAFE_INTEGER
  const settings = {
    preset: isFull ? "default-mp4" : "selected-range",
    codec: "h264",
    encoder: "auto",
    container: "mp4",
    captionMode: "burn-in",
    chapterMode: "embed",
    ...(isFull ? {} : { range: { startMs, endMs } }),
  }
  const result = buildRenderPlan({
    state,
    projectId: project.id,
    settings: settings as any,
    captionMode: "burn-in",
    chapterMode: "embed",
    assets: project.assets,
    cursorTelemetry: telemetry as any,
    cursorEngine: engine,
  })
  if (!result.ok) {
    console.error(`plan failed for ${startMs}-${endMs}:`, result.error)
    continue
  }
  const plan = result.value
  const tag = isFull ? "full" : `${startMs}_${endMs}`
  writeFileSync(join(outDir, `plan_${tag}.json`), JSON.stringify(plan, null, 1))
  console.log(
    `plan ${tag}: dur=${plan.durationMs}ms segs=${plan.segments.length} zoom=${plan.zoomSegments.length} ` +
      `motion=${plan.zoomSegments.filter((z: any) => z.motionPlan).length} overlays=${plan.overlays.length} ` +
      `cursorEffects=${plan.cursorEffects.length} texts=${plan.texts.length} overlayPlan=${!!plan.overlayRenderPlan}`,
  )
  for (const single of [false, true]) {
    const spec = {
      plan,
      settings,
      assetPaths,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      outputPath: join(outDir, `render_${tag}${single ? "_single" : "_chunked"}.mp4`),
      forceSinglePass: single,
    }
    writeFileSync(
      join(outDir, `spec_${single ? "single" : "chunked"}_${tag}.json`),
      JSON.stringify(spec),
    )
  }
}
console.log("specs written to", resolve(outDir))
