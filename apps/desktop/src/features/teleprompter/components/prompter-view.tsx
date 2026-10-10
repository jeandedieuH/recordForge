import type { CSSProperties } from "react"
import { PencilLine, ScrollText } from "lucide-react"
import { Button, EmptyState } from "@recordforge/ui"
import { READING_LINE_RATIO } from "../lib/teleprompter-math"

interface PrompterViewProps {
  notes: string
  fontSize: number
  mirror: boolean
  viewportHeight: number
  onViewportRef: (el: HTMLDivElement | null) => void
  onTextRef: (el: HTMLDivElement | null) => void
  onTogglePlay: () => void
  onEdit: () => void
}

/**
 * Read-only prompting surface: the single scroll container has no scrollbar,
 * the first line rests on the reading line via spacer offsets, and a masked
 * gradient keeps attention on the highlighted reading band.
 */
export function PrompterView({
  notes,
  fontSize,
  mirror,
  viewportHeight,
  onViewportRef,
  onTextRef,
  onTogglePlay,
  onEdit,
}: PrompterViewProps) {
  const lineHeightPx = fontSize * 1.5
  const readingLineY = viewportHeight * READING_LINE_RATIO
  const topSpacer = readingLineY
  const bottomSpacer = Math.max(0, viewportHeight - readingLineY - lineHeightPx)

  if (notes.trim() === "") {
    return (
      <EmptyState
        icon={ScrollText}
        title="No script yet"
        description="Add your script to start prompting."
        action={
          <Button size="sm" onClick={onEdit}>
            <PencilLine aria-hidden />
            Add your script
          </Button>
        }
        className="m-4 h-[calc(100%-2rem)] py-6"
      />
    )
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={onViewportRef}
        data-testid="prompter-viewport"
        onClick={onTogglePlay}
        className="teleprompter-viewport h-full cursor-pointer overflow-y-auto"
        style={{ "--tp-reading-line": `${READING_LINE_RATIO * 100}%` } as CSSProperties}
      >
        <div aria-hidden style={{ height: topSpacer }} />
        <div
          ref={onTextRef}
          data-testid="prompter-text"
          className="teleprompter-text px-8"
          style={{ fontSize, transform: mirror ? "scaleX(-1)" : undefined }}
        >
          {notes}
        </div>
        <div
          aria-hidden
          className="mt-8 flex items-center justify-center gap-3 text-xs font-medium tracking-wide text-subtle-foreground"
        >
          <span className="h-px w-8 bg-border-strong" />
          End of script
          <span className="h-px w-8 bg-border-strong" />
        </div>
        <div aria-hidden style={{ height: bottomSpacer }} />
      </div>

      {/* Reading guide — the band the current line scrolls through. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0"
        style={{ top: readingLineY, height: lineHeightPx }}
      >
        <div className="h-full w-full bg-foreground/5" />
        <div className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
      </div>
    </div>
  )
}
