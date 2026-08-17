import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const engineDir = resolve(__dirname, "../../overlay-engine")
const outDir = resolve(__dirname, "../wasm")

execFileSync("wasm-pack", ["build", "--target", "web", "--out-dir", outDir], {
  cwd: engineDir,
  stdio: "inherit",
})

// wasm-pack generates a local .gitignore that would hide the tracked wrapper artifacts.
const generatedGitignore = resolve(outDir, ".gitignore")
if (existsSync(generatedGitignore)) rmSync(generatedGitignore)

console.log("WASM overlay engine built.")
