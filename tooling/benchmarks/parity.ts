/**
 * Export parity gate: compares candidate renders against reference renders
 * with index-paired per-frame PSNR (timestamps are unreliable for pairing —
 * see testing-recordforge-export), exact frame counts, and audio
 * presence/duration. Use it to guard export-pipeline changes behind stored
 * baseline renders.
 *
 *   bun run tooling/benchmarks/parity.ts <reference> <candidate> [--mean 50] [--min 45] [--fps N]
 *
 * Both args are files, or both are directories — directory mode compares
 * every `render_*.mp4` present in either directory by file name (a file
 * missing on one side is a failure). Exits 1 on any failed pair, 0 when
 * every pair passes.
 *
 * ffmpeg/ffprobe resolve like export-synth-spec.ts: repo sidecars first,
 * RF_FFMPEG/RF_FFPROBE override.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))

// --- args ------------------------------------------------------------------

interface ParityArgs {
  reference: string
  candidate: string
  mean: number
  min: number
  fps?: number
}

function parseArgs(argv: string[]): ParityArgs {
  const args: ParityArgs = { reference: "", candidate: "", mean: 50, min: 45 }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mean":
        args.mean = Number(argv[++i])
        break
      case "--min":
        args.min = Number(argv[++i])
        break
      case "--fps":
        args.fps = Number(argv[++i])
        break
      default:
        if (argv[i].startsWith("--")) {
          console.error(`unknown option: ${argv[i]}`)
          process.exit(2)
        }
        positional.push(argv[i])
    }
  }
  if (positional.length !== 2 || !Number.isFinite(args.mean) || !Number.isFinite(args.min)) {
    console.error("usage: parity.ts <reference> <candidate> [--mean 50] [--min 45] [--fps N]")
    process.exit(2)
  }
  args.reference = resolve(positional[0])
  args.candidate = resolve(positional[1])
  return args
}

const args = parseArgs(process.argv.slice(2))

// --- ffmpeg/ffprobe ----------------------------------------------------------

const isWin = process.platform === "win32"
const suffix = isWin ? "-x86_64-pc-windows-msvc.exe" : "-x86_64-unknown-linux-gnu"
const binDir = resolve(scriptDir, "../../apps/desktop/src-tauri/binaries")
const ffmpeg = process.env.RF_FFMPEG ?? join(binDir, `ffmpeg${suffix}`)
const ffprobe = process.env.RF_FFPROBE ?? join(binDir, `ffprobe${suffix}`)

function run(binary: string, argv: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(binary, argv, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

interface VideoInfo {
  frames: number
  fps: number
}

interface ContainerInfo {
  hasAudio: boolean
  durationSec: number
}

/** Exact decoded frame count + container fps. */
function probeVideo(path: string): VideoInfo {
  const { status, stdout, stderr } = run(ffprobe, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames,r_frame_rate",
    "-of",
    "json",
    path,
  ])
  if (status !== 0) throw new Error(`ffprobe failed for ${basename(path)}: ${stderr.trim()}`)
  const stream = (JSON.parse(stdout).streams ?? [])[0] ?? {}
  const frames = Number(stream.nb_read_frames)
  const [num, den] = String(stream.r_frame_rate ?? "0/1")
    .split("/")
    .map(Number)
  const fps = den ? num / den : 0
  if (!Number.isFinite(frames) || frames <= 0) {
    throw new Error(`ffprobe returned no decodable frames for ${basename(path)}`)
  }
  return { frames, fps }
}

/** Audio presence + container duration for the audio-parity check. */
function probeContainer(path: string): ContainerInfo {
  const { status, stdout, stderr } = run(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type:format=duration",
    "-of",
    "json",
    path,
  ])
  if (status !== 0) throw new Error(`ffprobe failed for ${basename(path)}: ${stderr.trim()}`)
  const parsed = JSON.parse(stdout)
  const hasAudio = (parsed.streams ?? []).some(
    (stream: { codec_type?: string }) => stream.codec_type === "audio",
  )
  return { hasAudio, durationSec: Number(parsed.format?.duration) || 0 }
}

/** ffmpeg filter-graph escaping for a Windows path: forward slashes + `\:` on the drive letter, single-quoted. */
function filterPath(path: string): string {
  return `'${path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''")}'`
}

interface FramePsnr {
  n: number
  db: number
}

/** Parse `n:<i> ... psnr_avg:<dB|inf>` lines; inf maps to the 100 dB cap. */
function parsePsnrStats(text: string): FramePsnr[] {
  const frames: FramePsnr[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /n:(\d+)\s.*psnr_avg:(inf|[0-9.]+)/.exec(line)
    if (!match) continue
    const raw = match[2] === "inf" ? 100 : Number(match[2])
    frames.push({ n: Number(match[1]), db: Math.min(raw, 100) })
  }
  return frames
}

/**
 * Per-frame PSNR pairing candidate to reference strictly by output index:
 * `setpts=N` renumbers both streams on the same timebase so any CFR/VFR or
 * start-offset difference can't shift the pairing.
 */
function measurePsnr(candidate: string, reference: string, fps: number): FramePsnr[] {
  const filter = (stats: string) =>
    `[0:v]settb=1/${fps},setpts=N[c];[1:v]settb=1/${fps},setpts=N[r];[c][r]psnr=stats_file=${stats}`

  // Prefer stats_file=- (stdout on ffmpeg ≥7); fall back to a temp stats file
  // when the pinned build can't open it or emits nothing parseable.
  const direct = run(ffmpeg, [
    "-hide_banner",
    "-i",
    candidate,
    "-i",
    reference,
    "-lavfi",
    filter("-"),
    "-f",
    "null",
    "-",
  ])
  let frames = parsePsnrStats(`${direct.stdout}\n${direct.stderr}`)
  if (frames.length > 0) return frames

  const dir = mkdtempSync(join(tmpdir(), "rf-parity-"))
  try {
    const statsPath = join(dir, "psnr.txt")
    const attempt = run(ffmpeg, [
      "-hide_banner",
      "-i",
      candidate,
      "-i",
      reference,
      "-lavfi",
      filter(filterPath(statsPath)),
      "-f",
      "null",
      "-",
    ])
    frames = existsSync(statsPath) ? parsePsnrStats(readFileSync(statsPath, "utf8")) : []
    if (frames.length === 0) {
      throw new Error(
        `psnr pass produced no stats for ${basename(candidate)}: ${attempt.stderr.trim().slice(-500)}`,
      )
    }
    return frames
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- pairs --------------------------------------------------------------------

interface Pair {
  name: string
  reference: string
  candidate: string
  missing?: boolean
}

function collectPairs(reference: string, candidate: string): Pair[] {
  if (!existsSync(reference) || !existsSync(candidate)) {
    console.error(`path missing: ${!existsSync(reference) ? reference : candidate}`)
    process.exit(2)
  }
  const refIsDir = statSync(reference).isDirectory()
  const candIsDir = statSync(candidate).isDirectory()
  if (refIsDir !== candIsDir) {
    console.error("reference and candidate must both be files or both be directories")
    process.exit(2)
  }
  if (!refIsDir) {
    return [{ name: basename(candidate), reference, candidate }]
  }
  const refFiles = new Set(
    readdirSync(reference).filter((f) => f.startsWith("render_") && f.endsWith(".mp4")),
  )
  const candFiles = new Set(
    readdirSync(candidate).filter((f) => f.startsWith("render_") && f.endsWith(".mp4")),
  )
  const names = [...new Set([...refFiles, ...candFiles])].sort()
  if (names.length === 0) {
    console.error(`no render_*.mp4 files in ${reference} or ${candidate}`)
    process.exit(2)
  }
  return names.map((name) => ({
    name,
    reference: join(reference, name),
    candidate: join(candidate, name),
    missing: !(refFiles.has(name) && candFiles.has(name)),
  }))
}

// --- run ----------------------------------------------------------------------

const pairs = collectPairs(args.reference, args.candidate)
const rows: string[] = [
  "| file | frames | mean dB | min dB | worst frame | audio | result |",
  "|---|---|---|---|---|---|---|",
]
let failed = false

for (const pair of pairs) {
  if (pair.missing) {
    failed = true
    rows.push(`| ${pair.name} | - | - | - | - | - | MISSING |`)
    continue
  }
  try {
    const refVideo = probeVideo(pair.reference)
    const candVideo = probeVideo(pair.candidate)
    const fps = args.fps ?? refVideo.fps
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error("could not determine fps; pass --fps")
    }
    const stats = measurePsnr(pair.candidate, pair.reference, fps)
    if (stats.length === 0) throw new Error("psnr pass produced no frames")

    const mean = stats.reduce((sum, frame) => sum + frame.db, 0) / stats.length
    const worst = stats.reduce((a, b) => (b.db < a.db ? b : a))

    const refContainer = probeContainer(pair.reference)
    const candContainer = probeContainer(pair.candidate)
    const audioDeltaMs = Math.abs(refContainer.durationSec - candContainer.durationSec) * 1000

    const problems: string[] = []
    if (candVideo.frames !== refVideo.frames) {
      problems.push(`frames ${candVideo.frames} != ${refVideo.frames}`)
    }
    if (mean < args.mean) problems.push(`mean ${mean.toFixed(2)} < ${args.mean}`)
    if (worst.db < args.min) problems.push(`min ${worst.db.toFixed(2)} < ${args.min}`)
    if (refContainer.hasAudio !== candContainer.hasAudio) {
      problems.push("audio presence differs")
    }
    if (audioDeltaMs > 50) problems.push(`audio duration Δ${audioDeltaMs.toFixed(0)}ms > 50ms`)

    const audio = `${refContainer.hasAudio ? "yes" : "no"}/${candContainer.hasAudio ? "yes" : "no"} Δ${audioDeltaMs.toFixed(0)}ms`
    if (problems.length > 0) {
      failed = true
      rows.push(
        `| ${pair.name} | ${candVideo.frames}/${refVideo.frames} | ${mean.toFixed(2)} | ` +
          `${worst.db.toFixed(2)} | ${worst.n} | ${audio} | FAIL: ${problems.join("; ")} |`,
      )
    } else {
      rows.push(
        `| ${pair.name} | ${candVideo.frames} | ${mean.toFixed(2)} | ` +
          `${worst.db.toFixed(2)} | ${worst.n} | ${audio} | PASS |`,
      )
    }
  } catch (error) {
    failed = true
    rows.push(`| ${pair.name} | - | - | - | - | - | ERROR: ${String(error).slice(0, 160)} |`)
  }
}

console.log(`\nparity: ${args.candidate} vs ${args.reference}`)
console.log(rows.join("\n"))
console.log(
  failed
    ? "\nparity FAILED"
    : `\nparity OK — ${pairs.length} pair(s), mean ≥ ${args.mean} dB, min ≥ ${args.min} dB`,
)
process.exit(failed ? 1 : 0)
