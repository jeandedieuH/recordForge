import { useEffect, useMemo, useRef, useState } from "react"
import type { CaptionClip, CaptionLayout, TimelineState } from "@recordforge/contracts"
import {
  activeCaptionPage,
  activeCaptionWordIndex,
  applyCaptionContinuity,
  captionAnimationState,
  resolveCaptionLayout,
  resolveClipDesign,
  SPACELESS_CHAR,
} from "@recordforge/editor-core"

interface CaptionPreviewProps {
  timeline: TimelineState | null
  playheadMs: number
}

/**
 * WYSIWYG caption preview: consumes the SAME `CaptionLayout` the Rust ASS
 * writer renders, so every px value is a pure function of playheadMs —
 * scrubbing is exact (no CSS transitions, matching captionAnimationState).
 * All layout px values are multiplied by `scale = frameWidth / canvas.width`.
 *
 * CSS-parity approximations (documented, never compensated further):
 * - WebkitTextStroke is CENTERED on the glyph edge while ASS \bord draws
 *   outside only, so the declared width is doubled here and `paint-order:
 *   stroke` keeps fill on top; net outside stroke ≈ the ASS value.
 * - ASS shadow is a Gaussian blur σ; CSS text-shadow/box-shadow blur is the
 *   same convention closely enough at these radii.
 */
export function CaptionPreview({ timeline, playheadMs }: CaptionPreviewProps) {
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

  // One resolved layout per active caption clip — muted tracks hide
  // entirely. The export's continuity pass then runs over ALL clips' pages
  // (sorted by startMs, cues ≤120ms apart keep their animation flags instead
  // of blinking) so the preview matches the ASS burn-in — mirrors
  // `toCaptions` in packages/media-core/src/render-plan.ts.
  const entries = useMemo(() => {
    if (!timeline) return []
    const out: { clip: CaptionClip; layout: CaptionLayout }[] = []
    for (const track of timeline.tracks) {
      if (track.kind !== "captions" || track.muted) continue
      for (const clip of track.clips) {
        if (clip.kind === "caption") {
          const design = resolveClipDesign(track, clip)
          const layout = resolveCaptionLayout({
            text: clip.text,
            startMs: clip.startMs,
            endMs: clip.startMs + clip.durationMs,
            words: clip.words,
            design,
            canvas: {
              width: timeline.canvas.width,
              height: timeline.canvas.height,
              aspectRatio: timeline.canvas.aspectRatio,
            },
          })
          out.push({ clip, layout })
        }
      }
    }
    const sortedPages = out
      .flatMap((entry) => entry.layout.pages)
      .sort((a, b) => a.startMs - b.startMs)
    // Returns new objects in the same order; sortedPages aliases each
    // layout's page objects, so the adjusted flags land on the layouts.
    applyCaptionContinuity(sortedPages).forEach((adjusted, i) => {
      sortedPages[i].animateIn = adjusted.animateIn
      sortedPages[i].animateOut = adjusted.animateOut
    })
    return out
  }, [timeline])

  const scale = timeline && timeline.canvas.width > 0 ? frameWidth / timeline.canvas.width : 0

  return (
    <div ref={frameRef} className="pointer-events-none absolute inset-0 z-40" aria-hidden>
      {scale > 0 &&
        timeline &&
        entries.map(({ clip, layout }) => (
          <CaptionCueLayer key={clip.id} layout={layout} scale={scale} playheadMs={playheadMs} />
        ))}
    </div>
  )
}

interface CaptionCueLayerProps {
  layout: CaptionLayout
  scale: number
  playheadMs: number
}

function CaptionCueLayer({ layout, scale, playheadMs }: CaptionCueLayerProps) {
  const page = activeCaptionPage(layout, playheadMs)
  if (!page) return null
  const anim = captionAnimationState(layout, page, playheadMs)
  const activeWord = activeCaptionWordIndex(page, playheadMs)
  const s = scale
  const chip = layout.chip
  const shadow = layout.shadow
  const outline = layout.outline

  const lineStyle: React.CSSProperties = {
    height: layout.lineHeightPx * s,
    lineHeight: `${layout.lineHeightPx * s}px`,
    fontSize: layout.fontPx * s,
    fontWeight: layout.fontWeight,
    letterSpacing: layout.letterSpacingPx * s,
    color: layout.textColor,
    whiteSpace: "nowrap",
    textAlign: "center",
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
    fontSynthesis: "none",
  }
  // Outline looks carry no chip — stroke the glyphs directly. CSS stroke is
  // centered on the glyph edge (ASS is outside-only), so double the declared
  // width and let paint-order keep the fill above the stroke.
  if (outline && !chip) {
    lineStyle.WebkitTextStroke = `${outline.widthPx * s * 2}px ${outline.color}`
    lineStyle.paintOrder = "stroke"
  }
  if (shadow && !chip) {
    lineStyle.textShadow = `0 ${shadow.offsetYPx * s}px ${shadow.blurPx * s}px ${hexToRgba(
      shadow.color,
      shadow.opacity,
    )}`
  }

  return (
    <div
      className="absolute"
      style={{
        left: page.block.centerX * s,
        top: page.block.centerY * s,
        transform: `translate(-50%, -50%) scale(${anim.scale})`,
        opacity: anim.opacity,
      }}
    >
      <div
        style={
          chip
            ? {
                padding: `${chip.padYPx * s}px ${chip.padXPx * s}px`,
                borderRadius: chip.radiusPx * s,
                background: hexToRgba(chip.color, chip.opacity),
                ...(shadow
                  ? {
                      boxShadow: `0 ${shadow.offsetYPx * s}px ${shadow.blurPx * s}px ${hexToRgba(
                        shadow.color,
                        shadow.opacity,
                      )}`,
                    }
                  : {}),
              }
            : undefined
        }
      >
        {page.lines.map((line, lineIndex) => (
          <div key={lineIndex} style={lineStyle}>
            {line.words.length > 0
              ? line.words.map((word, wordIndex) => {
                  const isActive =
                    activeWord !== null &&
                    activeWord.line === lineIndex &&
                    activeWord.word === wordIndex
                  const inactive =
                    !isActive && layout.highlight
                      ? hexToRgba(layout.textColor, layout.highlight.inactiveOpacity)
                      : undefined
                  return (
                    <span key={wordIndex}>
                      {wordIndex > 0 && needsSpace(line.words[wordIndex - 1].text, word.text)
                        ? " "
                        : ""}
                      <span
                        style={{
                          color: isActive
                            ? layout.highlight?.activeColor
                            : (inactive ?? layout.textColor),
                        }}
                      >
                        {word.text}
                      </span>
                    </span>
                  )
                })
              : line.text}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Space joins words except across spaceless-script boundaries (mirrors
 * ass_layout.rs join_words and the SPACELESS_CHAR rule in caption-text.ts). */
function needsSpace(left: string, right: string): boolean {
  const leftEnd = [...left].pop()
  const rightStart = [...right][0]
  return !(
    (leftEnd !== undefined && SPACELESS_CHAR.test(leftEnd)) ||
    (rightStart !== undefined && SPACELESS_CHAR.test(rightStart))
  )
}

function hexToRgba(hex: string, opacity: number): string {
  const value = hex.replace("#", "")
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${opacity})`
}
