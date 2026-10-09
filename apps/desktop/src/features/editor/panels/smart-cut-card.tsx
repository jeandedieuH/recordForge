import { useState } from "react"
import { Scissors } from "lucide-react"
import { createRippleDeleteRangesCommand } from "@recordforge/editor-core"
import type { SilenceRange } from "@recordforge/contracts"
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from "@recordforge/ui"
import { useLicenseStore } from "../../../stores/license-store"
import { useTimelineStore } from "../../../stores/timeline-store"
import { ProBadge } from "../../licensing/pro-badge"
import { detectSilences } from "../../../lib/media"
import { formatDuration } from "../../../lib/format"

const THRESHOLD_OPTIONS = [
  { value: "-30", label: "Quiet speech (−30 dB)" },
  { value: "-35", label: "Balanced (−35 dB)" },
  { value: "-40", label: "Only true silence (−40 dB)" },
] as const

const MIN_DURATION_OPTIONS = [
  { value: "300", label: "0.3 s+" },
  { value: "500", label: "0.5 s+" },
  { value: "1000", label: "1 s+" },
] as const

function formatClock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

export function SmartCutCard() {
  const recording = useTimelineStore((state) => state.recording)
  const execute = useTimelineStore((state) => state.execute)
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()

  const [thresholdDb, setThresholdDb] = useState<string>("-35")
  const [minDurationMs, setMinDurationMs] = useState<string>("500")
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [ranges, setRanges] = useState<SilenceRange[] | null>(null)

  const removedMs = ranges?.reduce((total, range) => total + (range.endMs - range.startMs), 0) ?? 0

  async function handleScan() {
    if (!isPro) {
      openUpgradeDialog(["smart-cut"])
      return
    }
    if (!recording) return
    setIsScanning(true)
    setScanError(null)
    try {
      const found = await detectSilences(recording.id, {
        thresholdDb: Number(thresholdDb),
        minDurationMs: Number(minDurationMs),
      })
      // Merge ranges that would collide after earlier cuts shift the tail —
      // the command merges internally too, but the list shows what will go.
      setRanges(found.filter((range) => range.endMs > range.startMs))
    } catch {
      setScanError("The silence scan failed — try again.")
      setRanges(null)
    } finally {
      setIsScanning(false)
    }
  }

  function handleApply() {
    if (!ranges || ranges.length === 0) return
    const ok = execute(createRippleDeleteRangesCommand(ranges))
    if (ok) {
      toast({
        title: "Smart Cut applied",
        description: `Removed ${ranges.length} silence${ranges.length === 1 ? "" : "s"} (${formatDuration(removedMs)}).`,
      })
      setRanges(null)
    } else {
      toast({
        title: "Could not apply Smart Cut",
        description: "The timeline may have changed since the scan.",
        variant: "error",
      })
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Scissors className="size-3.5 text-primary" aria-hidden />
          Smart Cut
          {!isPro ? <ProBadge /> : null}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Detect silent pauses and remove them across every track in one undoable step.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Select value={thresholdDb} onValueChange={setThresholdDb}>
          <SelectTrigger className="h-8" aria-label="Silence threshold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THRESHOLD_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={minDurationMs} onValueChange={setMinDurationMs}>
          <SelectTrigger className="h-8" aria-label="Minimum silence duration">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MIN_DURATION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {scanError ? (
        <p className="text-[11px] font-medium text-destructive" role="alert">
          {scanError}
        </p>
      ) : null}

      {ranges !== null ? (
        ranges.length === 0 ? (
          <p className="text-[11px] text-subtle-foreground">
            No silences found — try a lower threshold or shorter duration.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="max-h-32 overflow-y-auto rounded border border-border/60 bg-surface-dim p-2">
              <ul className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
                {ranges.map((range) => (
                  <li
                    key={`${range.startMs}-${range.endMs}`}
                    className="flex justify-between font-mono"
                  >
                    <span>
                      {formatClock(range.startMs)} → {formatClock(range.endMs)}
                    </span>
                    <span>{formatDuration(range.endMs - range.startMs)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Button size="sm" onClick={handleApply}>
              Remove {ranges.length} silence{ranges.length === 1 ? "" : "s"} · saves{" "}
              {formatDuration(removedMs)}
            </Button>
          </div>
        )
      ) : null}

      <Button variant="outline" size="sm" onClick={handleScan} disabled={isScanning || !recording}>
        {isScanning ? "Scanning…" : "Scan for silences"}
      </Button>
    </div>
  )
}
