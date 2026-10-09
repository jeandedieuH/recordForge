import { Sparkles } from "lucide-react"
import { cn } from "@recordforge/ui"
import type { ProUsageAnalysis } from "@recordforge/editor-core"
import { PRO_FEATURES } from "@recordforge/contracts"

interface ProUsageChipProps {
  analysis: ProUsageAnalysis | null
  onClick?: () => void
  className?: string
}

/**
 * Editor header chip: "Pro features in use (N)". Visible to Free users when
 * the timeline contains Pro content; clicking opens the upgrade dialog so the
 * gate is discoverable before export. Hidden for Pro users and clean timelines.
 */
export function ProUsageChip({ analysis, onClick, className }: ProUsageChipProps) {
  const count = analysis?.features.length ?? 0
  if (!analysis?.requiresPro) return null

  const summary = analysis.features
    .map((usage) => PRO_FEATURES[usage.feature]?.label ?? usage.feature)
    .join(", ")

  return (
    <button
      type="button"
      onClick={onClick}
      title={summary}
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5",
        "text-[10px] font-semibold text-warning transition-colors hover:bg-warning/20",
        className,
      )}
    >
      <Sparkles className="size-3" aria-hidden />
      <span>Pro features in use ({count})</span>
    </button>
  )
}
