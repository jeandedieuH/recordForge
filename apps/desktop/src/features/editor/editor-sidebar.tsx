import type { LucideIcon } from "lucide-react"
import { Captions, FileOutput, LayoutTemplate, LibraryBig, Sparkles } from "lucide-react"
import type { LibraryRecording, MediaMetadata, TimelineState } from "@recordforge/contracts"
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@recordforge/ui"
import type {
  DerivativeResource,
  WaveformResources,
  ThumbnailManifest,
} from "./media/derivative-resources"

interface EditorSidebarProps {
  timeline: TimelineState | null
  recording: LibraryRecording | null
  metadata: MediaMetadata | null
  thumbnailResource: DerivativeResource<ThumbnailManifest> & { retry: () => void }
  waveformResources: WaveformResources
  onOpenExport?: () => void
  onReturnToLibrary?: () => void
}

interface SidebarTab {
  value: string
  label: string
  icon: LucideIcon
}

const SIDEBAR_TABS: SidebarTab[] = [
  { value: "media", label: "Media", icon: LibraryBig },
  { value: "captions", label: "Captions", icon: Captions },
  { value: "effects", label: "Effects", icon: Sparkles },
  { value: "layouts", label: "Layouts", icon: LayoutTemplate },
  { value: "exports", label: "Exports", icon: FileOutput },
]

export function EditorSidebar({
  timeline,
  recording,
  metadata,
  thumbnailResource,
  waveformResources,
  onOpenExport,
  onReturnToLibrary,
}: EditorSidebarProps) {
  return (
    <aside
      className="hidden w-60 shrink-0 border-r border-border bg-surface lg:flex"
      aria-label="Editor tools"
    >
      <Tabs defaultValue="media" orientation="vertical" className="flex min-h-0 w-full flex-col">
        <TabsList className="flex h-auto w-full shrink-0 flex-col items-stretch gap-1 rounded-none border-0 border-b border-border bg-surface-dim p-2">
          {SIDEBAR_TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="h-8 shrink-0 justify-start px-2 text-[11px]"
                aria-label={`${tab.label} tools`}
              >
                <Icon aria-hidden />
                <span>{tab.label}</span>
              </TabsTrigger>
            )
          })}
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TabsContent value="media" className="flex flex-col gap-4">
            <PanelHeading
              icon={LibraryBig}
              title="Media"
              description="Prepared derivatives for this project."
            />
            <div className="flex flex-col gap-2">
              <InfoCard label="Source" value={recording?.name ?? "Recording"} />
              <InfoCard
                label="Metadata"
                value={
                  metadata ? `${metadata.width ?? "—"} × ${metadata.height ?? "—"}` : "Unavailable"
                }
              />
              <InfoCard
                label="Duration"
                value={metadata ? formatDuration(metadata.durationMs) : "Unavailable"}
              />
            </div>
            <DerivativeCard
              label="Thumbnails"
              resource={thumbnailResource}
              onRetry={thumbnailResource.retry}
              onEmpty={onReturnToLibrary}
            />
            <DerivativeCard
              label="Waveform peaks"
              resource={{ status: waveformResources.status }}
              onRetry={waveformResources.retry}
              onEmpty={onReturnToLibrary}
            />
          </TabsContent>

          <TabsContent value="captions">
            <EmptyState
              icon={Captions}
              title="Captions are not available yet"
              description="This project has no caption cues. Caption editing will appear here when a captions track is added."
            />
          </TabsContent>

          <TabsContent value="effects">
            <EmptyState
              icon={Sparkles}
              title="No effects applied"
              description="Effects stay non-destructive and will appear here when an effect track is added."
            />
          </TabsContent>

          <TabsContent value="layouts" className="flex flex-col gap-4">
            <PanelHeading
              icon={LayoutTemplate}
              title="Canvas layout"
              description="The output canvas used by preview and export."
            />
            {timeline ? (
              <div className="grid grid-cols-2 gap-2">
                <InfoCard label="Width" value={`${timeline.canvas.width}px`} />
                <InfoCard label="Height" value={`${timeline.canvas.height}px`} />
                <InfoCard label="Frame rate" value={`${timeline.canvas.fps} fps`} />
                <InfoCard label="Tracks" value={String(timeline.tracks.length)} />
              </div>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
            <p className="text-xs leading-relaxed text-subtle-foreground">
              Select a clip to edit its placement, audio, or source range in the inspector.
            </p>
          </TabsContent>

          <TabsContent value="exports" className="flex flex-col gap-4">
            <PanelHeading
              icon={FileOutput}
              title="Export"
              description="Render the saved timeline to a local MP4."
            />
            <div className="rounded-lg border border-border bg-surface-dim p-3 text-xs text-subtle-foreground">
              <div className="flex items-center justify-between gap-3">
                <span>Preset</span>
                <Badge variant="outline">Default MP4</Badge>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span>Duration</span>
                <span className="font-mono tabular-nums text-foreground">
                  {timeline ? formatDuration(getTimelineDuration(timeline)) : "—"}
                </span>
              </div>
            </div>
            {onOpenExport ? (
              <Button variant="secondary" onClick={onOpenExport}>
                Open export settings
              </Button>
            ) : null}
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  )
}

function PanelHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="size-4 text-primary" aria-hidden />
        <h2>{title}</h2>
      </div>
      <p className="text-xs leading-relaxed text-subtle-foreground">{description}</p>
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-dim px-2.5 py-2 text-xs">
      <span className="text-subtle-foreground">{label}</span>
      <span className="max-w-32 truncate text-right font-medium text-foreground" title={value}>
        {value}
      </span>
    </div>
  )
}

function DerivativeCard({
  label,
  resource,
  onRetry,
  onEmpty,
}: {
  label: string
  resource: { status: "loading" | "missing" | "content" | "error"; message?: string }
  onRetry: () => void
  onEmpty?: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {resource.status === "content" ? <Badge variant="success">Ready</Badge> : null}
      </div>
      {resource.status === "loading" ? <Skeleton className="h-5 w-full" /> : null}
      {resource.status === "missing" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Not prepared for this recording.
          </p>
          {onEmpty ? (
            <Button variant="ghost" size="sm" onClick={onEmpty}>
              Return to library
            </Button>
          ) : null}
        </div>
      ) : null}
      {resource.status === "error" ? (
        <div className="flex items-center justify-between gap-2 text-[11px] text-warning">
          <span>Derivative unavailable.</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function getTimelineDuration(timeline: TimelineState): number {
  return timeline.tracks.reduce(
    (duration, track) =>
      Math.max(duration, ...track.clips.map((clip) => clip.startMs + clip.durationMs)),
    0,
  )
}
