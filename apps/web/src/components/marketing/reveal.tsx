import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@recordforge/ui"

interface RevealProps {
  children: ReactNode
  /** Stagger delay in ms before the transition starts. */
  delay?: number
  className?: string
}

/**
 * Scroll-entry reveal — slides/fades children in once they enter the viewport.
 * Transform + opacity only (GPU-safe); the theme's reduced-motion media query
 * collapses the transition for users who opt out.
 */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node || visible) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible])

  return (
    <div
      ref={ref}
      className={cn(
        "transition-[opacity,transform,filter] duration-700 ease-forge",
        visible ? "translate-y-0 opacity-100 blur-0" : "translate-y-8 opacity-0 blur-[2px]",
        className,
      )}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  )
}
