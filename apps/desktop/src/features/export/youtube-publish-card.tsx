import { useEffect, useRef, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { SquarePlay } from "lucide-react"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useToast,
} from "@recordforge/ui"
import {
  cancelYouTubePublish,
  disconnectYouTube,
  onYouTubeOAuthCompleted,
  onYouTubePublishProgress,
  publishToYouTube,
  startYouTubeOAuth,
  youtubeConnectionStatus,
} from "../../lib/publish"
import { useLicenseStore } from "../../stores/license-store"
import { ProBadge } from "../licensing/pro-badge"
import type {
  JobDelivery,
  MediaJob,
  TimelineMarker,
  YouTubeAutoPublishSettings,
  YouTubePrivacy,
} from "@recordforge/contracts"
import { formatYouTubeChapters } from "@recordforge/editor-core"

interface YouTubePublishCardProps {
  exportJob: MediaJob | null
  projectName: string
  markers: TimelineMarker[]
  disabled?: boolean
  /** Persisted auto-publish settings (Pro). Absent on legacy projects. */
  autoPublish?: YouTubeAutoPublishSettings
  onAutoPublishChange?: (settings: YouTubeAutoPublishSettings) => void
  /** Re-run the persisted auto-publish delivery on the completed export. */
  onRetryDelivery?: () => void | Promise<void>
  /** Cancel a running auto-publish delivery (job-level cancel token). */
  onCancelDelivery?: () => void | Promise<void>
  /** Byte-level progress fraction for a running delivery upload, 0..1. */
  deliveryProgress?: number
}

type PublishState = "idle" | "connecting" | "uploading" | "done" | "failed"

const CAPTION_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
]

const DEFAULT_AUTO_PUBLISH: YouTubeAutoPublishSettings = {
  enabled: false,
  privacy: "unlisted",
  attachCaptions: true,
  captionsLanguage: "en",
}

export function YouTubePublishCard({
  exportJob,
  projectName,
  markers,
  disabled = false,
  autoPublish,
  onAutoPublishChange,
  onRetryDelivery,
  onCancelDelivery,
  deliveryProgress,
}: YouTubePublishCardProps) {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()

  const [connected, setConnected] = useState(false)
  const [accountLabel, setAccountLabel] = useState<string | null>(null)
  const [title, setTitle] = useState(projectName)
  const [description, setDescription] = useState("")
  const [localPrivacy, setLocalPrivacy] = useState<YouTubePrivacy>("unlisted")
  const [localAttachCaptions, setLocalAttachCaptions] = useState(true)
  const [localCaptionsLanguage, setLocalCaptionsLanguage] = useState("en")
  const [state, setState] = useState<PublishState>("idle")
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  // User-initiated cancel — the in-flight publish rejects with an error that
  // must reset to idle, not surface a "publish failed" toast.
  const cancelledRef = useRef(false)

  // One source of truth for the publish options: persisted auto-publish
  // settings when the store wires them in, local state otherwise.
  const privacy = autoPublish?.privacy ?? localPrivacy
  const attachCaptions = autoPublish?.attachCaptions ?? localAttachCaptions
  const captionsLanguage = autoPublish?.captionsLanguage ?? localCaptionsLanguage
  const setPrivacy = (value: YouTubePrivacy) => {
    if (onAutoPublishChange) {
      onAutoPublishChange({ ...(autoPublish ?? DEFAULT_AUTO_PUBLISH), privacy: value })
    } else {
      setLocalPrivacy(value)
    }
  }
  const setAttachCaptions = (value: boolean) => {
    if (onAutoPublishChange) {
      onAutoPublishChange({ ...(autoPublish ?? DEFAULT_AUTO_PUBLISH), attachCaptions: value })
    } else {
      setLocalAttachCaptions(value)
    }
  }
  const setCaptionsLanguage = (value: string) => {
    if (onAutoPublishChange) {
      onAutoPublishChange({ ...(autoPublish ?? DEFAULT_AUTO_PUBLISH), captionsLanguage: value })
    } else {
      setLocalCaptionsLanguage(value)
    }
  }
  const autoPublishEnabled = autoPublish?.enabled ?? false

  // The auto-publish delivery rides the durable export job — its state is
  // read straight off `outputs.deliveries`, never a local flag.
  const delivery: JobDelivery | undefined = exportJob?.outputs.deliveries?.find(
    (entry) => entry.kind === "youtube",
  )

  const outputPath = exportJob?.status === "completed" ? exportJob.outputs.outputPath : null
  const captionsPath = exportJob?.status === "completed" ? exportJob.outputs.captionsPath : null

  useEffect(() => {
    void youtubeConnectionStatus()
      .then((status) => {
        setConnected(status.connected)
        setAccountLabel(status.accountLabel)
      })
      // A vault/status read failure degrades to "not connected" — the Connect
      // button remains the recovery path rather than a stuck card.
      .catch(() => setConnected(false))
  }, [])

  // YouTube parses "0:00 Chapter title" lines in the description into video
  // chapters automatically — seed it from the timeline markers.
  useEffect(() => {
    if (description) return
    const chapters = formatYouTubeChapters(markers)
    if (chapters) setDescription(chapters)
  }, [markers, description])

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      onYouTubeOAuthCompleted((event) => {
        setState("idle")
        if (event.success) {
          setConnected(true)
          setAccountLabel(event.accountLabel ?? "YouTube")
        } else {
          toast({
            title: "YouTube sign-in failed",
            description: event.error ?? "authorization failed",
            variant: "warning",
          })
        }
      }),
      onYouTubePublishProgress((event) => {
        if (event.stage === "uploading" && event.totalBytes > 0) {
          setProgress(event.uploadedBytes / event.totalBytes)
        }
        if (event.stage === "done") setProgress(1)
      }),
    ]
    return () => {
      for (const unlisten of unlisteners) void unlisten.then((fn) => fn())
    }
  }, [toast])

  async function handleConnect() {
    setState("connecting")
    try {
      const flow = await startYouTubeOAuth()
      await openUrl(flow.authUrl)
    } catch (error) {
      setState("idle")
      toast({
        title: "YouTube sign-in failed",
        description: error instanceof Error ? error.message : "failed to start",
        variant: "warning",
      })
    }
  }

  async function handlePublish() {
    if (!outputPath) return
    cancelledRef.current = false
    setState("uploading")
    setProgress(0)
    setVideoUrl(null)
    try {
      const result = await publishToYouTube({
        path: outputPath,
        title: title.trim() || projectName,
        description,
        privacy,
        categoryId: "28",
        tags: [],
        captionsPath: attachCaptions && captionsPath ? captionsPath : undefined,
        captionsLanguage,
      })
      setVideoUrl(result.url)
      setState("done")
      toast({ title: "Published to YouTube", description: result.url })
    } catch (error) {
      if (cancelledRef.current) {
        setState("idle")
        return
      }
      setState("failed")
      toast({
        title: "YouTube publish failed",
        description: error instanceof Error ? error.message : "publish failed",
        variant: "warning",
      })
    }
  }

  function handleCancel() {
    cancelledRef.current = true
    void cancelYouTubePublish()
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full items-center justify-between p-4">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground font-label">
          <SquarePlay className="size-4 text-destructive" aria-hidden />
          Publish to YouTube
          {!isPro ? <ProBadge /> : null}
        </span>
        <span className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-subtle-foreground">
            Auto-publish on export
            <Switch
              checked={autoPublishEnabled}
              disabled={disabled}
              aria-label="Auto-publish on export"
              onCheckedChange={(enabled) => {
                // Same Pro gate as Instant Share — enabling opens the upgrade
                // dialog on Free; turning off is always allowed.
                if (enabled && !isPro) {
                  openUpgradeDialog(["youtube-publish"])
                  return
                }
                onAutoPublishChange?.({ ...(autoPublish ?? DEFAULT_AUTO_PUBLISH), enabled })
              }}
            />
          </label>
          {connected ? (
            <button
              type="button"
              className="text-xs text-subtle-foreground underline-offset-2 hover:underline"
              onClick={() => {
                void disconnectYouTube()
                  .then(() => {
                    setConnected(false)
                    setAccountLabel(null)
                  })
                  .catch(() => undefined)
              }}
            >
              Disconnect
            </button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-3 border-t border-border p-5 text-xs text-subtle-foreground">
        {!connected ? (
          <>
            <p>
              Upload exports straight to YouTube — chapter markers become description timestamps,
              and sidecar captions attach when enabled. Connect once; the refresh token stays in the
              OS credential vault.
            </p>
            <Button
              variant="secondary"
              disabled={disabled || state === "connecting"}
              onClick={() => {
                if (!isPro) {
                  openUpgradeDialog(["youtube-publish"])
                  return
                }
                void handleConnect()
              }}
            >
              {state === "connecting" ? "Waiting for Google sign-in…" : "Connect YouTube"}
            </Button>
          </>
        ) : (
          <>
            <span className="text-foreground">
              Signed in{accountLabel ? ` as ${accountLabel}` : ""}
            </span>
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1.5">
                <span>Visibility</span>
                <Select
                  value={privacy}
                  onValueChange={(value) => setPrivacy(value as YouTubePrivacy)}
                  disabled={disabled || state === "uploading"}
                >
                  <SelectTrigger className="h-8 w-full" aria-label="YouTube visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unlisted">Unlisted — link only</SelectItem>
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex w-40 flex-col gap-1.5">
                <span>Caption language</span>
                <Select
                  value={captionsLanguage}
                  onValueChange={setCaptionsLanguage}
                  disabled={disabled || state === "uploading" || !attachCaptions}
                >
                  <SelectTrigger className="h-8 w-full" aria-label="Caption language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAPTION_LANGUAGES.map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <label className="flex items-center justify-between">
              <span>Attach captions (.srt sidecar) on publish</span>
              <Switch
                checked={attachCaptions}
                onCheckedChange={setAttachCaptions}
                disabled={disabled || state === "uploading"}
                aria-label="Attach captions"
              />
            </label>
            {autoPublishEnabled ? (
              <p className="text-[11px] text-muted-foreground">
                Auto-publish runs after each MP4 export using the project name and generated chapter
                timestamps — no extra step, even if you leave this view.
              </p>
            ) : null}

            {delivery ? (
              <DeliveryStatusRow
                delivery={delivery}
                progress={deliveryProgress}
                onRetry={onRetryDelivery}
                onCancel={onCancelDelivery}
              />
            ) : null}
          </>
        )}

        {connected && outputPath ? (
          <div className="mt-2 flex flex-col gap-3 border-t border-border/60 pt-4">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Manual publish
            </span>
            <label className="flex flex-col gap-1.5">
              <span>Title</span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={100}
                disabled={disabled || state === "uploading"}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span>Description (chapters included)</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                disabled={disabled || state === "uploading"}
              />
            </label>
            {captionsPath ? null : (
              <p className="text-[11px] text-muted-foreground">
                This export has no SRT sidecar — set Caption delivery to “Write SRT sidecar” to
                attach captions.
              </p>
            )}
            {state === "uploading" ? (
              <div className="flex flex-col gap-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <div className="flex justify-between">
                  <span>{Math.round(progress * 100)}% uploaded</span>
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={handleCancel}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <Button disabled={disabled || !title.trim()} onClick={() => void handlePublish()}>
                Publish this export
              </Button>
            )}
            {state === "done" && videoUrl ? (
              <button
                type="button"
                className="text-left font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => void openUrl(videoUrl)}
              >
                Open on YouTube — {videoUrl}
              </button>
            ) : null}
            {state === "failed" ? (
              <span className="font-medium text-warning">
                Publish failed — retry uploads resume from where they stopped.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Status line for the persisted auto-publish delivery on this export job. */
function DeliveryStatusRow({
  delivery,
  progress,
  onRetry,
  onCancel,
}: {
  delivery: JobDelivery
  progress?: number
  onRetry?: () => void | Promise<void>
  onCancel?: () => void | Promise<void>
}) {
  if (delivery.status === "running") {
    const percent =
      progress !== undefined ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-dim p-3">
        <div className="flex justify-between">
          <span className="font-medium text-foreground">
            Auto-publish in progress{percent !== null ? ` — ${percent}%` : ""}
          </span>
          {onCancel ? (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => void onCancel()}
            >
              Cancel
            </button>
          ) : null}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${percent ?? 5}%` }} />
        </div>
      </div>
    )
  }
  if (delivery.status === "done") {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface-dim p-3">
        <span className="font-medium text-foreground">Auto-published to YouTube</span>
        {delivery.url ? (
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => void openUrl(delivery.url!)}
          >
            Open video
          </button>
        ) : null}
      </div>
    )
  }
  if (delivery.status === "failed") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-recording/30 bg-recording/10 p-3">
        <span className="font-medium text-recording">
          Auto-publish failed{delivery.detail ? ` — ${delivery.detail}` : ""}
        </span>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={() => void onRetry()}>
            Retry
          </Button>
        ) : null}
      </div>
    )
  }
  if (delivery.status === "cancelled") {
    return (
      <div className="rounded-lg border border-border bg-surface-dim p-3 text-subtle-foreground">
        Auto-publish was cancelled.
      </div>
    )
  }
  if (delivery.status === "skipped") {
    return (
      <div className="rounded-lg border border-border bg-surface-dim p-3 text-subtle-foreground">
        Auto-publish skipped{delivery.detail ? ` — ${delivery.detail}` : ""}.
      </div>
    )
  }
  return null
}
