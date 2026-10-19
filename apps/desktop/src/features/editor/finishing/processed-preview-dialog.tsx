import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Progress,
  Skeleton,
} from "@recordforge/ui"
import { RefreshCw } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { toAssetUrl } from "../../../lib/assets"
import { toErrorMessage } from "../../../lib/errors"
import type { CanvasAspectRatio } from "@recordforge/contracts"

// Real processed preview through the export renderer — opt-in because it
// runs a full render pass (audio mastering, cards, webcam background,
// keystroke badges) rather than a cheap canvas approximation.
interface ProcessedPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Aspect ratios used ONLY for the building skeleton — the completed player
// sizes itself from the video's intrinsic dimensions once metadata loads.
const ASPECT_CSS: Record<CanvasAspectRatio, string> = {
  "16:9": "16 / 9",
  "9:16": "9 / 16",
  "1:1": "1 / 1",
  "4:5": "4 / 5",
  "5:4": "5 / 4",
}

// Errors from a media element apply only to the source that produced them —
// a new job/rebuilt file must be allowed to mount and report success again.
export interface MediaError {
  jobId: string
  src: string | null
  message: string
}

export type PreviewViewState =
  "empty" | "building" | "submission-error" | "job-error" | "playback-error" | "completed"

// An error raised for (jobId, src) only suppresses the player while the SAME
// job still shows the SAME source — a rebuilt job mounts fresh.
export function mediaErrorApplies(
  error: MediaError | null,
  jobId: string | undefined,
  src: string | null,
): string | null {
  if (!error || !jobId || !src) return null
  return error.jobId === jobId && error.src === src ? error.message : null
}

// Exactly one view at a time — a submission failure hides the previous
// result because the user just asked for a new one; an old completed job
// never shows beside a fresh error.
export function computePreviewView(input: {
  submissionError: string | null
  building: boolean
  job: { status: string } | null
  hasOutput: boolean
  activeVideoError: string | null
}): PreviewViewState {
  const { submissionError, building, job, hasOutput, activeVideoError } = input
  if (submissionError) return "submission-error"
  if (building) return "building"
  if (!job) return "empty"
  if (job.status === "completed" && hasOutput) {
    return activeVideoError ? "playback-error" : "completed"
  }
  if (job.status === "failed" || job.status === "cancelled") return "job-error"
  return "empty"
}

export function ProcessedPreviewDialog({ open, onOpenChange }: ProcessedPreviewDialogProps) {
  const job = useTimelineStore((state) => state.processedPreviewJob)
  const revision = useTimelineStore((state) => state.projectRevision)
  const builtRevision = useTimelineStore((state) => state.processedPreviewRevision)
  const builtAspect = useTimelineStore((state) => state.processedPreviewAspect)
  const isSubmitting = useTimelineStore((state) => state.isPreviewSubmitting)
  const submissionError = useTimelineStore((state) => state.previewSubmissionError)
  const requestProcessedPreview = useTimelineStore((state) => state.requestProcessedPreview)
  const cancelProcessedPreview = useTimelineStore((state) => state.cancelProcessedPreview)
  const workDir = useTimelineStore((state) => state.recording?.workDir)
  const container = useTimelineStore((state) => state.project?.exportSettings.container)

  const [videoError, setVideoError] = useState<MediaError | null>(null)
  const [captionError, setCaptionError] = useState<MediaError | null>(null)
  const [intrinsicSize, setIntrinsicSize] = useState<{ w: number; h: number } | null>(null)

  // Pause the timeline while the dialog is open so two audio sources can
  // never play at once; the preview itself never autoplays.
  useEffect(() => {
    if (open) useTimelineStore.getState().pause()
  }, [open])

  const hasOutput = job?.status === "completed" && !!job.outputs?.outputPath
  const videoSrc = useMemo(
    () =>
      hasOutput && job?.outputs.outputPath ? toAssetUrl(job.outputs.outputPath, workDir) : null,
    [hasOutput, job, workDir],
  )
  const captionsSrc = useMemo(
    () => (hasOutput ? toAssetUrl(job?.outputs.captionsPath ?? null, workDir) : null),
    [hasOutput, job, workDir],
  )

  // A playback error belongs to the (job, src) pair that raised it — when a
  // rebuild admits a new job or remaps the file, the stale error must not
  // keep the new <video> from mounting and loading.
  const activeVideoError = mediaErrorApplies(videoError, job?.id, videoSrc)
  const activeCaptionError = mediaErrorApplies(captionError, job?.id, captionsSrc)

  const building = isSubmitting || job?.status === "pending" || job?.status === "running"
  const view = computePreviewView({
    submissionError,
    building,
    job,
    hasOutput,
    activeVideoError,
  })

  // Edits after the build started make the result stale — show, don't guess.
  const stale = view === "completed" && builtRevision != null && revision > builtRevision

  const skeletonAspect = ASPECT_CSS[builtAspect ?? "16:9"] ?? "16 / 9"

  // React 19 callback-ref cleanup: runs on unmount AND before the ref is
  // re-issued for a replacement element — releases the file handle on
  // Windows instead of reading a possibly-replaced ref from an effect.
  // <track> children stay React-owned; `load()` aborts the resource
  // selection algorithm and frees the fetched media/caption data.
  const videoCallbackRef = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return
    return () => {
      el.pause()
      el.removeAttribute("src")
      el.load()
    }
  }, [])

  const onVideoError = () => {
    if (!job || !videoSrc) return
    setVideoError({
      jobId: job.id,
      src: videoSrc,
      message: "The preview file is no longer available — rebuild to render it again.",
    })
  }
  const onCaptionError = () => {
    if (!job || !captionsSrc) return
    setCaptionError({
      jobId: job.id,
      src: captionsSrc,
      message: "Captions couldn't be loaded for this preview — rebuild to regenerate them.",
    })
  }
  // Track error events don't bubble — a delegated React onError can miss
  // them entirely, so the track owns a direct listener via callback ref.
  // Checking readyState on mount also catches a track that failed before
  // React could attach.
  const trackCallbackRef = useCallback(
    (el: HTMLTrackElement | null) => {
      if (!el) return
      const reportError = () => onCaptionError()
      el.addEventListener("error", reportError)
      // readyState 3 = ERROR — a track that failed before the listener
      // attached still surfaces the warning.
      if (el.readyState === 3) reportError()
      return () => el.removeEventListener("error", reportError)
    },
    // onCaptionError reads `job`/`captionsSrc` — re-bound per render like
    // any inline handler; the ref only keeps the listener attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job?.id, captionsSrc],
  )
  const onVideoLoadedData = (el: HTMLVideoElement) => {
    if (job && videoSrc)
      setVideoError((e) => (e?.jobId === job.id && e.src === videoSrc ? null : e))
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      setIntrinsicSize({ w: el.videoWidth, h: el.videoHeight })
    }
  }

  const isAnimation = container === "gif" || container === "webp"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Finished video preview</DialogTitle>
          <DialogDescription>
            Local processed preview, up to 720p — export keeps your selected quality. Renders the
            real export pipeline: mastered audio, intro/outro cards, webcam background, and
            keystroke badges.
          </DialogDescription>
        </DialogHeader>

        {isAnimation ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-dim p-4 text-xs text-subtle-foreground">
            <p>
              Finishing effects need an MP4 output — animated GIF/WebP exports don't carry audio or
              rendered cards, so a processed preview isn't available for this container.
            </p>
          </div>
        ) : (
          <div className="flex min-h-70 flex-col gap-3" data-testid="preview-dialog-body">
            {view === "empty" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface-dim p-6 text-center">
                <p className="text-xs text-subtle-foreground">
                  Renders the current timeline through the export pipeline on demand — no upload, no
                  automatic render.
                </p>
                <Button onClick={() => void requestProcessedPreview()}>Build preview</Button>
              </div>
            ) : null}

            {view === "building" ? (
              <div className="flex flex-1 flex-col justify-center gap-3">
                <Skeleton
                  className="mx-auto w-full rounded-lg"
                  style={{ aspectRatio: skeletonAspect, maxHeight: "60vh" }}
                />
                <div className="flex items-center gap-3">
                  <Progress
                    value={Math.round((job?.progress ?? 0) * 100)}
                    className="flex-1"
                    aria-label="Preview render progress"
                  />
                  <span className="w-24 truncate text-ui-caption text-subtle-foreground">
                    {job?.stage ?? "Starting…"}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => void cancelProcessedPreview()}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {view === "submission-error" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface-dim p-6 text-center">
                <p className="text-xs text-subtle-foreground">{submissionError}</p>
                <Button variant="outline" onClick={() => void requestProcessedPreview()}>
                  <RefreshCw className="size-3.5" aria-hidden /> Retry
                </Button>
              </div>
            ) : null}

            {view === "job-error" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface-dim p-6 text-center">
                <p className="text-xs text-subtle-foreground">
                  {job?.error
                    ? toErrorMessage(job.error)
                    : job?.status === "cancelled"
                      ? "Preview cancelled."
                      : "Preview failed."}
                </p>
                <Button
                  variant="outline"
                  onClick={() => void requestProcessedPreview({ force: true })}
                >
                  <RefreshCw className="size-3.5" aria-hidden /> Retry
                </Button>
              </div>
            ) : null}

            {view === "playback-error" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface-dim p-6 text-center">
                <p className="text-xs text-subtle-foreground">{activeVideoError}</p>
                <Button
                  variant="outline"
                  onClick={() => void requestProcessedPreview({ force: true })}
                >
                  <RefreshCw className="size-3.5" aria-hidden /> Rebuild
                </Button>
              </div>
            ) : null}

            {view === "completed" && videoSrc ? (
              <div className="flex flex-col gap-2">
                {stale ? (
                  <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-1.5 text-ui-caption text-foreground">
                    Edits changed — rebuild the preview to see them.
                  </p>
                ) : null}
                {activeCaptionError ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-1.5">
                    <p className="text-ui-caption text-foreground">{activeCaptionError}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void requestProcessedPreview({ force: true })}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
                <video
                  ref={videoCallbackRef}
                  src={videoSrc}
                  controls
                  playsInline
                  preload="metadata"
                  crossOrigin="anonymous"
                  onError={onVideoError}
                  onLoadedData={(e) => onVideoLoadedData(e.currentTarget)}
                  className="mx-auto max-w-full rounded-lg bg-black object-contain"
                  style={{
                    aspectRatio: intrinsicSize
                      ? `${intrinsicSize.w} / ${intrinsicSize.h}`
                      : skeletonAspect,
                    maxHeight: "60vh",
                    width: intrinsicSize ? "auto" : "100%",
                  }}
                >
                  {captionsSrc ? (
                    <track
                      ref={trackCallbackRef}
                      kind="captions"
                      src={captionsSrc}
                      default
                      label="Captions"
                    />
                  ) : null}
                </video>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ui-caption text-subtle-foreground">
                    Processed preview — export renders at full quality.
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void requestProcessedPreview({ force: true })}
                  >
                    <RefreshCw className="size-3.5" aria-hidden /> Rebuild
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
