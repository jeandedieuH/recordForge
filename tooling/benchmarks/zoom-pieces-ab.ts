// A/B the piecewise zoom graph on a plate-free spec: identical binary, env
// toggle only, N alternating runs each way.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const harness = process.argv[2] ?? "C:\\Users\\hagen\\AppData\\Local\\Temp\\harness-final.exe"
const specPath = process.argv[3] ?? "tooling/benchmarks/out/p2p3-synth/spec_abl-zoom_chunked.json"
const reps = Number(process.argv[4] ?? 3)
const scratch = resolve("C:\\Users\\hagen\\AppData\\Local\\Temp\\rf-zoom-ab")
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const spec = JSON.parse(readFileSync(specPath, "utf8"))
const run = (pieces: boolean) => {
  const out = join(scratch, pieces ? "pieces-on.mp4" : "pieces-off.mp4")
  const runSpec = join(scratch, `spec-${pieces ? "on" : "off"}.json`)
  writeFileSync(runSpec, JSON.stringify({ ...spec, outputPath: out }))
  const env: Record<string, string | undefined> = { ...process.env, RUST_LOG: "info" }
  if (!pieces) env.RECORDFORGE_EXPORT_ZOOM_PIECES = "0"
  const started = performance.now()
  const result = spawnSync(harness, [runSpec], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  })
  const wall = performance.now() - started
  const match = /composition_ms=(\d+)/.exec(`${result.stdout}${result.stderr}`)
  return { wall, compose: match ? Number(match[1]) : NaN, code: result.status }
}

const rows: Array<{ mode: string; rep: number; wall: number; compose: number }> = []
for (let rep = 0; rep < reps; rep++) {
  for (const pieces of [true, false]) {
    const { wall, compose, code } = run(pieces)
    if (code !== 0) console.log(`FAILED mode=${pieces ? "on" : "off"} exit=${code}`)
    rows.push({ mode: pieces ? "on" : "off", rep, wall, compose })
  }
}
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
for (const mode of ["on", "off"]) {
  const set = rows.filter((row) => row.mode === mode)
  console.log(
    `${mode.padEnd(3)} wall ${set.map((r) => (r.wall / 1000).toFixed(1)).join(" ")} median ${(median(set.map((r) => r.wall)) / 1000).toFixed(1)}s ` +
      `| compose median ${(median(set.map((r) => r.compose)) / 1000).toFixed(2)}s`,
  )
}
const on = median(rows.filter((r) => r.mode === "on").map((r) => r.wall))
const off = median(rows.filter((r) => r.mode === "off").map((r) => r.wall))
console.log(`piecewise delta ${(((on - off) / off) * 100).toFixed(1)}% (negative is faster)`)
