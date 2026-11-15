/**
 * Golden-frame parity check for real exported MP4s.
 *
 * Extracts deterministic frames from a rendered export and compares them with
 * checked-in golden PNGs using FFmpeg's PSNR + SSIM filters. This is the final
 * proof that a renderer/graph change still produces the expected pixels — the
 * Rust render-smoke tests only prove "something was drawn".
 *
 *   # Create/refresh goldens after reviewing a known-good render:
 *   bun run tooling/benchmarks/golden-frames.ts <render.mp4> <goldenDir> --update
 *
 *   # Verify a candidate render against the stored goldens:
 *   bun run tooling/benchmarks/golden-frames.ts <render.mp4> <goldenDir>
 *
 * Options:
 *   --times 500,1500,2500,3500  frame timestamps in ms (default includes the tail)
 *   --update                 write the extracted frames as goldens
 *   --min-psnr 35            per-frame PSNR floor (dB)
 *   --min-ssim 0.98          per-frame SSIM floor
 *
 * Goldens are PNGs named `<ms>.png`. Missing goldens fail the check (run
 * --update deliberately); the comparison never regenerates silently.
 *
 * ffmpeg/ffprobe resolve like parity.ts: repo sidecars first, RF_FFMPEG/RF_FFPROBE.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const scriptDir = dirname(fileURLToPath(import.meta.url))

interface Args {
  render: string
  goldenDir: string
  times: number[]
  update: boolean
  minPsnr: number
  minSsim: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    render: "",
    goldenDir: "",
    times: [500, 1_500, 2_500, 3_500],
    update: false,
    minPsnr: 35,
    minSsim: 0.98,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--times":
        args.times = (argv[++i] ?? "")
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value) && value >= 0)
        break
      case "--update":
        args.update = true
        break
      case "--min-psnr":
        args.minPsnr = Number(argv[++i])
        break
      case "--min-ssim":
        args.minSsim = Number(argv[++i])
        break
      default:
        if (argv[i].startsWith("--")) {
          console.error(`unknown option: ${argv[i]}`)
          process.exit(2)
        }
        positional.push(argv[i])
    }
  }
  if (positional.length !== 2 || args.times.length === 0) {
    console.error(
      "usage: golden-frames.ts <render.mp4> <goldenDir> [--times 500,1500,2500,3500] [--update] [--min-psnr 35] [--min-ssim 0.98]",
    )
    process.exit(2)
  }
  args.render = resolve(positional[0])
  args.goldenDir = resolve(positional[1])
  return args
}

const args = parseArgs(process.argv.slice(2))

const isWin = process.platform === "win32"
const suffix = isWin ? "-x86_64-pc-windows-msvc.exe" : "-x86_64-unknown-linux-gnu"
const binDir = resolve(scriptDir, "../../apps/desktop/src-tauri/binaries")
const ffmpeg = process.env.RF_FFMPEG ?? join(binDir, `ffmpeg${suffix}`)

function run(binary: string, argv: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(binary, argv, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function extractFrame(timeMs: number, outputPath: string): void {
  const result = run(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-ss",
    (timeMs / 1000).toFixed(3),
    "-i",
    args.render,
    "-frames:v",
    "1",
    outputPath,
  ])
  if (result.status !== 0 || !existsSync(outputPath)) {
    throw new Error(`could not extract frame at ${timeMs}ms: ${result.stderr.trim()}`)
  }
}

interface Similarity {
  psnr: number
  ssim: number
}

function metric(reference: string, candidate: string, filter: "psnr" | "ssim"): string {
  const result = run(ffmpeg, [
    "-v",
    "info",
    "-i",
    candidate,
    "-i",
    reference,
    "-lavfi",
    `[0:v][1:v]${filter}`,
    "-f",
    "null",
    "-",
  ])
  if (result.status !== 0) {
    throw new Error(`ffmpeg ${filter} comparison failed: ${result.stderr.trim()}`)
  }
  return result.stderr
}

function compareFrames(reference: string, candidate: string): Similarity {
  const psnrOutput = metric(reference, candidate, "psnr")
  const ssimOutput = metric(reference, candidate, "ssim")
  const psnrMatch = /average:([\d.]+|inf)/i.exec(psnrOutput)
  const ssimMatch = /All:([\d.]+)/i.exec(ssimOutput)
  if (!psnrMatch?.[1] || !ssimMatch?.[1]) {
    throw new Error(`could not parse PSNR/SSIM from:\n${psnrOutput}\n${ssimOutput}`)
  }
  return {
    psnr: psnrMatch[1].toLowerCase() === "inf" ? Number.POSITIVE_INFINITY : Number(psnrMatch[1]),
    ssim: Number(ssimMatch[1]),
  }
}

if (!existsSync(args.render)) {
  console.error(`render not found: ${args.render}`)
  process.exit(2)
}
if (!existsSync(ffmpeg)) {
  console.error(`ffmpeg not found: ${ffmpeg} (run bun run setup:ffmpeg or set RF_FFMPEG)`)
  process.exit(2)
}

mkdirSync(args.goldenDir, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), "rf-golden-"))
let failures = 0

try {
  console.log(`golden frames: ${basename(args.render)} → ${args.goldenDir}`)
  for (const timeMs of args.times) {
    const goldenPath = join(args.goldenDir, `${timeMs}.png`)
    const framePath = join(scratch, `${timeMs}.png`)

    if (args.update) {
      extractFrame(timeMs, goldenPath)
      console.log(`  ${timeMs}ms  updated ${statSync(goldenPath).size} bytes`)
      continue
    }

    if (!existsSync(goldenPath)) {
      console.error(`  ${timeMs}ms  MISSING golden ${goldenPath} (run --update once)`)
      failures += 1
      continue
    }

    extractFrame(timeMs, framePath)
    const score = compareFrames(goldenPath, framePath)
    const psnrOk = score.psnr >= args.minPsnr
    const ssimOk = score.ssim >= args.minSsim
    console.log(
      `  ${timeMs}ms  PSNR ${score.psnr.toFixed(2)} dB  SSIM ${score.ssim.toFixed(4)}  ${
        psnrOk && ssimOk ? "PASS" : "FAIL"
      }`,
    )
    if (!psnrOk || !ssimOk) failures += 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  failures += 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} golden frame(s) failed`)
  process.exit(1)
}
console.log(args.update ? "\ngoldens updated" : "\nall golden frames passed")
