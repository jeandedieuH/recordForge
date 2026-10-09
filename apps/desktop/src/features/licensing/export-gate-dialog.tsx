import { Scissors, Sparkles } from "lucide-react"
import { PRO_FEATURES } from "@recordforge/contracts"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@recordforge/ui"
import type { ProUsageAnalysis } from "@recordforge/editor-core"
import { ProBadge } from "./pro-badge"

interface ExportGateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  analysis: ProUsageAnalysis | null
  /**
   * True when the canvas itself measures non-16:9. The strip path cannot fix
   * canvas geometry, so "Export without Pro features" is hidden and
   * "Convert canvas to 16:9" is shown instead — after converting, the gate
   * re-analyzes for any remaining Pro content.
   */
  canvasIsNonStandard: boolean
  /** "Upgrade to Pro" — opens the upgrade dialog / checkout. */
  onUpgrade: () => void
  /** Export now with Pro features stripped (annotations off, titles → Clean Text). */
  onExportStripped: () => void
  /** Convert the canvas to 16:9 via the smart-layout command (undoable). */
  onConvertCanvas?: () => void
}

/**
 * Shown when a Free user starts an export whose timeline/settings require Pro.
 * Keeps the honest-free promise: nothing is silently dropped — the user either
 * upgrades or exports with the listed features removed/converted.
 */
export function ExportGateDialog({
  open,
  onOpenChange,
  analysis,
  canvasIsNonStandard,
  onUpgrade,
  onExportStripped,
  onConvertCanvas,
}: ExportGateDialogProps) {
  const features = analysis?.features ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>This export uses Pro features</DialogTitle>
            <ProBadge />
          </div>
          <DialogDescription>
            Upgrade to keep everything, or export on the Free tier with these removed.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 rounded-lg border border-border bg-surface-dim p-3 text-xs">
          {features.map((usage) => (
            <li key={usage.feature} className="flex items-start justify-between gap-3">
              <span>
                <span className="font-semibold text-foreground">
                  {PRO_FEATURES[usage.feature]?.label ?? usage.feature}
                </span>
                <span className="block text-[11px] text-subtle-foreground">{usage.detail}</span>
              </span>
              <ProBadge />
            </li>
          ))}
        </ul>

        {analysis?.outputCappedTo1080p ? (
          <p className="text-[11px] text-subtle-foreground">
            Your canvas is above 1080p — Free exports downscale it to 1920×1080 automatically.
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button variant="primary" onClick={onUpgrade}>
            <Sparkles className="mr-1.5 size-3.5" aria-hidden />
            Upgrade to Pro
          </Button>
          {canvasIsNonStandard && onConvertCanvas ? (
            <Button variant="outline" onClick={onConvertCanvas}>
              <Scissors className="mr-1.5 size-3.5" aria-hidden />
              Convert canvas to 16:9
            </Button>
          ) : null}
          {!canvasIsNonStandard ? (
            <Button variant="outline" onClick={onExportStripped}>
              Export without Pro features
            </Button>
          ) : null}
          <DialogFooter className="sm:justify-center">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
