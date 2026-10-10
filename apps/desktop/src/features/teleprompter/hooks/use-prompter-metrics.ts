import { useLayoutEffect, useState } from "react"

export interface PrompterMetrics {
  viewportHeight: number
  /** Height of the rendered text block — drives wpm -> px/s conversion. */
  textHeight: number
}

export function usePrompterMetrics(
  viewportEl: HTMLElement | null,
  textEl: HTMLElement | null,
): PrompterMetrics {
  const [metrics, setMetrics] = useState<PrompterMetrics>({
    viewportHeight: 0,
    textHeight: 0,
  })

  // Layout effect: spacers must be correct before first paint, otherwise the
  // prompt flashes with zero offsets for a frame.
  useLayoutEffect(() => {
    const measure = () => {
      const next = {
        viewportHeight: viewportEl?.clientHeight ?? 0,
        textHeight: textEl?.offsetHeight ?? 0,
      }
      setMetrics((prev) =>
        prev.viewportHeight === next.viewportHeight && prev.textHeight === next.textHeight
          ? prev
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (viewportEl) observer.observe(viewportEl)
    if (textEl) observer.observe(textEl)
    return () => observer.disconnect()
  }, [viewportEl, textEl])

  return metrics
}
