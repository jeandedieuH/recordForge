import { RefreshCw, ShieldOff, Video, VideoOff, Webcam } from "lucide-react"
import { Button, Skeleton } from "@recordforge/ui"
import type { CameraPreviewState } from "./use-camera-preview"

interface CameraStateViewProps {
  state: Exclude<CameraPreviewState, "idle" | "active">
  onRetry: () => void
}

const STATE_COPY: Record<
  Exclude<CameraPreviewState, "idle" | "loading" | "active">,
  { icon: typeof VideoOff; title: string; body: string; action: string }
> = {
  unavailable: {
    icon: Webcam,
    title: "Preview unavailable",
    body: "RecordForge can still record this camera — the live preview just can't open it here.",
    action: "Try again",
  },
  empty: {
    icon: VideoOff,
    title: "No camera found",
    body: "Connect a camera, or check that apps are allowed to use the camera in Windows Settings → Privacy & security → Camera.",
    action: "Refresh",
  },
  blocked: {
    icon: ShieldOff,
    title: "Camera access is blocked",
    body: "Allow camera access for desktop apps in Windows Settings → Privacy & security → Camera, then try again.",
    action: "Try again",
  },
  "in-use": {
    icon: Webcam,
    title: "Camera is in use",
    body: "Another app is using this camera. Close it, then try again.",
    action: "Try again",
  },
  error: {
    icon: VideoOff,
    title: "Couldn't open the camera",
    body: "Something went wrong while starting the preview.",
    action: "Try again",
  },
}

// Centre content for every non-active preview state (four-states pattern:
// skeleton -> content | empty | error + retry).
export function CameraStateView({ state, onRetry }: CameraStateViewProps) {
  if (state === "loading") {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        <Skeleton className="absolute inset-0 rounded-none bg-overlay/80" />
        <Video className="relative z-10 size-8 text-subtle-foreground motion-safe:animate-pulse" />
      </div>
    )
  }

  const copy = STATE_COPY[state]
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
      <copy.icon className="size-8 text-subtle-foreground" aria-hidden />
      <p className="text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="max-w-xs text-xs text-subtle-foreground">{copy.body}</p>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRetry}
        className="mt-1 cursor-pointer gap-1.5 border-border bg-surface-dim text-xs text-muted-foreground hover:bg-overlay hover:text-foreground"
      >
        <RefreshCw className="size-3.5" aria-hidden />
        {copy.action}
      </Button>
    </div>
  )
}
