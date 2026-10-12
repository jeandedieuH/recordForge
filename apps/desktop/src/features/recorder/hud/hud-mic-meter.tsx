import { useRef } from "react"
import { Mic } from "lucide-react"
import { AudioLevelMeter } from "@recordforge/ui"
import { useAudioLevelStore } from "./audio-level-store"
import { peakToLevel, smoothMeterLevel } from "../camera/use-mic-level"

interface HudMicMeterProps {
  /** status.microphoneActive && status.state === "recording" — the meter only
      exists while a live mic is being captured. */
  visible: boolean
}

// Compact live mic meter for the floating HUD. Subscribes to the narrow mic
// slice of the audio-level store so 12 Hz events don't re-render the whole
// toolbar — the smoothing keeps a ref, not state.
export function HudMicMeter({ visible }: HudMicMeterProps) {
  const microphone = useAudioLevelStore((state) => state.microphone)
  const smoothed = useRef(0)

  const level = visible && microphone != null ? peakToLevel(microphone) : 0
  smoothed.current = smoothMeterLevel(smoothed.current, level)

  if (!visible) return null
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      aria-label="Microphone level"
      role="img"
      title="Microphone level"
    >
      <Mic className="size-3 text-muted-foreground" aria-hidden />
      <AudioLevelMeter level={smoothed.current} segments={8} className="h-1.5 w-12 rounded" />
    </span>
  )
}
