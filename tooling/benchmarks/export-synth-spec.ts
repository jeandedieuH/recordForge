/**
 * Synthetic export-benchmark fixture: generates a 60 s screen source
 * (h264+aac), a 60 s mic track, a V2 cursor telemetry asset
 * (cursor_telemetry.json + cursor_events.bin), and chunked/single-pass
 * ExportHarnessSpec JSONs driving a 30 s render with zoom, cursor plate,
 * legacy title/annotation items, burn-in captions, and a bounded audio pass.
 *
 *   bun run tooling/benchmarks/export-synth-spec.ts [outDir]
 *
 * The source media is longer than the export on purpose: the audio pass's
 * input `-t` bound and the seeked video inputs both show up in the timings.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(process.argv[2] ?? join(scriptDir, "out", "synth"))
mkdirSync(join(outDir, "cursor"), { recursive: true })

// Repo sidecars come from `bun run setup:ffmpeg`; RF_FFMPEG/RF_FFPROBE override.
const isWin = process.platform === "win32"
const suffix = isWin ? "-x86_64-pc-windows-msvc.exe" : "-x86_64-unknown-linux-gnu"
const binDir = resolve(scriptDir, "../../apps/desktop/src-tauri/binaries")
const ffmpeg = process.env.RF_FFMPEG ?? join(binDir, `ffmpeg${suffix}`)
const ffprobe = process.env.RF_FFPROBE ?? join(binDir, `ffprobe${suffix}`)

const SOURCE_MS = 60_000
const EXPORT_MS = 30_000
const WIDTH = 1920
const HEIGHT = 1080
const FPS = 30

function run(args: string[]): void {
  const result = spawnSync(args[0], args.slice(1), { stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${args.join(" ")}`)
  }
}

// --- media ---------------------------------------------------------------

const screenPath = join(outDir, "screen.mp4")
const micPath = join(outDir, "mic.m4a")
console.log("generating 60s screen source + mic track…")
run([
  ffmpeg,
  "-y",
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SOURCE_MS / 1000}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${SOURCE_MS / 1000}`,
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  "-shortest",
  screenPath,
])
run([
  ffmpeg,
  "-y",
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=880:sample_rate=48000:duration=${SOURCE_MS / 1000}`,
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  micPath,
])

// --- V2 cursor telemetry ---------------------------------------------------
// Binary format (read_event_record in capture/cursor_v2.rs): RFCT magic +
// u32 version + u64 count header, then 32-byte records:
//   u64 tMs | i32 rawX | i32 rawY | f64 sourceX | f32 sourceY |
//   u8 buttonFlags | u8 buttonEventKind | u8 visible | u8 shapeIndex
// Button *events* are re-derived from adjacent flag states, so only the flag
// bits need to be right.

const SAMPLE_HZ = 120
const cursorDir = join(outDir, "cursor")
const eventCount = Math.floor((SOURCE_MS * SAMPLE_HZ) / 1000)
const bin = Buffer.alloc(16 + eventCount * 32)
bin.write("RFCT", 0, "latin1")
bin.writeUInt32LE(1, 4)
bin.writeBigUInt64LE(BigInt(eventCount), 8)

function cursorPosition(tMs: number): { x: number; y: number } {
  // Bounded Lissajous — same fixture shape as cursor-follow-path-benchmark.ts.
  const phase = (tMs / 2_400) * Math.PI * 2
  return {
    x: 960 + 800 * Math.sin(phase) + 90 * Math.sin(3 * phase + 0.35),
    y: 540 + 400 * Math.sin(2 * phase + 0.7) + 45 * Math.cos(5 * phase),
  }
}

let offset = 16
for (let i = 0; i < eventCount; i++) {
  const tMs = Math.round((i * 1000) / SAMPLE_HZ)
  const { x, y } = cursorPosition(tMs)
  // A left-button hold every 3 s for ~150 ms exercises click-window raster.
  const clickPhase = tMs % 3_000
  const leftDown = clickPhase < 150
  bin.writeBigUInt64LE(BigInt(tMs), offset)
  bin.writeInt32LE(Math.round(x), offset + 8)
  bin.writeInt32LE(Math.round(y), offset + 12)
  bin.writeDoubleLE(x, offset + 16)
  bin.writeFloatLE(y, offset + 24)
  bin[offset + 28] = leftDown ? 1 : 0
  bin[offset + 29] = 0 // kind is re-derived on read
  bin[offset + 30] = 1
  bin[offset + 31] = 0 // shapes[0] = arrow
  offset += 32
}
writeFileSync(join(cursorDir, "cursor_events.bin"), bin)

const telemetryMeta = {
  schemaVersion: 2,
  assetId: "cursor-bench",
  recordingId: "bench-synth",
  sourceWidth: WIDTH,
  sourceHeight: HEIGHT,
  captureBounds: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  coordinateTransform: { a00: 1, a01: 0, a10: 0, a11: 1, b0: 0, b1: 0 },
  shapes: [{ shapeId: "arrow", hotspotX: 2, hotspotY: 2, width: 24, height: 24, kind: "arrow" }],
  timebase: { unit: "ms", ticksPerSecond: 1000 },
  sampleRateHz: SAMPLE_HZ,
  clickWindowMs: 350,
  health: "healthy",
  eventCount,
  index: [],
  eventFile: "cursor_events.bin",
}
writeFileSync(join(cursorDir, "cursor_telemetry.json"), JSON.stringify(telemetryMeta, null, 1))
console.log(`telemetry: ${eventCount} events @ ${SAMPLE_HZ}Hz`)

// --- render plan -------------------------------------------------------------
// Two contiguous source windows from the same 60 s asset exercise the
// seeked-input path; zoom/cursor/texts/captions load every plate plane.

const screenSegment = (
  sourceInMs: number,
  sourceOutMs: number,
  outputStartMs: number,
): Record<string, unknown> => ({
  assetId: "screen",
  streamIndex: 0,
  speed: 1.0,
  sourceInMs,
  sourceOutMs,
  outputStartMs,
  outputEndMs: outputStartMs + (sourceOutMs - sourceInMs),
  sourceWidth: WIDTH,
  sourceHeight: HEIGHT,
})

const plan = {
  projectId: "bench-synth",
  durationMs: EXPORT_MS,
  segments: [screenSegment(5_000, 20_000, 0), screenSegment(30_000, 45_000, 15_000)],
  gaps: [],
  canvas: {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    padding: 48,
    borderRadius: 24,
    shadow: true,
  },
  zoomSegments: [
    {
      id: "zoom-1",
      startMs: 4_000,
      endMs: 9_000,
      target: { x: 480, y: 270, width: 960, height: 540 },
      scale: 1.5,
      mode: "manual",
    },
    {
      id: "zoom-2",
      startMs: 16_000,
      endMs: 22_000,
      target: { x: 960, y: 540, width: 960, height: 540 },
      scale: 2.0,
      mode: "manual",
    },
  ],
  cursorEffects: [
    {
      id: "cursor-1",
      assetId: "cursor",
      startMs: 0,
      endMs: EXPORT_MS,
      enabled: true,
      presetId: "recorded-system",
      scale: 1.0,
      smoothing: "strong",
      settings: {},
    },
  ],
  texts: [
    {
      id: "title-1",
      startMs: 2_000,
      endMs: 8_000,
      primaryText: "Export Benchmark",
      secondaryText: "synthetic fixture",
      tagText: "BENCH",
      x: 160,
      y: 760,
      width: 1_200,
      height: 240,
    },
    {
      id: "title-2",
      startMs: 17_000,
      endMs: 25_000,
      primaryText: "Second Title",
      x: 320,
      y: 200,
      width: 1_000,
      height: 180,
    },
  ],
  annotations: [
    {
      id: "ann-1",
      startMs: 10_000,
      endMs: 15_000,
      annotationType: "arrow",
      x: 400,
      y: 400,
      width: 500,
      height: 200,
      endX: 900,
      endY: 600,
    },
    {
      id: "ann-2",
      startMs: 20_000,
      endMs: 28_000,
      annotationType: "rectangle",
      x: 1_200,
      y: 700,
      width: 400,
      height: 250,
    },
  ],
  captions: [
    { id: "cap-1", text: "synthetic caption line one", startMs: 1_000, endMs: 4_000 },
    {
      id: "cap-2",
      text: "a second caption exercises the ASS path",
      startMs: 12_000,
      endMs: 16_000,
    },
    { id: "cap-3", text: "final caption for chunked seams", startMs: 26_000, endMs: 29_500 },
  ],
  audioTracks: [
    {
      assetId: "mic",
      streamIndex: 0,
      volume: 1.0,
      muted: false,
      segments: [
        {
          assetId: "mic",
          streamIndex: 0,
          speed: 1.0,
          sourceInMs: 5_000,
          sourceOutMs: 35_000,
          outputStartMs: 0,
          outputEndMs: EXPORT_MS,
        },
      ],
    },
  ],
}

const settings = {
  preset: "default-mp4",
  codec: "h264",
  encoder: "auto",
  container: "mp4",
  captionMode: "burn-in",
  chapterMode: "off",
}

const assetPaths = {
  screen: screenPath,
  mic: micPath,
  // The cursor effect resolves telemetry from the asset path's parent dir.
  cursor: join(cursorDir, "cursor_telemetry.json"),
}

for (const single of [false, true]) {
  const spec = {
    plan,
    settings,
    assetPaths,
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    outputPath: join(outDir, `render_synth${single ? "_single" : "_chunked"}.mp4`),
    forceSinglePass: single,
  }
  const name = `spec_synth_${single ? "single" : "chunked"}.json`
  writeFileSync(join(outDir, name), JSON.stringify(spec))
  console.log(`wrote ${join(outDir, name)}`)
}
console.log(`\nsynth fixture ready in ${outDir}`)
console.log(`run: bun run tooling/benchmarks/export-bench.ts ${outDir}`)
