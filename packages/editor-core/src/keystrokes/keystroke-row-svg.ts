import type { KeystrokeCap } from "./keystroke-model"
import { capWidthPx, type KeystrokeMetrics, type KeystrokeThemeSpec } from "./keystroke-geometry"
import keyGlyphs from "./key-glyphs.json"

interface GlyphDef {
  fill: "none" | "fill"
  paths: string[]
}

const GLYPHS = keyGlyphs.glyphs as Record<string, GlyphDef>
const GLYPH_VIEWBOX = 24

export interface KeystrokeRowSpec {
  /** Generated SVG document for the row (pill + keycaps). */
  svg: string
  /** Row footprint in canvas px — the svg viewBox minus shadow padding. */
  widthPx: number
  heightPx: number
}

/** Fixed-precision numbers keep the generated SVG byte-identical to the Rust
 * mirror — the committed layout fixture compares strings, not renders. */
function f(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function escapeText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function capWidth(cap: KeystrokeCap, m: KeystrokeMetrics): number {
  return cap.glyphId ? capWidthPx("glyph", 0, m) : capWidthPx("text", cap.text?.length ?? 1, m)
}

/**
 * Build one combo row as an SVG document. The DOM preview injects the string
 * verbatim; the export rasterizer parses the identical string with resvg, so
 * both surfaces draw the same artwork by construction.
 */
export function keystrokeRowSvg(input: {
  caps: KeystrokeCap[]
  repeat: number
  metrics: KeystrokeMetrics
  theme: KeystrokeThemeSpec
}): KeystrokeRowSpec {
  const { caps, repeat, metrics: m, theme: t } = input

  const capsWidth = caps.reduce((sum, cap) => sum + capWidth(cap, m), 0)
  const countLabel = repeat > 1 ? `×${repeat}` : null
  const countWidth = countLabel ? m.capGapPx + countLabel.length * m.charAdvancePx : 0
  const pillW = m.pillPadXPx * 2 + capsWidth + m.capGapPx * (caps.length - 1) + countWidth
  const pillH = m.pillPadYPx * 2 + m.capHeightPx

  // The viewBox grows by the shadow bleed so the blur never clips.
  const pad = m.shadowBlurPx * 2
  const w = pillW + pad * 2
  const h = pillH + pad * 2
  const pillX = pad
  const pillY = pad
  const capsY = pillY + m.pillPadYPx
  const capCenterY = capsY + m.capHeightPx / 2
  // Optical centering for the mono cap label (baseline ≈ center + 0.35em).
  const textBaselineY = capCenterY + m.fontPx * 0.35

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}">`,
  )
  parts.push(
    `<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${t.capFillTop}" stop-opacity="${f(t.capFillTopOpacity)}"/>` +
      `<stop offset="1" stop-color="${t.capFillBottom}" stop-opacity="${f(t.capFillBottomOpacity)}"/>` +
      `</linearGradient>` +
      `<filter id="ds" x="-30%" y="-30%" width="160%" height="160%">` +
      `<feGaussianBlur stdDeviation="${f(m.shadowBlurPx)}"/>` +
      `</filter></defs>`,
  )
  parts.push(
    `<rect x="${f(pillX)}" y="${f(pillY + m.shadowOffsetYPx)}" width="${f(pillW)}" height="${f(pillH)}" rx="${f(m.pillRadiusPx)}" fill="${t.shadowColor}" opacity="${f(t.shadowOpacity)}" filter="url(#ds)"/>`,
  )
  parts.push(
    `<rect x="${f(pillX)}" y="${f(pillY)}" width="${f(pillW)}" height="${f(pillH)}" rx="${f(m.pillRadiusPx)}" fill="${t.pillFill}" fill-opacity="${f(t.pillOpacity)}" stroke="${t.pillStroke}" stroke-opacity="${f(t.pillStrokeOpacity)}"/>`,
  )

  let capX = pillX + m.pillPadXPx
  for (const cap of caps) {
    const w = capWidth(cap, m)
    parts.push(
      `<rect x="${f(capX)}" y="${f(capsY)}" width="${f(w)}" height="${f(m.capHeightPx)}" rx="${f(m.capRadiusPx)}" fill="url(#cg)" stroke="${t.capStroke}" stroke-opacity="${f(t.capStrokeOpacity)}"/>`,
    )
    // Key-edge highlight — a thin top sliver inside the cap.
    parts.push(
      `<rect x="${f(capX + 1)}" y="${f(capsY + 1)}" width="${f(w - 2)}" height="${f(Math.max(1, m.capHeightPx * 0.18))}" rx="${f(Math.max(1, m.capRadiusPx * 0.5))}" fill="${t.capHighlight}" opacity="${f(t.capHighlightOpacity)}"/>`,
    )
    if (cap.glyphId) {
      const glyph = GLYPHS[cap.glyphId]
      if (glyph) {
        const scale = m.glyphBoxPx / GLYPH_VIEWBOX
        const gx = capX + (w - m.glyphBoxPx) / 2
        const gy = capCenterY - m.glyphBoxPx / 2
        const paint =
          glyph.fill === "fill"
            ? `fill="${t.text}" opacity="${f(t.textOpacity)}" stroke="none"`
            : `fill="none" stroke="${t.text}" stroke-opacity="${f(t.textOpacity)}" stroke-width="${keyGlyphs.strokeWidth}" stroke-linecap="${keyGlyphs.strokeLinecap}" stroke-linejoin="${keyGlyphs.strokeLinejoin}"`
        for (const d of glyph.paths) {
          parts.push(
            `<path d="${d}" transform="translate(${f(gx)} ${f(gy)}) scale(${f(scale)})" ${paint}/>`,
          )
        }
      }
    } else if (cap.text) {
      parts.push(
        `<text x="${f(capX + w / 2)}" y="${f(textBaselineY)}" font-family="JetBrains Mono, monospace" font-size="${f(m.fontPx)}" font-weight="600" fill="${t.text}" fill-opacity="${f(t.textOpacity)}" text-anchor="middle">${escapeText(cap.text)}</text>`,
      )
    }
    capX += w + m.capGapPx
  }

  if (countLabel) {
    parts.push(
      `<text x="${f(capX)}" y="${f(textBaselineY)}" font-family="JetBrains Mono, monospace" font-size="${f(m.fontPx * 0.85)}" font-weight="600" fill="${t.countText}" fill-opacity="${f(t.countTextOpacity)}">${escapeText(countLabel)}</text>`,
    )
  }

  parts.push("</svg>")
  return { svg: parts.join(""), widthPx: w, heightPx: h }
}
