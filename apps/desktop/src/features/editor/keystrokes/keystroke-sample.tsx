import { useEffect, useRef, useState } from "react"
import type { KeystrokeOverlaySettings, KeystrokePlatform } from "@recordforge/contracts"
import {
  eventCaps,
  keystrokeMetrics,
  keystrokeRowSvg,
  KEYSTROKE_THEMES,
} from "@recordforge/editor-core"

interface KeystrokeSampleProps {
  settings: KeystrokeOverlaySettings
  platform: KeystrokePlatform
}

/** Synthetic combos the sample scene stacks — newest row on top. */
const SAMPLE_ROWS: { key: string; modifiers: ("ctrl" | "alt" | "shift" | "meta")[] }[] = [
  { key: "S", modifiers: ["ctrl", "shift"] },
  { key: "Z", modifiers: ["ctrl"] },
]

/**
 * Live badge sample for the Keys panel. Renders the same row artwork the
 * preview/export produce — via `keystrokeRowSvg` at a real-canvas metric —
 * stacked like the overlay, scaled to fit the panel so the keycaps stay
 * readable (canvas anchoring itself is exercised by the real preview).
 */
export function KeystrokeSample({ settings, platform }: KeystrokeSampleProps) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [frameWidth, setFrameWidth] = useState(0)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new ResizeObserver(([entry]) => {
      setFrameWidth(entry.contentRect.width)
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  const metrics = keystrokeMetrics(1080, settings.scale)
  const theme = KEYSTROKE_THEMES[settings.theme]
  const glyphPlatform = platform === "unknown" ? "windows" : platform

  const rows = SAMPLE_ROWS.slice(0, Math.max(1, Math.min(2, settings.maxStack))).map(
    (combo, index) =>
      keystrokeRowSvg({
        caps: eventCaps(
          { tMs: index * 320, key: combo.key, modifiers: combo.modifiers },
          { platform: glyphPlatform, modifierStyle: settings.modifierStyle },
        ),
        repeat: index === 0 ? 2 : 1,
        metrics,
        theme,
      }),
  )

  // Lay the rows out like the real stack: row 0 (newest) nearest the anchor,
  // each older row one `step` behind — `step` is the pill pitch (svg boxes
  // overlap their shadow bleed), the same stride the display model uses.
  const step = metrics.capHeightPx + metrics.pillPadYPx * 2 + metrics.rowGapPx
  const naturalH = rows[0]!.heightPx + (rows.length - 1) * step
  const naturalW = Math.max(...rows.map((row) => row.widthPx))
  const boxH = (frameWidth * naturalH) / Math.max(naturalW, 1)
  const scale = Math.min(1, frameWidth / Math.max(naturalW, 1))

  return (
    <div
      ref={frameRef}
      className="relative w-full overflow-hidden rounded-lg border border-border bg-surface-dim"
      style={{ height: boxH > 0 ? boxH : 96 }}
      aria-hidden
    >
      {scale > 0 &&
        rows.map((row, index) => {
          const y = naturalH - row.heightPx - index * step
          const x = (naturalW - row.widthPx) / 2
          return (
            <div
              key={index}
              className="absolute left-0 top-0"
              style={{
                transform: `translate(${(x + row.widthPx / 2) * scale}px, ${
                  (y + row.heightPx / 2) * scale
                }px) scale(${scale}) translate(${-row.widthPx / 2}px, ${-row.heightPx / 2}px)`,
                transformOrigin: "0 0",
                // Older rows read as history, same as the overlay's stack.
                opacity: index === 0 ? 1 : 0.72,
              }}
              dangerouslySetInnerHTML={{ __html: row.svg }}
            />
          )
        })}
    </div>
  )
}
