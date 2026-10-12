import { useRef } from "react"
import { AlertTriangle, Info } from "lucide-react"
import { Skeleton } from "@recordforge/ui"
import type { CameraCapturePlan, CameraProfileId } from "@recordforge/contracts"
import { cameraTiers } from "@recordforge/contracts"
import {
  estimateImpact,
  estimateMbPerMinute,
  estimateRecordingMinutes,
  formatBytes,
  formatDurationHuman,
  formatMbps,
  planSummary,
} from "./camera-format"
import type { CameraPlansStatus } from "./use-camera-plans"

export const LOW_DISK_BYTES = 1 << 30 // mirrors the Rust prepare() guard
const LOW_TIME_MINUTES = 20

interface CameraQualityPickerProps {
  selected: CameraProfileId
  onSelect: (id: CameraProfileId) => void
  plans: Record<CameraProfileId, CameraCapturePlan> | null
  status: CameraPlansStatus
  hasHardwareEncoder: boolean
  freeBytes: number | null
  storageLoaded: boolean
  // Mic contributes ~1536 kbps to the remaining-time estimate.
  totalKbpsExtra: number
}

const IMPACT_LABEL: Record<string, string> = {
  light: "Light",
  moderate: "Moderate",
  heavy: "Heavy",
}

const IMPACT_STYLE: Record<string, string> = {
  light: "bg-success/15 text-success",
  moderate: "bg-warning/15 text-warning",
  heavy: "bg-recording/15 text-recording",
}

export function CameraQualityPicker({
  selected,
  onSelect,
  plans,
  status,
  hasHardwareEncoder,
  freeBytes,
  storageLoaded,
  totalKbpsExtra,
}: CameraQualityPickerProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const loading = status === "loading" && !plans
  const selectedPlan = plans?.[selected] ?? null
  const totalKbps = (selectedPlan?.videoBitrateKbps ?? 6843) + totalKbpsExtra
  const minutes = freeBytes != null ? estimateRecordingMinutes(freeBytes, totalKbps) : null
  const diskBlocked = freeBytes != null && freeBytes < LOW_DISK_BYTES
  const diskWarning = !diskBlocked && minutes != null && minutes < LOW_TIME_MINUTES

  // One banner for the whole list instead of a "Camera max" badge per card —
  // the badges wrapped and collided with the bitrate metrics.
  const limitedPlan = plans ? Object.values(plans).find((plan) => plan.limitedByCamera) : null

  function handleKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault()
      refs.current[(index + 1) % cameraTiers.length]?.focus()
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault()
      refs.current[(index + cameraTiers.length - 1) % cameraTiers.length]?.focus()
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      onSelect(cameraTiers[index].id)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {limitedPlan ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-2.5"
        >
          <Info className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Your camera tops out at {limitedPlan.outputWidth}×{limitedPlan.outputHeight}. Higher
            tiers keep that size but add bitrate for cleaner detail.
          </p>
        </div>
      ) : null}

      <div role="radiogroup" aria-label="Camera quality" className="flex flex-col gap-2">
        {cameraTiers.map((tier, index) => {
          const plan = plans?.[tier.id] ?? null
          const isSelected = selected === tier.id
          const kbps = plan?.videoBitrateKbps
          const impact = plan ? estimateImpact(plan, hasHardwareEncoder) : null
          return (
            <button
              key={tier.id}
              ref={(el) => {
                refs.current[index] = el
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(tier.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-left transition-all duration-base cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isSelected
                  ? "border-primary bg-primary/15"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-foreground">{tier.label}</span>
                  {tier.id === "camera-balanced" ? (
                    <span className="whitespace-nowrap shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground">
                      Recommended
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[11px] text-subtle-foreground">
                  {loading ? <Skeleton className="h-3 w-28 rounded" /> : planSummary(plan)}
                </div>
              </div>
              {/* Fixed-width metrics column — badges/chips must never collide
                  with it at narrow widths. */}
              <div className="flex min-w-26 shrink-0 flex-col items-end gap-0.5">
                {loading ? (
                  <Skeleton className="h-3 w-16 rounded" />
                ) : kbps ? (
                  <span className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">
                    {formatMbps(kbps)}
                  </span>
                ) : (
                  <span className="whitespace-nowrap text-[11px] text-subtle-foreground">Auto</span>
                )}
                {kbps ? (
                  <span className="whitespace-nowrap text-[10px] text-subtle-foreground">
                    ≈ {Math.round(estimateMbPerMinute(kbps))} MB/min
                  </span>
                ) : null}
                {impact ? (
                  <span
                    title="Estimated CPU/GPU load on this PC"
                    className={`mt-0.5 whitespace-nowrap shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${IMPACT_STYLE[impact]}`}
                  >
                    {IMPACT_LABEL[impact]}
                  </span>
                ) : null}
              </div>
            </button>
          )
        })}
      </div>

      <div className="text-[11px]">
        {!storageLoaded ? (
          <Skeleton className="h-3 w-40 rounded" />
        ) : freeBytes == null ? (
          <span className="text-subtle-foreground">Free space unknown</span>
        ) : (
          <span className={diskBlocked || diskWarning ? "text-warning" : "text-subtle-foreground"}>
            {formatBytes(freeBytes)} free · about {formatDurationHuman(minutes ?? 0)} of recording
            at this quality
          </span>
        )}
        {diskBlocked || diskWarning ? (
          <span className="mt-1 flex items-center gap-1 text-warning">
            <AlertTriangle className="size-3" aria-hidden />
            {diskBlocked
              ? "Low disk space — free up space to start"
              : `Low disk space — about ${formatDurationHuman(minutes ?? 0)} left`}
          </span>
        ) : null}
      </div>
    </div>
  )
}
