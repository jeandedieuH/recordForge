// Generates packages/cursor-engine/assets.json from the shared TypeScript manifest.
// Run from packages/cursor-core with: bun scripts/generate-assets.ts

import { writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CURSOR_ASSET_MANIFEST } from "../src/assets"

const __dirname = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(__dirname, "../../cursor-engine/assets.json")
const json = JSON.stringify(CURSOR_ASSET_MANIFEST, null, 2)
writeFileSync(outputPath, `${json}\n`)
console.log(`Wrote ${outputPath}`)
