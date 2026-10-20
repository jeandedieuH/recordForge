import type { KeystrokeDisplayRow } from "@recordforge/editor-core"

interface KeystrokeBadgeProps {
  row: KeystrokeDisplayRow
  /** Canvas px → rendered px scale (frame width / canvas width). */
  scale: number
}

/**
 * One keycap row in the preview stack. The row's `svg` is the same string the
 * Rust export rasterizer builds (locked by the keystroke-layouts.json fixture),
 * so the DOM render is pixel-identical to the burned-in output.
 *
 * Transform math mirrors the export's scale-around-center: translate the row
 * box center to its canvas position, scale about it, then place the artwork
 * back at its own origin — `transform-origin: 0 0` keeps the svg's natural
 * size anchored at the compose origin.
 */
export function KeystrokeBadge({ row, scale }: KeystrokeBadgeProps) {
  const w = row.widthPx
  const h = row.heightPx
  return (
    <div
      className="absolute left-0 top-0"
      style={{
        width: 0,
        height: 0,
        transform: `translate(${(row.x + w / 2) * scale}px, ${(row.y + h / 2) * scale}px) scale(${
          scale * row.scale
        }) translate(${-w / 2}px, ${-h / 2}px)`,
        transformOrigin: "0 0",
        opacity: row.alpha,
        willChange: "transform, opacity",
      }}
      dangerouslySetInnerHTML={{ __html: row.svg }}
    />
  )
}
