// Generates packages/cursor-engine/assets.json from the shared TypeScript manifest.
// Run from packages/cursor-core with: bun scripts/generate-assets.ts

import { writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CURSOR_ASSET_MANIFEST, SHAPE_ID_TO_ASSET } from "../src/assets"

const __dirname = dirname(fileURLToPath(import.meta.url))
const assetsPath = resolve(__dirname, "../../cursor-engine/assets.json")
const shapeMapPath = resolve(__dirname, "../../cursor-engine/shape-map.json")

const assetsJson = JSON.stringify(CURSOR_ASSET_MANIFEST, null, 2)
writeFileSync(assetsPath, `${assetsJson}\n`)
console.log(`Wrote ${assetsPath}`)

const shapeMapJson = JSON.stringify(SHAPE_ID_TO_ASSET, null, 2)
writeFileSync(shapeMapPath, `${shapeMapJson}\n`)
console.log(`Wrote ${shapeMapPath}`)
