// Generates all Tauri bundle icons from the branding master SVG.
//
//   bun run --cwd tooling/scripts icons
//
// Steps: rasterize branding/forge-mark.svg → 1024px PNG (sharp), then hand off
// to `tauri icon` which emits the full icon set into apps/desktop/src-tauri/icons.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const masterSource = existsSync(join(root, "branding", "icon.svg"))
  ? join(root, "branding", "icon.svg")
  : join(root, "branding", "forge-mark.svg")
const stagingDir = join(root, "tooling", "scripts", ".icon-staging")
const masterPng = join(stagingDir, "app-icon-1024.png")
const iconsDir = join(root, "apps", "desktop", "src-tauri", "icons")

mkdirSync(stagingDir, { recursive: true })

await sharp(masterSource, { density: 384 })
  .resize(1024, 1024)
  .png()
  .toFile(masterPng)

console.log(`rasterized ${masterSource} → ${masterPng}`)

// `tauri icon` regenerates every required size (PNG/ICO/ICNS) from one source.
const result = spawnSync("bunx", ["tauri", "icon", masterPng, "-o", iconsDir], {
  cwd: join(root, "apps", "desktop"),
  stdio: "inherit",
  shell: true,
})

rmSync(stagingDir, { recursive: true, force: true })

if (result.status !== 0) {
  console.error("tauri icon failed")
  process.exit(result.status ?? 1)
}

console.log(`icons written to ${iconsDir}`)
