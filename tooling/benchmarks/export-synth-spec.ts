/**
 * Synthetic export-benchmark fixture: generates a screen source (h264+aac),
 * a mic track, a V2 cursor telemetry asset (cursor_telemetry.json +
 * cursor_events.bin), an optional webcam clip, and ExportHarnessSpec JSONs —
 * the "all features" chunked/single-pass specs plus the `abl-<variant>`
 * ablation matrix that isolates the marginal cost of each overlay feature.
 *
 *   bun run tooling/benchmarks/export-synth-spec.ts [outDir] [--encoder <enc>] [--renderer <r>] [--long] [--single-pass]
 *
 * `--encoder` (default `software`) is written into each spec's top-level
 * `encoder` field for the harness to resolve; non-software runs get a
 * `_<encoder>` suffix on spec and render file stems so matrices coexist.
 * `--renderer` (default `compatibility`) sets `settings.renderer`. Every
 * ablation is gate-compatible with the G3 GPU compositor (canvas framing, zoom,
 * cursor, items, keystroke badges, privacy masks, camera, captions), so
 * `--renderer gpu` emits the whole matrix; stems get a `_<renderer>` suffix.
 * The all-features `synth` spec is always emitted too, so the automatic
 * fallback keeps being exercised. `--single-pass` forces every spec
 * through one encoder pass; use it — with its own outDir — for the compatibility
 * baselines that will be compared against the single-pass GPU renderer, because
 * chunked and single-pass x264 encodes of the same frames differ by ~46 dB from
 * per-chunk rate control alone. The full-feature `synth` spec stays in the
 * matrix so the automatic fallback is exercised too.
 * `--long` raises the fixture to a 6 min source / 5 min export and emits only
 * the chunked "all" + plain-ablation specs — pass a separate outDir so the
 * long matrix doesn't collide with the 30 s one.
 *
 * The source media is longer than the export on purpose: the audio pass's
 * input `-t` bound and the seeked video inputs both show up in the timings.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))

// --- args ----------------------------------------------------------------

const VALID_ENCODERS = new Set(["software", "auto", "nvenc", "qsv", "amf", "videotoolbox", "vaapi"])
const VALID_RENDERERS = new Set(["auto", "gpu", "compatibility"])

let outDirArg: string | undefined
let encoder = "software"
let renderer = "compatibility"
let longMode = false
let singlePass = false
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === "--encoder") {
    encoder = argv[++i] ?? ""
    if (!VALID_ENCODERS.has(encoder)) {
      console.error(`--encoder must be one of: ${[...VALID_ENCODERS].join(", ")}`)
      process.exit(2)
    }
  } else if (arg === "--renderer") {
    renderer = argv[++i] ?? ""
    if (!VALID_RENDERERS.has(renderer)) {
      console.error(`--renderer must be one of: ${[...VALID_RENDERERS].join(", ")}`)
      process.exit(2)
    }
  } else if (arg === "--long") {
    longMode = true
  } else if (arg === "--single-pass") {
    singlePass = true
  } else if (arg.startsWith("--")) {
    console.error(`unknown option: ${arg}`)
    process.exit(2)
  } else {
    outDirArg = arg
  }
}

const outDir = resolve(outDirArg ?? join(scriptDir, "out", "synth"))
const encSuffix = encoder === "software" ? "" : `_${encoder}`
const rendererSuffix = renderer === "compatibility" ? "" : `_${renderer}`
const variantSuffix = `${encSuffix}${rendererSuffix}`
mkdirSync(join(outDir, "cursor"), { recursive: true })

// Repo sidecars come from `bun run setup:ffmpeg`; RF_FFMPEG/RF_FFPROBE override.
const isWin = process.platform === "win32"
const suffix = isWin ? "-x86_64-pc-windows-msvc.exe" : "-x86_64-unknown-linux-gnu"
const binDir = resolve(scriptDir, "../../apps/desktop/src-tauri/binaries")
const ffmpeg = process.env.RF_FFMPEG ?? join(binDir, `ffmpeg${suffix}`)
const ffprobe = process.env.RF_FFPROBE ?? join(binDir, `ffprobe${suffix}`)

const SOURCE_MS = longMode ? 360_000 : 60_000
const EXPORT_MS = longMode ? 300_000 : 30_000
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
const webcamPath = join(outDir, "webcam.mp4")
console.log(`generating ${SOURCE_MS / 1000}s screen source + mic track…`)
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
if (!longMode) {
  // Webcam clip for the `camera` ablation: small + cheap to decode, long
  // enough to cover the whole export window.
  run([
    ffmpeg,
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=640x480:rate=${FPS}:duration=${SOURCE_MS / 1000}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    webcamPath,
  ])
}

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

// --- render plan -----------------------------------------------------------
// Two contiguous source windows from the same long asset exercise the
// seeked-input path. `plain` (the ablation base) is the same two screen
// segments + the mic track on a bare canvas; every variant adds exactly one
// feature so the table reports its marginal cost.

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

const screenSegments = longMode
  ? [screenSegment(10_000, 160_000, 0), screenSegment(200_000, 350_000, 150_000)]
  : [screenSegment(5_000, 20_000, 0), screenSegment(30_000, 45_000, 15_000)]

const micSource = longMode ? { inMs: 20_000, outMs: 320_000 } : { inMs: 5_000, outMs: 35_000 }
const audioTracks = [
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
        sourceInMs: micSource.inMs,
        sourceOutMs: micSource.outMs,
        outputStartMs: 0,
        outputEndMs: EXPORT_MS,
      },
    ],
  },
]

// Effect timings stay in the first 30 s even in --long mode — the ablations
// measure marginal cost on identical short bursts either way.
const zoomSegments = [
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
]
const cursorEffects = [
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
]
const texts = [
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
]
const annotations = [
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
]
const captions = [
  { id: "cap-1", text: "synthetic caption line one", startMs: 1_000, endMs: 4_000 },
  {
    id: "cap-2",
    text: "a second caption exercises the ASS path",
    startMs: 12_000,
    endMs: 16_000,
  },
  { id: "cap-3", text: "final caption for chunked seams", startMs: 26_000, endMs: 29_500 },
]
// Privacy masks cover all three modes: an opaque redact block, a pixelate
// window, and a blur. The blur chain is rendered on the GPU via swscale's
// triangle downscale + avgblur + bilinear upscale, and the standalone `blur`
// spec below exercises it.
const masks = [
  {
    id: "mask-redact",
    assetId: null,
    startMs: 6_000,
    endMs: 12_000,
    mode: "redact",
    rect: { x: 240, y: 180, width: 480, height: 320 },
    blurRadius: 12,
    pixelSize: 8,
    redactColor: "#101010",
    enabled: true,
  },
  {
    id: "mask-pixelate",
    assetId: null,
    startMs: 18_000,
    endMs: 24_000,
    mode: "pixelate",
    rect: { x: 420, y: 620, width: 360, height: 240 },
    blurRadius: 8,
    pixelSize: 16,
    redactColor: "#000000",
    enabled: true,
  },
]
const blurMask = {
  id: "mask-blur",
  assetId: null,
  startMs: 1_500,
  endMs: 8_500,
  mode: "blur",
  rect: { x: 1_100, y: 500, width: 520, height: 340 },
  blurRadius: 24,
  pixelSize: 8,
  redactColor: "#000000",
  enabled: true,
}
// Keystroke badges: modifier combos every ~2 s, within the default 2.2 s hold
// window so the badge plate is populated on most frames.
const keystrokes = Array.from({ length: 15 }, (_, index) => ({
  tMs: 1_000 + index * 2_000,
  key: index % 2 === 0 ? "s" : "c",
  modifiers: index % 2 === 0 ? ["ctrl"] : ["ctrl", "shift"],
}))
// One camera overlay covering the whole export: circle, bottom-right with the
// same 48 px margin the padded variants use, border + shadow on so the full
// mask/border/shadow-plate path is exercised.
const cameraOverlay = {
  assetId: "webcam",
  sourceInMs: 0,
  sourceOutMs: EXPORT_MS,
  outputStartMs: 0,
  outputEndMs: EXPORT_MS,
  x: WIDTH - 320 - 48,
  y: HEIGHT - 320 - 48,
  width: 320,
  height: 320,
  shape: "circle",
  borderWidth: 4,
  borderColor: "#ffffff",
  borderOpacity: 1.0,
  shadowEnabled: true,
  shadowColor: "#000000",
  shadowBlur: 24,
  shadowOffsetX: 0,
  shadowOffsetY: 8,
}

const plainCanvas = {
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  padding: 0,
  borderRadius: 0,
  shadow: false,
}

function plainPlan(canvas: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: "bench-synth",
    durationMs: EXPORT_MS,
    segments: screenSegments,
    gaps: [],
    canvas: { ...plainCanvas, ...canvas },
    zoomSegments: [],
    cursorEffects: [],
    texts: [],
    annotations: [],
    captions: [],
    overlays: [],
    audioTracks,
  }
}

const ablations: Array<{
  name: string
  plan: Record<string, unknown>
  extraAssets?: Record<string, string>
}> = [
  { name: "plain", plan: plainPlan() },
  { name: "padding", plan: plainPlan({ padding: 48 }) },
  { name: "radius", plan: plainPlan({ padding: 48, borderRadius: 24 }) },
  { name: "shadow", plan: plainPlan({ padding: 48, shadow: true }) },
  { name: "zoom", plan: { ...plainPlan(), zoomSegments } },
  { name: "cursor", plan: { ...plainPlan(), cursorEffects } },
  { name: "items", plan: { ...plainPlan(), texts, annotations } },
  { name: "masks", plan: { ...plainPlan(), masks } },
  { name: "keys", plan: { ...plainPlan(), keystrokes, keystrokePlatform: "windows" } },
  { name: "captions", plan: { ...plainPlan(), captions } },
  {
    name: "camera",
    plan: { ...plainPlan(), overlays: [cameraOverlay] },
    extraAssets: { webcam: webcamPath },
  },
]

// The "all features" plan is unchanged from the original fixture so existing
// docs/benchmarks numbers stay comparable (no privacy masks or keystrokes: they
// get their own ablation rows).
const synthPlan = {
  projectId: "bench-synth",
  durationMs: EXPORT_MS,
  segments: screenSegments,
  gaps: [],
  canvas: {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    padding: 48,
    borderRadius: 24,
    shadow: true,
  },
  zoomSegments,
  cursorEffects,
  texts,
  annotations,
  captions,
  audioTracks,
}

const settings = {
  preset: "default-mp4",
  codec: "h264",
  encoder: "auto",
  renderer,
  container: "mp4",
  captionMode: "burn-in",
  chapterMode: "off",
  // Enabled for every spec: only plans that carry keystroke events rasterize a
  // badge plate, so the other ablations are unaffected and the `keys` row can
  // share one settings block.
  keystrokeOverlay: { enabled: true },
}

const baseAssetPaths = {
  screen: screenPath,
  mic: micPath,
  // The cursor effect resolves telemetry from the asset path's parent dir.
  cursor: join(cursorDir, "cursor_telemetry.json"),
}

interface SpecEntry {
  name: string
  outputName: string
  plan: Record<string, unknown>
  assetPaths: Record<string, string>
  forceSinglePass: boolean
}

const specs: SpecEntry[] = []
// A blur mask over a textured region: the GPU reproduces swscale's widened
// bilinear downscale, avgblur radius semantics and the final bilinear upscale,
// so this spec is now inside the gate and participates in the parity budget
// rather than proving a fallback.
const blurMaskPlan = {
  ...plainPlan(),
  durationMs: 10_000,
  segments: [screenSegment(5_000, 15_000, 0)],
  masks: [blurMask],
  audioTracks: [
    {
      ...audioTracks[0],
      segments: [{ ...audioTracks[0].segments[0], sourceOutMs: 15_000, outputEndMs: 10_000 }],
    },
  ],
}
// A coverage hole plus a gap entry is deliberately outside the GPU gate: this
// spec proves the automatic fallback still produces the compatibility output
// (the pair must score 100 dB in parity) and keeps the runtime fallback path
// exercised by every matrix run.
const fallbackGapPlan = {
  ...plainPlan(),
  // Short on purpose: < 20 s keeps both sides single-pass, so the fallback pair
  // is a bit-exact comparison instead of a chunking-artifact comparison.
  durationMs: 10_000,
  segments: [screenSegment(5_000, 9_500, 0), screenSegment(30_500, 35_000, 5_500)],
  gaps: [{ startMs: 4_500, endMs: 5_500 }],
  audioTracks: [
    {
      ...audioTracks[0],
      segments: [{ ...audioTracks[0].segments[0], sourceOutMs: 15_000, outputEndMs: 10_000 }],
    },
  ],
}
// Every ablation is inside the G3 GPU gate (canvas framing, zoom, cursor,
// items, masks, keystrokes, camera, burned-in captions), so the whole matrix is
// meaningful on both renderers. Keep the list explicit: a future ablation that
// the compositor cannot render must not silently fall back and report a 100 dB
// "parity" row.
const gpuCompatible = new Set([
  "plain",
  "padding",
  "radius",
  "shadow",
  "zoom",
  "cursor",
  "items",
  "masks",
  "keys",
  "captions",
  "camera",
])
if (longMode) {
  specs.push({
    name: `spec_synth_chunked${variantSuffix}`,
    outputName: `render_synth_chunked${variantSuffix}.mp4`,
    plan: synthPlan,
    assetPaths: baseAssetPaths,
    forceSinglePass: singlePass,
  })
  specs.push({
    name: `spec_abl-plain_chunked${variantSuffix}`,
    outputName: `render_abl-plain_chunked${variantSuffix}.mp4`,
    plan: plainPlan(),
    assetPaths: baseAssetPaths,
    forceSinglePass: singlePass,
  })
} else {
  // `--single-pass` renders every spec through one encoder pass. The GPU
  // renderer is always single-pass, so parity baselines meant to be compared
  // against it must be too: a chunked x264 render differs from a single-pass
  // render of the same frames by ~46 dB purely from per-chunk rate control.
  for (const single of singlePass ? [true] : [false, true]) {
    const mode = single ? "single" : "chunked"
    specs.push({
      name: `spec_synth_${mode}${variantSuffix}`,
      outputName: `render_synth_${mode}${variantSuffix}.mp4`,
      plan: synthPlan,
      assetPaths: baseAssetPaths,
      forceSinglePass: single,
    })
    specs.push({
      name: `spec_fallback_gap_${mode}${variantSuffix}`,
      outputName: `render_fallback_gap_${mode}${variantSuffix}.mp4`,
      plan: fallbackGapPlan,
      assetPaths: baseAssetPaths,
      forceSinglePass: single,
    })
    specs.push({
      name: `spec_blur_${mode}${variantSuffix}`,
      outputName: `render_blur_${mode}${variantSuffix}.mp4`,
      plan: blurMaskPlan,
      assetPaths: baseAssetPaths,
      forceSinglePass: single,
    })
  }
  for (const ablation of ablations) {
    if (renderer === "gpu" && !gpuCompatible.has(ablation.name)) continue
    specs.push({
      name: `spec_abl-${ablation.name}_chunked${variantSuffix}`,
      outputName: `render_abl-${ablation.name}_chunked${variantSuffix}.mp4`,
      plan: ablation.plan,
      assetPaths: { ...baseAssetPaths, ...ablation.extraAssets },
      forceSinglePass: singlePass,
    })
  }
}

for (const entry of specs) {
  const spec = {
    plan: entry.plan,
    settings,
    assetPaths: entry.assetPaths,
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    outputPath: join(outDir, entry.outputName),
    forceSinglePass: entry.forceSinglePass,
    // `encoder` is a harness-only override; software stays implicit so
    // software specs remain byte-compatible with the pre-encoder schema.
    ...(encoder === "software" ? {} : { encoder }),
  }
  writeFileSync(join(outDir, `${entry.name}.json`), JSON.stringify(spec))
  console.log(`wrote ${join(outDir, `${entry.name}.json`)}`)
}
console.log(`\nsynth fixture ready in ${outDir}`)
if (longMode) {
  console.log("long mode: run against a dedicated outDir (e.g. out/synth-long)")
}
console.log(`run: bun run tooling/benchmarks/export-bench.ts ${outDir}`)
