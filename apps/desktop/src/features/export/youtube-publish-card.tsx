import { useEffect, useState } from "react"
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
import type { MediaJob, TimelineMarker, YouTubePrivacy } from "@recordforge/contracts"
import { formatYouTubeChapters } from "@recordforge/editor-core"

interface YouTubePublishCardProps {
  exportJob: MediaJob | null
  projectName: string
  markers: TimelineMarker[]
  disabled?: boolean
}

type PublishState = "idle" | "connecting" | "uploading" | "done" | "failed"

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
  const [state, setState] = useState<PublishState>("idle")
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  const outputPath = exportJob?.status === "completed" ? exportJob.outputs.outputPath : null
  const captionsPath = exportJob?.status === "completed" ? exportJob.outputs.captionsPath : null

  useEffect(() => {
    void youtubeConnectionStatus().then((status) => {
      setConnected(status.connected)
      setAccountLabel(status.accountLabel)
    })
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
        captionsLanguage: "en",
      })
      setVideoUrl(result.url)
      setState("done")
      toast({ title: "Published to YouTube", description: result.url })
    } catch (error) {
      setState("failed")
      toast({
        title: "YouTube publish failed",
        description: error instanceof Error ? error.message : "publish failed",
        variant: "warning",
      })
    }
  }

  if (!outputPath) return null

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
              void disconnectYouTube().then(() => {
                setConnected(false)
                setAccountLabel(null)
              })
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
            <label className="flex flex-col gap-1.5">
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
            {captionsPath ? (
              <label className="flex items-center justify-between">
                <span>Upload captions (.srt sidecar)</span>
                <Switch
                  checked={attachCaptions}
                  onCheckedChange={setAttachCaptions}
                  disabled={disabled || state === "uploading"}
                  aria-label="Upload captions"
                />
              </label>
            ) : null}
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
                    onClick={() => void cancelYouTubePublish()}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <Button disabled={disabled || !title.trim()} onClick={() => void handlePublish()}>
                Publish to YouTube
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
          </>
        )}
      </div>
    </div>
  )
}
