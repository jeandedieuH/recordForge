// Renders every cursor asset to an HTML contact sheet for visual review.
// Run from packages/cursor-core with: bun scripts/preview-cursors.ts [out.html]
// Then screenshot with a headless browser to inspect the rasterized result.

import { writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CURSOR_ASSET_MANIFEST, SHAPE_ID_TO_ASSET, renderCursorAssetSvg } from "../src/assets"

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(process.argv[2] ?? resolve(__dirname, "../../../cursor-sheet.html"))

interface StylePreset {
  name: string
  fill: string
  stroke: string
  strokeWidth: number
  bg: string
}

const STYLES: StylePreset[] = [
  // Classic product defaults (blue fill / white outline) on light + dark.
  { name: "blue/light", fill: "#3b82f6", stroke: "#ffffff", strokeWidth: 2, bg: "#f4f4f5" },
  { name: "blue/dark", fill: "#3b82f6", stroke: "#ffffff", strokeWidth: 2, bg: "#18181b" },
  // Recommended dpi-model style (white fill / dark outline) on light + dark.
  { name: "mono/light", fill: "#ffffff", stroke: "#111111", strokeWidth: 1.5, bg: "#f4f4f5" },
  { name: "mono/dark", fill: "#ffffff", stroke: "#111111", strokeWidth: 1.5, bg: "#18181b" },
]

const SIZES = [24, 48, 96]

const assets = Object.values(CURSOR_ASSET_MANIFEST)

const cells = assets
  .map((asset) => {
    const cols = STYLES.map((style) => {
      const sizes = SIZES.map((size) => {
        const markup = renderCursorAssetSvg(asset, {
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
        })
        return `<svg width="${size}" height="${size}" viewBox="${asset.viewBox}" style="margin: 2px 6px">${markup}</svg>`
      }).join("")
      return `<div class="cell" style="background:${style.bg}">${sizes}</div>`
    })
    return `<tr><td class="label">${asset.id}</td>${cols.map((c) => `<td>${c}</td>`).join("")}</tr>`
  })
  .join("\n")

const kinds = Object.entries(SHAPE_ID_TO_ASSET)
  .map(([kind, id]) => `<span class="kind">${kind} → ${id}</span>`)
  .join("")

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Cursor sheet</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 16px; background: #fff }
  table { border-collapse: collapse }
  td { padding: 4px; border: 1px solid #ddd; vertical-align: middle }
  td.label { font-size: 11px; max-width: 180px }
  .cell { display: flex; align-items: flex-end; padding: 4px }
  .kind { display: inline-block; font-size: 10px; margin: 2px 8px 2px 0 }
  h2 { font-size: 13px }
</style></head><body>
<h2>Cursor assets — sizes ${SIZES.join("/")}px, styles left→right: ${STYLES.map((s) => s.name).join(", ")}</h2>
<table><tr><th>asset</th>${STYLES.map((s) => `<th>${s.name}</th>`).join("")}</tr>
${cells}
</table>
<h2>Kind → asset map</h2>
<div>${kinds}</div>
</body></html>`

writeFileSync(outPath, html)
console.log(`Wrote ${outPath}`)
