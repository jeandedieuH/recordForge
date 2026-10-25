/**
 * Export pipeline benchmark runner: executes ExportHarnessSpec files through
 * the `export_harness` binary across a worker matrix, captures the tracing
 * stage timings on stderr, and reports a comparison table + JSON results.
 *
 *   bun run tooling/benchmarks/export-bench.ts <spec.json|dir> [options]
 *
 * Specs come from `bun run tooling/gen-export-spec.ts <sessionDir> <outDir>`
 * (real projects) or `bun run tooling/benchmarks/export-synth-spec.ts`
 * (self-contained synthetic fixture).
 *
 * Options:
 *   --repeats N      run each configuration N times (default 1)
 *   --workers a,b,c  RECORDFORGE_EXPORT_CHUNK_WORKERS overrides (chunked only)
 *   --filter <str>   run only specs whose name contains <str>
 *   --no-build       skip the release-binary build check
 *   --out <dir>      where to write logs + results JSON (default: spec dir)
 *   --scratch <dir>  redirect each run's output mp4 + rewritten spec here
 *                    (default: <TEMP>/rf-bench — keeps exports off a full disk)
 *   --reparse <dir>  skip running; rebuild the table from bench-*.log files
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { basename, dirname, join, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))

// --- args ---------------------------------------------------------------

interface BenchArgs {
  input: string
  repeats: number
  workers: number[]
  filter?: string
  noBuild: boolean
  outDir?: string
  scratchDir: string
  reparseDir?: string
}

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = {
    input: "",
    repeats: 1,
    workers: [],
    noBuild: false,
    scratchDir: join(process.env.TEMP ?? "/tmp", "rf-bench"),
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--repeats":
        args.repeats = Math.max(1, Number(argv[++i]) || 1)
        break
      case "--workers":
        args.workers = (argv[++i] ?? "")
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value > 0)
        break
      case "--filter":
        args.filter = argv[++i]
        break
      case "--no-build":
        args.noBuild = true
        break
      case "--out":
        args.outDir = resolve(argv[++i])
        break
      case "--scratch":
        args.scratchDir = resolve(argv[++i])
        break
      case "--reparse":
        args.reparseDir = resolve(argv[++i])
        break
      default:
        if (argv[i].startsWith("--")) {
          console.error(`unknown option: ${argv[i]}`)
          process.exit(2)
        }
        args.input = argv[i]
    }
  }
  if (!args.input && !args.reparseDir) {
    console.error(
      "usage: export-bench.ts <spec.json|dir> [--repeats N] [--workers a,b,c] [--filter str] [--no-build] [--out dir] [--scratch dir]",
    )
    process.exit(2)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// --- harness binary -------------------------------------------------------

const isWin = process.platform === "win32"
const srcTauri = resolve(scriptDir, "../../apps/desktop/src-tauri")
// RF_HARNESS points at a binary built with a custom CARGO_TARGET_DIR (e.g.
// when the repo drive lacks space for a release target).
const harnessExe =
  process.env.RF_HARNESS ??
  join(srcTauri, "target", "release", isWin ? "export_harness.exe" : "export_harness")

// Reparse mode reports from existing logs — no binary or specs needed.
if (!args.reparseDir && !existsSync(harnessExe)) {
  if (args.noBuild) {
    console.error(`harness binary missing and --no-build passed: ${harnessExe}`)
    process.exit(1)
  }
  console.log("building export_harness (release, one-time cost)…")
  const build = spawnSync(
    "cargo",
    ["build", "--release", "--features", "export-harness", "--bin", "export_harness"],
    { cwd: srcTauri, stdio: "inherit" },
  )
  if (build.status !== 0) process.exit(build.status ?? 1)
}

// --- spec collection --------------------------------------------------------

const inputPath = args.reparseDir ?? resolve(args.input)
const specPaths: string[] = []
if (!args.reparseDir) {
  if (inputPath.endsWith(".json")) {
    specPaths.push(inputPath)
  } else {
    for (const entry of readdirSync(inputPath)) {
      if (entry.startsWith("spec") && entry.endsWith(".json")) {
        if (args.filter && !entry.includes(args.filter)) continue
        specPaths.push(join(inputPath, entry))
      }
    }
  }
  if (specPaths.length === 0) {
    console.error(`no spec*.json found at ${inputPath}`)
    process.exit(2)
  }
  specPaths.sort()
}
const outDir = args.outDir ?? (inputPath.endsWith(".json") ? join(inputPath, "..") : inputPath)
mkdirSync(outDir, { recursive: true })

// --- log parsing -------------------------------------------------------------

interface PlateFeed {
  frames?: number
  workers?: number
  zeroFrames?: number
  bytesMib?: number
  rasterMs?: number
  cursorMs?: number
  itemsMs?: number
  keysMs?: number
  packMs?: number
  starvedMs?: number
  writeMs?: number
}

interface FfmpegPass {
  stage?: string
  elapsedMs?: number
  feedMs?: number
  ffmpegSpeed?: string
}

interface RunMetrics {
  spec: string
  label: string
  wallMs: number
  exitCode: number
  chunks?: number
  workers?: number
  totalFrames?: number
  chunkElapsedMs: number[]
  plateFeeds: PlateFeed[]
  passes: FfmpegPass[]
  muxMs?: number
  compositionMs?: number
  validateMs?: number
  retryMs?: number
}

/** tracing fmt renders `message field=value`; capture pairs after the label. */
function parseFields(rest: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const match of rest.matchAll(/([a-zA-Z_]+)=("[^"]*"|[^\s]+)/g)) {
    fields.set(match[1], match[2].replace(/^"|"$/g, ""))
  }
  return fields
}

function num(fields: Map<string, string>, key: string): number | undefined {
  const value = fields.get(key)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseLog(stderr: string): Omit<RunMetrics, "spec" | "label" | "wallMs" | "exitCode"> {
  const metrics: Omit<RunMetrics, "spec" | "label" | "wallMs" | "exitCode"> = {
    chunkElapsedMs: [],
    plateFeeds: [],
    passes: [],
  }
  for (const raw of stderr.split(/\r?\n/)) {
    // tracing fmt wraps field names/values in ANSI styles; strip first.
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "")
    const marker = line.indexOf("export: ")
    if (marker < 0) continue
    const rest = line.slice(marker)
    const fields = parseFields(rest)
    if (rest.includes("rendering timeline in parallel chunks")) {
      metrics.chunks = num(fields, "chunks")
      metrics.workers = num(fields, "workers")
      metrics.totalFrames = num(fields, "total_frames")
    } else if (rest.includes("chunk pass finished")) {
      const elapsed = num(fields, "elapsed_ms")
      if (elapsed !== undefined) metrics.chunkElapsedMs.push(elapsed)
    } else if (rest.includes("plate feed finished")) {
      metrics.plateFeeds.push({
        frames: num(fields, "frames"),
        workers: num(fields, "workers"),
        zeroFrames: num(fields, "zero_frames"),
        bytesMib: num(fields, "bytes_mib"),
        rasterMs: num(fields, "raster_ms"),
        cursorMs: num(fields, "cursor_ms"),
        itemsMs: num(fields, "items_ms"),
        keysMs: num(fields, "keys_ms"),
        packMs: num(fields, "pack_ms"),
        starvedMs: num(fields, "starved_ms"),
        writeMs: num(fields, "write_ms"),
      })
    } else if (rest.includes("ffmpeg pass complete")) {
      metrics.passes.push({
        stage: fields.get("stage"),
        elapsedMs: num(fields, "elapsed_ms"),
        feedMs: num(fields, "feed_ms"),
        ffmpegSpeed: fields.get("ffmpeg_speed"),
      })
    } else if (rest.includes("chunked render muxed")) {
      metrics.muxMs = num(fields, "mux_ms")
    } else if (rest.includes("composition finished")) {
      metrics.compositionMs = num(fields, "composition_ms")
    } else if (rest.includes("output validated")) {
      metrics.validateMs = num(fields, "validate_ms")
    } else if (rest.includes("software retry finished")) {
      metrics.retryMs = num(fields, "retry_ms")
    }
  }
  return metrics
}

// --- runs --------------------------------------------------------------------

interface RunConfig {
  label: string
  env: Record<string, string>
}

const results: RunMetrics[] = []
const summaryRows: string[] = []

if (args.reparseDir) {
  // bench-<specName>-<label>.log — the tag may itself contain dashes; the spec
  // name is everything before the last dash group.
  for (const entry of readdirSync(args.reparseDir)) {
    if (!entry.startsWith("bench-") || !entry.endsWith(".log")) continue
    const tag = basename(entry, ".log").slice("bench-".length)
    const spec = tag.replace(/-[^-]+$/, "")
    if (args.filter && !spec.includes(args.filter)) continue
    const label = tag.slice(spec.length + 1)
    const parsed = parseLog(readFileSync(join(args.reparseDir, entry), "utf8"))
    results.push({ spec, label, wallMs: 0, exitCode: 0, ...parsed })
  }
} else {
  for (const specPath of specPaths) {
    const specName = basename(specPath, ".json")
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as { forceSinglePass?: boolean }
    const configs: RunConfig[] = [{ label: "auto", env: {} }]
    if (!spec.forceSinglePass) {
      for (const workers of args.workers) {
        configs.push({
          label: `w${workers}`,
          env: { RECORDFORGE_EXPORT_CHUNK_WORKERS: String(workers) },
        })
      }
    }

    for (const config of configs) {
      for (let repeat = 0; repeat < args.repeats; repeat++) {
        const tag = `${specName}-${config.label}${args.repeats > 1 ? `-r${repeat + 1}` : ""}`
        const logPath = join(outDir, `bench-${tag}.log`)
        // Redirect the final output into scratch: the spec's own outputPath may
        // sit on a disk without room, and per-run outputs stay isolated.
        mkdirSync(args.scratchDir, { recursive: true })
        const runSpec = {
          ...(spec as Record<string, unknown>),
          outputPath: join(args.scratchDir, `render-${tag}.mp4`),
        }
        const runSpecPath = join(args.scratchDir, `spec-${tag}.json`)
        writeFileSync(runSpecPath, JSON.stringify(runSpec))
        process.stdout.write(`running ${tag}… `)
        const started = performance.now()
        const run = spawnSync(harnessExe, [runSpecPath], {
          encoding: "utf8",
          maxBuffer: 128 * 1024 * 1024,
          env: { ...process.env, RUST_LOG: "info", ...config.env },
        })
        const wallMs = performance.now() - started
        writeFileSync(logPath, `${run.stdout ?? ""}${run.stderr ?? ""}`)

        const parsed = parseLog(run.stderr ?? "")
        const metrics: RunMetrics = {
          spec: specName,
          label: config.label,
          wallMs,
          exitCode: run.status ?? -1,
          ...parsed,
        }
        results.push(metrics)
        console.log(
          run.status === 0
            ? `${(wallMs / 1000).toFixed(1)}s wall, compose=${metrics.compositionMs ?? "?"}ms`
            : `FAILED (exit ${run.status}) — see ${logPath}`,
        )
      }
    }
  }
}

// --- report ---------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function sumFeeds(feeds: PlateFeed[]): Required<PlateFeed> {
  return {
    rasterMs: feeds.reduce((sum, feed) => sum + (feed.rasterMs ?? 0), 0),
    cursorMs: feeds.reduce((sum, feed) => sum + (feed.cursorMs ?? 0), 0),
    itemsMs: feeds.reduce((sum, feed) => sum + (feed.itemsMs ?? 0), 0),
    keysMs: feeds.reduce((sum, feed) => sum + (feed.keysMs ?? 0), 0),
    packMs: feeds.reduce((sum, feed) => sum + (feed.packMs ?? 0), 0),
    starvedMs: feeds.reduce((sum, feed) => sum + (feed.starvedMs ?? 0), 0),
    writeMs: feeds.reduce((sum, feed) => sum + (feed.writeMs ?? 0), 0),
    bytesMib: feeds.reduce((sum, feed) => sum + (feed.bytesMib ?? 0), 0),
    zeroFrames: feeds.reduce((sum, feed) => sum + (feed.zeroFrames ?? 0), 0),
    frames: feeds.reduce((sum, feed) => sum + (feed.frames ?? 0), 0),
    workers: feeds.reduce((max, feed) => Math.max(max, feed.workers ?? 0), 0),
  }
}

const header =
  "| spec | run | wall s | compose ms | chunks | chunk p50 ms | plate MiB | zero% | raster ms | cursor ms | items ms | keys ms | pack ms | starved ms | write ms | feed ms | ffmpeg speed | mux ms |"
const divider = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
summaryRows.push(header, divider)
results.sort((a, b) => `${a.spec}|${a.label}`.localeCompare(`${b.spec}|${b.label}`))
for (const metrics of results) {
  const feeds = sumFeeds(metrics.plateFeeds)
  const feedMs = metrics.passes.reduce((sum, pass) => sum + (pass.feedMs ?? 0), 0)
  // Median speed of the composition passes — the audio/mux stages (huge
  // values, no plates) would swamp the signal.
  const compSpeeds = metrics.passes
    .filter((pass) => pass.stage?.includes("composition"))
    .map((pass) => Number(pass.ffmpegSpeed))
    .filter((value) => Number.isFinite(value))
  const anySpeeds = metrics.passes
    .map((pass) => Number(pass.ffmpegSpeed))
    .filter((value) => Number.isFinite(value))
  const speedPool = compSpeeds.length > 0 ? compSpeeds : anySpeeds
  const speeds = speedPool.length > 0 ? median(speedPool).toFixed(2) : ""
  const zeroPct =
    feeds.frames && feeds.frames > 0
      ? `${Math.round(((feeds.zeroFrames ?? 0) / feeds.frames) * 100)}`
      : "-"
  summaryRows.push(
    `| ${metrics.spec} | ${metrics.label} | ${metrics.wallMs > 0 ? (metrics.wallMs / 1000).toFixed(1) : "-"} | ` +
      `${metrics.compositionMs ?? "-"} | ${metrics.chunks ?? "-"} | ` +
      `${metrics.chunkElapsedMs.length > 0 ? Math.round(median(metrics.chunkElapsedMs)) : "-"} | ` +
      `${Math.round(feeds.bytesMib)} | ${zeroPct} | ` +
      `${Math.round(feeds.rasterMs)} | ${Math.round(feeds.cursorMs)} | ` +
      `${Math.round(feeds.itemsMs)} | ${Math.round(feeds.keysMs)} | ` +
      `${Math.round(feeds.packMs)} | ${Math.round(feeds.starvedMs)} | ` +
      `${Math.round(feeds.writeMs)} | ${Math.round(feedMs)} | ${speeds ? `${speeds}x` : "-"} | ` +
      `${metrics.muxMs ?? "-"} |`,
  )
}

// --- ablation report --------------------------------------------------------
// spec_abl-<variant>_chunked[_<enc>].json runs measure each feature's marginal
// cost. The baseline is `plain` within the same encoder suffix; radius and
// shadow also diff against `padding` since they build on it.

const ABLATION_ORDER = [
  "plain",
  "padding",
  "radius",
  "shadow",
  "zoom",
  "cursor",
  "items",
  "captions",
  "camera",
]

function ablationKey(spec: string): { variant: string; enc: string } | undefined {
  const match = /^spec_abl-([a-z]+)_chunked(?:_([a-z0-9]+))?$/.exec(spec)
  if (!match) return undefined
  return { variant: match[1], enc: match[2] ?? "" }
}

const ablationWalls = new Map<string, Map<string, number>>()
for (const metrics of results) {
  const key = ablationKey(metrics.spec)
  if (!key || metrics.wallMs <= 0) continue
  const walls = results
    .filter((run) => run.spec === metrics.spec && run.wallMs > 0)
    .map((run) => run.wallMs)
  if (!ablationWalls.has(key.enc)) ablationWalls.set(key.enc, new Map())
  ablationWalls.get(key.enc)?.set(key.variant, median(walls))
}

if (ablationWalls.size > 0) {
  const delta = (wall: number, base: number | undefined): string =>
    base === undefined ? "-" : `${(((wall - base) / base) * 100).toFixed(1)}%`
  summaryRows.push(
    "",
    "| ablation | encoder | wall s (median) | Δ vs plain | Δ vs padding |",
    "|---|---|---|---|---|",
  )
  for (const [enc, walls] of [...ablationWalls.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const plain = walls.get("plain")
    const padding = walls.get("padding")
    const variants = [...walls.keys()].sort(
      (a, b) =>
        (ABLATION_ORDER.indexOf(a) + 1 || ABLATION_ORDER.length) -
        (ABLATION_ORDER.indexOf(b) + 1 || ABLATION_ORDER.length),
    )
    for (const variant of variants) {
      const wall = walls.get(variant) ?? 0
      summaryRows.push(
        `| abl-${variant} | ${enc || "software"} | ${(wall / 1000).toFixed(1)} | ` +
          `${variant === "plain" ? "baseline" : delta(wall, plain)} | ` +
          `${variant === "radius" || variant === "shadow" ? delta(wall, padding) : "-"} |`,
      )
    }
  }
}

console.log("\n" + summaryRows.join("\n"))

const resultsPath = join(
  outDir,
  `bench-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
)
writeFileSync(
  resultsPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), runs: results }, null, 1),
)
console.log(`\nresults: ${resultsPath}`)
console.log(`logs:    ${outDir}/bench-*.log`)
