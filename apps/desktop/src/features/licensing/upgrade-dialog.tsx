import { openUrl } from "@tauri-apps/plugin-opener"
import { CheckCircle2, Sparkles } from "lucide-react"
import { PRO_FEATURES, type ProFeatureKey } from "@recordforge/contracts"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@recordforge/ui"
import { isTauri } from "../../lib/settings"
import { PRO_CHECKOUT_URL } from "../../lib/license"
import { ProBadge } from "./pro-badge"

const PRO_BENEFITS: string[] = [
  "1440p and 4K exports (Ultra 4K presets)",
  "Vertical, square, and custom aspect ratios",
  "Chapters, chapter sidecars, and YouTube timestamps",
  "Every title preset beyond Clean Text",
  "Annotations — shapes, arrows, and callouts",
  "Lifetime updates · 3 personal devices",
]

interface UpgradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Feature keys that triggered the dialog; shown as the blocked list. */
  features?: ProFeatureKey[]
}

/**
 * The single upsell surface. Triggered by Pro badges, the export gate, and
 * Settings → License. Keeps the tone honest per the licensing docs: the GPL
 * code is open; Pro buys convenience and supports development.
 */
export function UpgradeDialog({ open, onOpenChange, features = [] }: UpgradeDialogProps) {
  const openCheckout = () => {
    if (isTauri()) {
      void openUrl(PRO_CHECKOUT_URL).catch(() => window.open(PRO_CHECKOUT_URL, "_blank"))
    } else {
      window.open(PRO_CHECKOUT_URL, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>RecordForge Pro</DialogTitle>
            <ProBadge />
          </div>
          <DialogDescription>
            One-time purchase — lifetime license for 3 personal devices.
          </DialogDescription>
        </DialogHeader>

        {features.length > 0 ? (
          <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-foreground">
            <p className="mb-1 font-semibold">This export uses Pro features:</p>
            <ul className="list-disc space-y-0.5 pl-4 text-subtle-foreground">
              {features.map((feature) => (
                <li key={feature}>{PRO_FEATURES[feature]?.label ?? feature}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <ul className="space-y-2 text-xs text-subtle-foreground">
          {PRO_BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <Sparkles className="mr-1 inline size-3 text-primary" aria-hidden />
          Pro keeps working fully offline after a one-time activation. The app itself stays
          GPL-licensed open source — Pro supports its development.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button variant="primary" onClick={openCheckout}>
            Upgrade to Pro
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
