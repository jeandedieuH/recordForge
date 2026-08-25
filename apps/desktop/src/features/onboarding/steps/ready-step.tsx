import { CheckCircle2, Flag, Keyboard, Video } from "lucide-react"
import { Badge, Button, Kbd } from "@recordforge/ui"

interface ReadyStepProps {
  onStartRecording?: () => void
  onFinish: () => void
}

export function ReadyStep({ onStartRecording, onFinish }: ReadyStepProps) {
  return (
    <div className="flex flex-col gap-5 text-foreground">
      {/* Header Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-linear-to-br from-surface via-surface to-surface-dim p-5 sm:p-6 shadow-e2">
        <div className="absolute top-0 right-0 -mr-10 -mt-10 size-40 rounded-full bg-success/15 blur-2xl pointer-events-none" />

        <div className="flex items-center gap-3.5">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-success/15 text-success ring-1 ring-success/30">
            <CheckCircle2 className="size-6" />
          </div>
          <div className="space-y-0.5">
            <h2 className="font-serif text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              You're Ready to Record!
            </h2>
            <p className="text-xs sm:text-sm text-subtle-foreground">
              Your hardware profiles, audio devices, and cursor telemetry are configured and ready.
            </p>
          </div>
        </div>
      </div>

      {/* Global Shortcut Quick Reference */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Keyboard className="size-4 text-primary" />
            <span>Essential Keyboard Shortcuts</span>
          </div>
          <Badge variant="outline" className="text-[11px] px-2 py-0.5 font-mono">
            Global Windows Hotkeys
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex flex-col justify-between rounded-xl border border-border bg-surface/70 p-3.5 space-y-2.5 shadow-e1 hover:border-primary/40 transition-colors">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <span className="size-2 rounded-full bg-recording animate-pulse" />
              <span>Record / Stop</span>
            </div>
            <p className="text-[11px] text-subtle-foreground">
              Start or finalize recording instantly from anywhere in Windows.
            </p>
            <div className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <span className="text-xs text-subtle-foreground">+</span>
              <Kbd>Shift</Kbd>
              <span className="text-xs text-subtle-foreground">+</span>
              <Kbd>R</Kbd>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-border bg-surface/70 p-3.5 space-y-2.5 shadow-e1 hover:border-primary/40 transition-colors">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <span className="size-2 rounded-full bg-warning" />
              <span>Pause / Resume</span>
            </div>
            <p className="text-[11px] text-subtle-foreground">
              Temporarily freeze capture without splitting your video file.
            </p>
            <div className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <span className="text-xs text-subtle-foreground">+</span>
              <Kbd>Shift</Kbd>
              <span className="text-xs text-subtle-foreground">+</span>
              <Kbd>P</Kbd>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-border bg-surface/70 p-3.5 space-y-2.5 shadow-e1 hover:border-primary/40 transition-colors">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Flag className="size-3 text-info" />
              <span>Add Marker</span>
            </div>
            <p className="text-[11px] text-subtle-foreground">
              Drop milestone markers on the fly for fast timeline navigation.
            </p>
            <div className="flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <span className="text-xs text-subtle-foreground">+</span>
              <Kbd>Shift</Kbd>
              <span className="text-xs text-subtle-foreground">+</span>
              <Kbd>M</Kbd>
            </div>
          </div>
        </div>
      </div>

      {/* Editor Shortcuts Bar */}
      <div className="rounded-xl border border-border/80 bg-surface-dim/70 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-subtle-foreground">
        <span className="font-medium text-foreground">Timeline Editor Keys:</span>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Kbd>Space</Kbd>
            <span>Play/Pause</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Kbd>S</Kbd>
            <span>Split Clip</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Kbd>Del</Kbd>
            <span>Ripple Delete</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Kbd>Z</Kbd>
            <span>Undo</span>
          </div>
        </div>
      </div>

      {/* Launch Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        <span className="text-xs text-subtle-foreground">
          Tip: You can re-open this tour anytime in <strong>Settings</strong> or{" "}
          <strong>About</strong>.
        </span>

        <div className="flex items-center gap-3 self-end sm:self-center">
          <Button variant="outline" size="sm" onClick={onFinish} className="text-xs">
            Explore Library
          </Button>

          {onStartRecording && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onFinish()
                onStartRecording()
              }}
              className="text-xs gap-1.5 bg-primary text-white hover:bg-primary/90 shadow-sm"
            >
              <Video className="size-3.5" />
              Start First Recording
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
