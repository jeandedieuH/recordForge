import { useRef } from "react"
import { Crop, Monitor, MonitorUp, Video } from "lucide-react"

export type SourceMode = "screen" | "window" | "region" | "camera"

interface SourceModeSwitcherProps {
  value: SourceMode
  onChange: (mode: SourceMode) => void
}

interface ModeOption {
  id: SourceMode
  label: string
  subtitle: string
  icon: typeof Monitor
}

const MODES: ModeOption[] = [
  { id: "screen", label: "Entire Screen", subtitle: "Whole display", icon: Monitor },
  { id: "window", label: "Window", subtitle: "One app window", icon: MonitorUp },
  { id: "region", label: "Region", subtitle: "Custom area", icon: Crop },
  { id: "camera", label: "Camera", subtitle: "Webcam + mic", icon: Video },
]

// Top-level capture-source radiogroup: 4 equal cards, roving tabindex,
// arrow-key navigation between options, Space/Enter selects.
export function SourceModeSwitcher({ value, onChange }: SourceModeSwitcherProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  function focusOption(index: number) {
    const clamped = (index + MODES.length) % MODES.length
    refs.current[clamped]?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault()
      focusOption(index + 1)
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault()
      focusOption(index - 1)
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      onChange(MODES[index].id)
    }
  }

  return (
    <div role="radiogroup" aria-label="Capture source" className="grid grid-cols-4 gap-2.5">
      {MODES.map((mode, index) => {
        const selected = value === mode.id
        return (
          <button
            key={mode.id}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(mode.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border p-3 transition-all duration-base cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              selected
                ? "border-primary bg-primary/15 text-foreground shadow-sm"
                : "border-border bg-surface-dim text-muted-foreground hover:border-border-strong hover:text-foreground"
            }`}
          >
            <mode.icon className="size-5" aria-hidden />
            <span className="text-xs font-medium">{mode.label}</span>
            <span className="text-[10px] text-subtle-foreground">{mode.subtitle}</span>
          </button>
        )
      })}
    </div>
  )
}
