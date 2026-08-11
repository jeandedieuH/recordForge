import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const engineDir = resolve(__dirname, "../../cursor-engine")
const outDir = resolve(__dirname, "../wasm")

execFileSync("wasm-pack", ["build", "--target", "web", "--out-dir", outDir], {
  cwd: engineDir,
  stdio: "inherit",
})

// wasm-pack generates a local .gitignore that hides the built artifacts; remove
// it so the files can be tracked/used by the workspace.
const generatedGitignore = resolve(outDir, ".gitignore")
if (existsSync(generatedGitignore)) {
  rmSync(generatedGitignore)
}

console.log("WASM cursor engine built.")
