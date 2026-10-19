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
  disconnectYouTube,
  onYouTubeOAuthCompleted,
  publishToYouTube,
  startYouTubeOAuth,
  youtubeConnectionStatus,
} from "../../lib/publish"
import { useLicenseStore } from "../../stores/license-store"
import { usePublicationStore } from "../../stores/publication-store"
import { ProBadge } from "../licensing/pro-badge"
import { toErrorMessage } from "../../lib/errors"
import type { MediaJob, TimelineMarker, YouTubePrivacy } from "@recordforge/contracts"
import { publicationJobIsActive } from "@recordforge/contracts"
import { formatYouTubeChapters } from "@recordforge/editor-core"

interface YouTubePublishCardProps {
  exportJob: MediaJob | null
  projectName: string
  markers: TimelineMarker[]
  disabled?: boolean
}

// Captions attach through captions.insert — a real language is required; a
// small curated set covers the common cases and stays honest.
const CAPTION_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "pt", label: "Portuguese" },
  { code: "ja", label: "Japanese" },
]

export function YouTubePublishCard({
  exportJob,
  projectName,
  markers,
  disabled = false,
}: YouTubePublishCardProps) {
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { toast } = useToast()

  const [connected, setConnected] = useState(false)
  const [accountLabel, setAccountLabel] = useState<string | null>(null)
  const [title, setTitle] = useState(projectName)
  const [description, setDescription] = useState("")
  const [privacy, setPrivacy] = useState<YouTubePrivacy>("unlisted")
  const [attachCaptions, setAttachCaptions] = useState(true)
  const [captionsLanguage, setCaptionsLanguage] = useState("en")
  const [connecting, setConnecting] = useState(false)
  // The flow's correlation id — a stale `youtube-oauth-completed` from an
  // earlier flow must not mark THIS attempt connected.
  const oauthStateRef = useRef<string | null>(null)

  // The latest YouTube publication for this export — provider-scoped so a
  // hosted/BYO share of the same file never shows up as this card's job.
  const job = usePublicationStore((state) =>
    exportJob ? state.jobForExport(exportJob.id, "youTube") : undefined,
  )
  const publishing = job != null && publicationJobIsActive(job)
  const progress = job && job.totalBytes > 0 ? Math.min(1, job.uploadedBytes / job.totalBytes) : 0

  const exportFinished = exportJob?.status === "completed"
  const captionsAvailable = exportFinished && exportJob?.outputs.captionsPath != null

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

  // Keep the field in sync when a different export/project loads — without
  // clobbering edits made for this one.
  useEffect(() => {
    setTitle(projectName)
  }, [projectName])

  useEffect(() => {
    const unlisten = onYouTubeOAuthCompleted((event) => {
      // Correlate on the flow state — an event for another flow is ignored.
      if (oauthStateRef.current && event.state !== oauthStateRef.current) return
      oauthStateRef.current = null
      setConnecting(false)
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
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [toast])

  async function handleConnect() {
    setConnecting(true)
    try {
      const flow = await startYouTubeOAuth()
      oauthStateRef.current = flow.state
      await openUrl(flow.authUrl)
    } catch (error) {
      setConnecting(false)
      toast({
        title: "YouTube sign-in failed",
        description: error instanceof Error ? error.message : "failed to start",
        variant: "warning",
      })
    }
  }

  async function handlePublish() {
    if (!exportJob || !exportFinished) return
    try {
      await publishToYouTube({
        exportJobId: exportJob.id,
        operationId: crypto.randomUUID(),
        privacy,
        title: title.trim() || undefined,
        description,
        categoryId: "28",
        tags: [],
        captions: attachCaptions && captionsAvailable,
        captionsLanguage: captionsLanguage,
      })
      // Progress + result land via the publication store — no local await.
    } catch (error) {
      toast({
        title: "YouTube publish failed",
        description: toErrorMessage(error),
        variant: "warning",
      })
    }
  }

  function handleCancel() {
    if (job) void usePublicationStore.getState().cancel(job.id)
  }

  if (!exportFinished) return null

  const resultUrl =
    job?.status === "completed" && job.result?.kind === "youtube" ? job.result.url : null
  const captionsAttached =
    job?.status === "completed" && job.result?.kind === "youtube"
      ? job.result.captionsAttached
      : false

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex w-full items-center justify-between p-4">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground font-label">
          <SquarePlay className="size-4 text-destructive" aria-hidden />
          Publish to YouTube
          {!isPro ? <ProBadge /> : null}
        </span>
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
      </div>

      <div className="flex flex-col gap-3 border-t border-border p-5 text-xs text-subtle-foreground">
        {!connected ? (
          <>
            <p>
              Upload this export straight to YouTube — chapters from your markers are added to the
              description automatically, and sidecar captions attach when enabled.
            </p>
            <Button
              variant="secondary"
              disabled={disabled || connecting}
              onClick={() => {
                if (!isPro) {
                  openUpgradeDialog(["youtube-publish"])
                  return
                }
                void handleConnect()
              }}
            >
              {connecting ? "Waiting for Google sign-in…" : "Connect YouTube"}
            </Button>
          </>
        ) : (
          <>
            <span className="text-foreground">
              Signed in{accountLabel ? ` as ${accountLabel}` : ""}
            </span>
            <label className="flex flex-col gap-1.5">
              <span>Title</span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={100}
                disabled={disabled || publishing}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span>Description (chapters included)</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={4}
                disabled={disabled || publishing}
              />
            </label>
            {/* Explicit audience — no silent "public". */}
            <label className="flex flex-col gap-1.5">
              <span>Audience</span>
              <Select
                value={privacy}
                onValueChange={(value) => setPrivacy(value as YouTubePrivacy)}
                disabled={disabled || publishing}
              >
                <SelectTrigger className="h-8 w-full" aria-label="YouTube audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unlisted">Unlisted — link only</SelectItem>
                  <SelectItem value="private">Private — only you</SelectItem>
                  <SelectItem value="public">Public — everyone</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {captionsAvailable ? (
              <div className="flex items-end gap-3">
                <label className="flex flex-1 items-center justify-between">
                  <span>Upload captions (sidecar)</span>
                  <Switch
                    checked={attachCaptions}
                    onCheckedChange={setAttachCaptions}
                    disabled={disabled || publishing}
                    aria-label="Upload captions"
                  />
                </label>
                {attachCaptions ? (
                  <label className="flex w-36 flex-col gap-1.5">
                    <span>Language</span>
                    <Select
                      value={captionsLanguage}
                      onValueChange={setCaptionsLanguage}
                      disabled={disabled || publishing}
                    >
                      <SelectTrigger className="h-8 w-full" aria-label="Captions language">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CAPTION_LANGUAGES.map((lang) => (
                          <SelectItem key={lang.code} value={lang.code}>
                            {lang.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}
              </div>
            ) : null}
            {publishing ? (
              <div className="flex flex-col gap-1.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <div className="flex justify-between">
                  <span>
                    {job?.status === "attachingCaptions"
                      ? "Attaching captions…"
                      : job?.status === "cancelling"
                        ? "Cancelling…"
                        : `${Math.round(progress * 100)}% uploaded`}
                  </span>
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
                {job?.status === "uncertain" || job?.status === "failed"
                  ? "Publish again"
                  : "Publish to YouTube"}
              </Button>
            )}
            {resultUrl ? (
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  className="text-left font-medium text-primary underline-offset-2 hover:underline"
                  onClick={() => void openUrl(resultUrl)}
                >
                  Open on YouTube — {resultUrl}
                </button>
                {attachCaptions && captionsAvailable && !captionsAttached ? (
                  <span className="text-subtle-foreground">
                    The video is live; captions could not be attached.
                  </span>
                ) : null}
              </div>
            ) : null}
            {job?.status === "uncertain" ? (
              <span className="font-medium text-warning">
                {job.error?.message ??
                  "The upload finished but its result could not be confirmed — check your channel before retrying."}
              </span>
            ) : null}
            {job?.status === "failed" ? (
              <span className="font-medium text-warning">
                {job.error?.message ??
                  "Publish failed — retry uploads resume from where they stopped."}
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
