import { ChevronDown, Timer } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@recordforge/ui"
import { useRecorderStore } from "../../../hooks/use-recorder"

const COUNTDOWN_OPTIONS = [
  { value: "0", label: "No delay — start instantly" },
  { value: "3", label: "3 seconds" },
  { value: "5", label: "5 seconds" },
] as const

// Inline start-delay control. The same setting used to live only in Settings,
// so changing the countdown before a take meant leaving the flow entirely.
export function CountdownChip() {
  const countdownSeconds = useRecorderStore((state) => state.countdownSeconds)
  const setCountdownSeconds = useRecorderStore((state) => state.setCountdownSeconds)
  const label = countdownSeconds === 0 ? "No delay" : `${countdownSeconds}s delay`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Start delay: ${label}`}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-dim px-2.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-colors duration-fast hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
        >
          <Timer className="size-3.5" aria-hidden />
          <span>{label}</span>
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Start delay</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(countdownSeconds)}
          onValueChange={(value) => void setCountdownSeconds(Number(value))}
        >
          {COUNTDOWN_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
