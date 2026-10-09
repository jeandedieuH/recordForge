import { useState } from "react"
import { KeyRound, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import { Badge, Button, Input, useToast } from "@recordforge/ui"
import { useLicenseStore } from "../../stores/license-store"
import { ProBadge } from "./pro-badge"
import { UpgradeDialog } from "./upgrade-dialog"

/**
 * Settings → General: license status + activate/deactivate/refresh.
 * The raw key is never shown again after activation; only plan metadata is.
 */
export function LicenseSettings() {
  const status = useLicenseStore((state) => state.status)
  const isLoading = useLicenseStore((state) => state.isLoading)
  const isBusy = useLicenseStore((state) => state.isBusy)
  const error = useLicenseStore((state) => state.error)
  const activate = useLicenseStore((state) => state.activate)
  const deactivate = useLicenseStore((state) => state.deactivate)
  const refresh = useLicenseStore((state) => state.refresh)
  const { toast } = useToast()
  const [key, setKey] = useState("")
  const [upgradeOpen, setUpgradeOpen] = useState(false)

  const isPro = status.tier === "pro"

  async function handleActivate() {
    const ok = await activate(key)
    if (ok) {
      setKey("")
      toast({ title: "RecordForge Pro activated", description: "Pro features are now unlocked." })
    }
  }

  async function handleDeactivate() {
    await deactivate()
    toast({ title: "License removed", description: "This device is back on the Free tier." })
  }

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="h-5 w-40 animate-pulse rounded bg-surface-dim" />
        <div className="mt-3 h-9 w-full animate-pulse rounded bg-surface-dim" />
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="size-4 text-primary" aria-hidden />
            RecordForge License
          </h3>
          <p className="mt-0.5 text-xs text-subtle-foreground">
            {isPro
              ? "Pro is active on this device."
              : "Free tier — upgrade once for lifetime Pro on 3 devices."}
          </p>
        </div>
        {isPro ? <ProBadge /> : <Badge variant="outline">Free</Badge>}
      </div>

      {isPro ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-surface-dim p-3 text-xs text-subtle-foreground">
            <p>
              Plan: <span className="font-mono font-semibold text-foreground">{status.plan}</span>
              {status.activatedAtMs ? (
                <>
                  {" "}
                  · activated{" "}
                  {new Date(status.activatedAtMs).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </>
              ) : null}
            </p>
            <p className="mt-1">
              Device: <span className="text-foreground">{status.deviceLabel || "this device"}</span>
              {status.lastVerifiedAtMs ? (
                <>
                  {" "}
                  · verified{" "}
                  {new Date(status.lastVerifiedAtMs).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={isBusy || !status.serverConfigured}
              onClick={() => void refresh()}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {isBusy ? "Checking…" : "Check license"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              disabled={isBusy}
              onClick={() => void handleDeactivate()}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Deactivate this device
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Paste your license key"
              aria-label="License key"
              className="h-9 font-mono text-xs"
              disabled={isBusy}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleActivate()
              }}
            />
            <Button
              variant="primary"
              size="sm"
              className="h-9 shrink-0 px-4 text-xs"
              disabled={isBusy || !key.trim()}
              onClick={() => void handleActivate()}
            >
              {isBusy ? "Activating…" : "Activate"}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              Activation is a one-time online check; Pro then works fully offline.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              onClick={() => setUpgradeOpen(true)}
            >
              <ShieldCheck className="size-3 text-primary" aria-hidden />
              Get Pro
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <p className="text-xs text-warning" role="alert">
          {error}
        </p>
      ) : null}

      <UpgradeDialog open={upgradeOpen} onOpenChange={setUpgradeOpen} />
    </div>
  )
}
