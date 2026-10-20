import { useCallback, useEffect, useState } from "react"
import {
  BarChart3,
  ExternalLink,
  Link2,
  Lock,
  MessageSquare,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react"
import { Badge, Button, IconButton, useToast } from "@recordforge/ui"
import type { ShareAnalytics, ShareInfo } from "@recordforge/contracts"
import { listShares, renewShare, revokeShare, shareAnalytics } from "../../lib/share"
import { toErrorMessage } from "../../lib/errors"
import { useLicenseStore } from "../../stores/license-store"
import { ProBadge } from "../licensing/pro-badge"

/**
 * Hosted Instant Share links the current license owns — renew (30-day
 * window), copy, or permanently revoke. Free users get the upgrade prompt;
 * an inactive license never reaches the server.
 */
export function SharedLinksCard() {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()
  const [shares, setShares] = useState<ShareInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isPro) {
      setShares([])
      return
    }
    setError(null)
    try {
      setShares(await listShares())
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }, [isPro])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!isPro) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-dashed border-border bg-surface-dim p-4">
        <div className="flex items-center gap-3">
          <Share2 className="size-4 text-subtle-foreground" aria-hidden />
          <div>
            <p className="text-sm font-medium text-foreground">Instant Share links</p>
            <p className="text-xs text-subtle-foreground">
              Hosted link delivery for your exports — a Pro feature.
            </p>
          </div>
          <ProBadge />
        </div>
        <Button size="sm" variant="secondary" onClick={() => openUpgradeDialog(["instant-share"])}>
          Upgrade
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Share2 className="size-4 text-track-voiceover" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground">Shared links</h3>
          <Badge variant="outline" className="text-[10px]">
            {shares?.filter((share) => share.status !== "expired").length ?? 0} active
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3" />
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/5 p-3.5 text-xs text-destructive">
          <span>{error}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </div>
      ) : shares === null ? (
        <div className="h-16 animate-pulse rounded-lg bg-surface-dim" aria-hidden />
      ) : shares.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-surface-dim p-4 text-xs text-subtle-foreground">
          No shared links yet — enable Instant Share on the export screen and the link copies to
          your clipboard automatically.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {shares.map((share) => (
            <ShareRow
              key={share.shareId}
              share={share}
              busy={busyId === share.shareId}
              onAction={async (action) => {
                setBusyId(share.shareId)
                try {
                  if (action === "copy") {
                    await navigator.clipboard.writeText(share.url).catch(() => undefined)
                    toast({ title: "Link copied", description: share.url })
                  } else if (action === "renew") {
                    await renewShare(share.shareId)
                    toast({ title: "Link renewed", description: "Expires 30 days from now." })
                  } else {
                    await revokeShare(share.shareId)
                    toast({ title: "Link revoked", description: "The hosted video was deleted." })
                  }
                  await refresh()
                } catch (err) {
                  toast({
                    title: "Share action failed",
                    description: toErrorMessage(err),
                    variant: "warning",
                  })
                } finally {
                  setBusyId(null)
                }
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

const STATUS_VARIANT: Record<
  ShareInfo["status"],
  "default" | "info" | "outline" | "success" | "warning"
> = {
  live: "success",
  uploading: "info",
  expired: "outline",
  revoked: "warning",
}

interface ShareRowProps {
  share: ShareInfo
  busy: boolean
  onAction: (action: "copy" | "renew" | "revoke") => Promise<void>
}

function ShareRow({ share, busy, onAction }: ShareRowProps) {
  const expiry = new Date(share.expiresAtMs).toLocaleDateString()
  const [expanded, setExpanded] = useState(false)
  const [stats, setStats] = useState<ShareAnalytics | null>(null)
  const [statsError, setStatsError] = useState(false)

  // Analytics load lazily on first expand — one round trip per link.
  function toggleStats() {
    const next = !expanded
    setExpanded(next)
    if (next && !stats && !statsError) {
      shareAnalytics(share.shareId)
        .then(setStats)
        .catch(() => setStatsError(true))
    }
  }

  return (
    <li className="flex flex-col">
      <div className="flex items-center gap-3 p-3">
        <Link2 className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 truncate text-xs font-medium text-foreground">
            {share.title}
            {share.hasPassword ? (
              <Lock
                className="size-3 shrink-0 text-subtle-foreground"
                aria-label="Password-protected"
              />
            ) : null}
          </span>
          <span className="text-[11px] text-subtle-foreground">
            {share.views} view{share.views === 1 ? "" : "s"} ·{" "}
            {share.status === "live" ? `expires ${expiry}` : share.status}
          </span>
        </div>
        <Badge variant={STATUS_VARIANT[share.status]} className="text-[10px] uppercase">
          {share.status}
        </Badge>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label={expanded ? "Hide analytics" : "View analytics"}
            variant="ghost"
            size="sm"
            disabled={share.status === "uploading"}
            onClick={toggleStats}
          >
            <BarChart3 className="size-3.5" />
          </IconButton>
          {share.status === "live" ? (
            <>
              <IconButton
                label="Copy link"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void onAction("copy")}
              >
                <ExternalLink className="size-3.5" />
              </IconButton>
              <IconButton
                label="Renew for 30 days"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void onAction("renew")}
              >
                <RefreshCw className="size-3.5" />
              </IconButton>
              <IconButton
                label="Revoke link"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void onAction("revoke")}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-border/50 bg-surface-dim/40 px-3 py-2.5">
          {stats === null ? (
            statsError ? (
              <span className="text-[11px] text-warning">Analytics unavailable right now.</span>
            ) : (
              <div className="h-6 animate-pulse rounded bg-surface-dim" aria-hidden />
            )
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-subtle-foreground">
              <span>
                <strong className="font-medium text-foreground">{stats.views}</strong> views
              </span>
              <span>
                <strong className="font-medium text-foreground">{stats.uniqueViewers}</strong>{" "}
                unique viewers
              </span>
              <span>
                <strong className="font-medium text-foreground">
                  {Math.round(stats.avgWatchSeconds)}s
                </strong>{" "}
                avg watch
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="size-3" aria-hidden />
                <strong className="font-medium text-foreground">{stats.comments}</strong> comments
                {stats.unresolvedComments > 0 ? (
                  <Badge variant="warning" className="text-[9px]">
                    {stats.unresolvedComments} new
                  </Badge>
                ) : null}
              </span>
            </div>
          )}
        </div>
      ) : null}
    </li>
  )
}
