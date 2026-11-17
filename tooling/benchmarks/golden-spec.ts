/**
 * Tiny deterministic fixture for the golden-frame export parity check.
 *
 *   bun run tooling/benchmarks/golden-spec.ts [outDir] [--long-tail] [--gpu]
 *
 * Produces a 480x270 / 3 s testsrc screen and a real `ExportHarnessSpec` that
 * carries one designed title, one filled annotation and one shadowed connector.
 * That is small enough to keep the checked-in golden PNGs reviewable while still
 * covering every overlay raster path that has regressed before.
 *
 * `--long-tail` also emits a 20 s chunked spec that verifies the held frame
 * survives across chunk boundaries. `--gpu` emits the same plan for the wgpu
 * compositor, including the GPU decode pass's last-frame hold. `--effects`
 * emits a second spec that pins the M2 pro effects: zoom/pan motion blur while
 * a frame zoom is mid-transition plus a parked Glass Loupe (`golden/effects`,
 * and `golden/effects-gpu` for the analytic lens when combined with `--gpu`).
 * Then render with `export_harness` and drive `golden-frames.ts` (see
 * docs/benchmarks/golden-frames.md).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const longTail = args.includes("--long-tail")
const gpuCandidate = args.includes("--gpu")
const effects = args.includes("--effects")
const outDirArg = args.find((arg) => !arg.startsWith("--"))
const outDir = resolve(outDirArg ?? join(scriptDir, "out", "golden"))
mkdirSync(outDir, { recursive: true })

const isWin = process.platform === "win32"
const suffix = isWin ? "-x86_64-pc-windows-msvc.exe" : "-x86_64-unknown-linux-gnu"
const binDir = resolve(scriptDir, "../../apps/desktop/src-tauri/binaries")
const ffmpeg = process.env.RF_FFMPEG ?? join(binDir, `ffmpeg${suffix}`)
const ffprobe = process.env.RF_FFPROBE ?? join(binDir, `ffprobe${suffix}`)

const WIDTH = 480
const HEIGHT = 270
const FPS = 30
const SCREEN_MS = 3_000
// One second of overlay-only tail: the export must hold the final screen frame
// while the title stays visible. A golden at 3.5 s pins that behavior.
const TAIL_MS = 1_000
const DURATION_MS = SCREEN_MS + TAIL_MS
const screenPath = join(outDir, "screen.mp4")

const result = spawnSync(
  ffmpeg,
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${SCREEN_MS / 1000}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    screenPath,
  ],
  { stdio: ["ignore", "pipe", "inherit"] },
)
if (result.status !== 0) {
  throw new Error(`failed to generate golden fixture (${result.status})`)
}

const plan = {
  projectId: "golden-items",
  durationMs: DURATION_MS,
  segments: [
    {
      assetId: "screen",
      streamIndex: 0,
      speed: 1,
      sourceInMs: 0,
      sourceOutMs: SCREEN_MS,
      outputStartMs: 0,
      outputEndMs: SCREEN_MS,
    },
  ],
  gaps: [{ startMs: SCREEN_MS, endMs: DURATION_MS }],
  canvas: {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    padding: 0,
    borderRadius: 0,
    shadow: false,
  },
  zoomSegments: [],
  cursorEffects: [],
  texts: [
    {
      id: "title-1",
      startMs: 100,
      endMs: DURATION_MS,
      primaryText: "Golden frame",
      secondaryText: "export parity",
      tagText: "GOLDEN",
      x: 30,
      y: 140,
      width: 420,
      height: 90,
      presetId: "text-clean",
      category: "title",
      // v2 design exercising the new raster paths: gradient fill, stroke,
      // shadow, and an emphasis span — the v1 payload migrated to this shape.
      titleDesign: {
        version: 2,
        template: "hook-emphasis",
        emphasis: { text: "Golden", style: "marker" },
        fill: {
          kind: "gradient",
          gradientAngle: 135,
          gradientStops: [
            { offset: 0, color: "#ffffff" },
            { offset: 1, color: "#93c5fd" },
          ],
        },
        stroke: { color: "#0f172a", width: 1.5 },
        shadow: { color: "rgba(0,0,0,0.5)", blur: 14, offsetX: 0, offsetY: 4 },
        animation: {
          in: { preset: "rise", durationMs: 400 },
          out: { preset: "fade", durationMs: 300 },
        },
      },
      backdropStyle: "solid",
      backdropColor: "#0f172a",
      backdropOpacity: 0.75,
      backdropBorderRadius: 10,
    },
  ],
  annotations: [
    {
      id: "ann-box",
      startMs: 200,
      endMs: 2_800,
      annotationType: "rounded-rect",
      x: 40,
      y: 40,
      width: 130,
      height: 70,
      strokeColor: "#38bdf8",
      strokeWidth: 4,
      strokeStyle: "solid",
      fillColor: "#38bdf8",
      fillOpacity: 0.18,
      cornerRadius: 12,
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowBlur: 8,
    },
    {
      id: "ann-arrow",
      startMs: 400,
      endMs: 2_600,
      annotationType: "arrow",
      x: 190,
      y: 70,
      width: 120,
      height: 60,
      endX: 310,
      endY: 130,
      strokeColor: "#f43f5e",
      strokeWidth: 5,
      strokeStyle: "solid",
      arrowStartHead: "none",
      arrowEndHead: "arrow",
      arrowStyle: "curved",
      shadowEnabled: true,
      shadowColor: "#000000",
      shadowBlur: 10,
    },
  ],
  captions: [],
  overlays: [],
  masks: [],
  chapters: [],
  audioTracks: [],
}

const spec = {
  plan,
  settings: {
    preset: "default-mp4",
    codec: "h264",
    encoder: "software",
    renderer: "compatibility",
    container: "mp4",
    captionMode: "burn-in",
    chapterMode: "off",
    keystrokeOverlay: { enabled: false },
  },
  assetPaths: { screen: screenPath },
  ffmpegPath: ffmpeg,
  ffprobePath: ffprobe,
  outputPath: join(outDir, "render_golden.mp4"),
  forceSinglePass: true,
}

const specPath = join(outDir, "spec_golden.json")
writeFileSync(specPath, JSON.stringify(spec, null, 2))
console.log(`golden fixture: ${screenPath}`)
console.log(`golden spec:    ${specPath}`)

if (gpuCandidate) {
  // Same plan through the native wgpu compositor. The trailing tail exercises
  // the GPU decode pass's last-frame hold; compare with the compatibility
  // goldens using the `renderer` parity budget.
  const gpuSpec = JSON.parse(JSON.stringify(spec)) as typeof spec
  gpuSpec.settings.renderer = "gpu"
  gpuSpec.outputPath = join(outDir, "render_gpu_golden.mp4")
  const gpuPath = join(outDir, "spec_gpu_golden.json")
  writeFileSync(gpuPath, JSON.stringify(gpuSpec, null, 2))
  console.log(`gpu spec:       ${gpuPath}`)
}

if (effects) {
  // M2 pro-effects fixture (golden/effects): a frame zoom whose transitions
  // keep the crop moving inside golden windows so the zoom/pan shutter taps
  // actually fire, plus a parked Glass Loupe (no cursor telemetry → the lens
  // sits on its target, fully deterministic). A plan that drops either
  // effect — the loupe-segment regression this fixture guards — visibly
  // differs at 800/1600/2300 ms.
  const effectsPlan = JSON.parse(JSON.stringify(plan)) as {
    canvas: Record<string, unknown>
    zoomSegments: Record<string, unknown>[]
    texts: unknown[]
    annotations: unknown[]
  } & Record<string, unknown>
  effectsPlan.canvas = {
    ...effectsPlan.canvas,
    // Zoom/pan shutter fully open for a readable smear; cursor blur stays
    // off because this fixture ships no telemetry.
    motionBlur: { enabled: true, cursor: 0, zoom: 1, pan: 1 },
  }
  effectsPlan.texts = []
  effectsPlan.annotations = []
  effectsPlan.zoomSegments = [
    {
      id: "zoom-fx",
      startMs: 400,
      endMs: 2_000,
      target: { x: 40, y: 40, width: 240, height: 135 },
      scale: 2,
      easing: "linear",
      transitionInMs: 700,
      transitionOutMs: 700,
      enabled: true,
      mode: "manual",
    },
    {
      id: "loupe-fx",
      startMs: 500,
      endMs: 2_500,
      target: { x: 200, y: 80, width: 160, height: 90 },
      scale: 2,
      easing: "linear",
      transitionInMs: 400,
      transitionOutMs: 400,
      enabled: true,
      mode: "manual",
      style: "loupe",
      loupe: {
        shape: "rounded-rect",
        size: 0.4,
        cornerRadius: 0.24,
        ringWidth: 6,
        ringColor: "#ffffff",
        ringOpacity: 0.9,
        glass: true,
        shadowBlur: 24,
        shadowOpacity: 0.35,
        followCursor: false,
      },
    },
  ]
  const effectsSpec = JSON.parse(JSON.stringify(spec)) as typeof spec
  effectsSpec.plan = effectsPlan as typeof spec.plan
  effectsSpec.outputPath = join(outDir, "render_effects.mp4")
  const effectsPath = join(outDir, "spec_effects.json")
  writeFileSync(effectsPath, JSON.stringify(effectsSpec, null, 2))
  console.log(`effects spec:   ${effectsPath}`)

  if (gpuCandidate) {
    const gpuEffects = JSON.parse(JSON.stringify(effectsSpec)) as typeof spec
    gpuEffects.settings.renderer = "gpu"
    gpuEffects.outputPath = join(outDir, "render_effects_gpu.mp4")
    const gpuEffectsPath = join(outDir, "spec_effects_gpu.json")
    writeFileSync(gpuEffectsPath, JSON.stringify(gpuEffects, null, 2))
    console.log(`gpu effects:    ${gpuEffectsPath}`)
  }
}

if (longTail) {
  // A tail long enough to span several default chunks. The last screen chunk
  // must absorb the pure-tail chunks so the held frame is never replaced by
  // the canvas background.
  const LONG_TAIL_MS = 20_000
  const longTailSpec = JSON.parse(JSON.stringify(spec)) as typeof spec
  longTailSpec.plan.durationMs = LONG_TAIL_MS
  longTailSpec.plan.gaps = [{ startMs: SCREEN_MS, endMs: LONG_TAIL_MS }]
  longTailSpec.plan.texts[0]!.endMs = LONG_TAIL_MS
  longTailSpec.plan.annotations = []
  longTailSpec.forceSinglePass = false
  longTailSpec.outputPath = join(outDir, "render_longtail.mp4")
  const longTailPath = join(outDir, "spec_longtail.json")
  writeFileSync(longTailPath, JSON.stringify(longTailSpec, null, 2))
  console.log(`long-tail spec: ${longTailPath}`)

  if (gpuCandidate) {
    const gpuLongTail = JSON.parse(JSON.stringify(longTailSpec)) as typeof longTailSpec
    gpuLongTail.settings.renderer = "gpu"
    gpuLongTail.outputPath = join(outDir, "render_longtail_gpu.mp4")
    const gpuLongTailPath = join(outDir, "spec_longtail_gpu.json")
    writeFileSync(gpuLongTailPath, JSON.stringify(gpuLongTail, null, 2))
    console.log(`long-tail gpu:  ${gpuLongTailPath}`)
  }
}

console.log(`render with:    export_harness ${specPath}`)
