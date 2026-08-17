import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { MediaJob, ProjectAsset } from "@recordforge/contracts"
import {
  createAddExternalAudioClipCommand,
  createAddImageClipCommand,
} from "@recordforge/editor-core"
import {
  FileAudio,
  FileImage,
  FileVideo,
  FolderOpen,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react"
import { Button, Card, CardContent, EmptyState, Skeleton, cn, useToast } from "@recordforge/ui"
import { deleteAsset, importAssets, startAssetDerivativeJob } from "../../../lib/assets"
import { onMediaJobUpdate, listMediaJobs } from "../../../lib/media"
import { loadProject } from "../../../lib/project"
import { toErrorMessage } from "../../../lib/errors"
import { isTauri } from "../../../lib/settings"
import { useTimelineStore } from "../../../stores/timeline-store"
import { assetDurationMs, createImageClipForAsset } from "../assets/asset-clip-factory"
import { toAssetUrl } from "../media/derivative-resources"

const IMPORT_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "svg",
  "mp3",
  "wav",
  "aac",
  "m4a",
  "flac",
  "ogg",
  "opus",
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
]

const BUILTIN_ROLES = new Set([
  "screen",
  "microphone",
  "system_audio",
  "webcam",
  "cursor_events",
  "caption",
])

type AssetFilter = "all" | "audio" | "image" | "video"
type RoleFilter = "all" | "music" | "graphic" | "audio_track" | "b_roll"

function assetIcon(asset: ProjectAsset) {
  if (asset.kind === "audio") return FileAudio
  if (asset.kind === "video") return FileVideo
  return FileImage
}

function assetLabel(asset: ProjectAsset): string {
  return asset.path.split(/[\\/]/).pop() ?? asset.id
}

function jobForAsset(asset: ProjectAsset, jobs: MediaJob[]): MediaJob | undefined {
  return jobs.find((job) => job.outputs.assetId === asset.id)
}

function audioRoleForAsset(asset: ProjectAsset): "music" | "other" {
  return asset.role === "music" ? "music" : "other"
}

export function ProjectAssetsPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const assetListRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<AssetFilter>("all")
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all")
  const [isImporting, setIsImporting] = useState(false)
  const [isLoadingJobs, setIsLoadingJobs] = useState(false)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<MediaJob[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const { toast } = useToast()

  const recording = useTimelineStore((state) => state.recording)
  const project = useTimelineStore((state) => state.project)
  const timeline = useTimelineStore((state) => state.engine?.history.present ?? null)
  const assetPaths = useTimelineStore((state) => state.assetPaths)
  const playheadMs = useTimelineStore((state) => state.view.playheadMs)
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const syncProject = useTimelineStore((state) => state.syncProject)
  const refreshAssetPaths = useTimelineStore((state) => state.refreshAssetPaths)
  const relinkAsset = useTimelineStore((state) => state.relinkAsset)

  const refreshJobs = useCallback(async () => {
    if (!recording) return
    setIsLoadingJobs(true)
    setJobsError(null)
    try {
      const nextJobs = await listMediaJobs(recording.id)
      setJobs(nextJobs.filter((job) => job.kind === "asset_derivative"))
    } catch (error) {
      setJobs([])
      setJobsError(toErrorMessage(error))
    } finally {
      setIsLoadingJobs(false)
    }
  }, [recording])

  useEffect(() => {
    void refreshJobs()
    if (!recording || !isTauri()) return

    let isMounted = true
    let unlisten: (() => void) | null = null
    void onMediaJobUpdate((job) => {
      if (!isMounted || job.recordingId !== recording.id || job.kind !== "asset_derivative") return
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)])
      if (job.status === "completed") {
        void loadProject(recording.id).then((loaded) => {
          if (loaded) syncProject(loaded.project)
          return refreshAssetPaths()
        })
      }
    }).then((cleanup) => {
      if (isMounted) unlisten = cleanup
      else cleanup()
    })

    return () => {
      isMounted = false
      unlisten?.()
    }
  }, [recording, refreshAssetPaths, refreshJobs, syncProject])

  const assets = useMemo(() => {
    const candidates = project?.assets ?? []
    return candidates.filter(
      (asset) =>
        (filter === "all" || asset.kind === filter) &&
        (roleFilter === "all" || asset.role === roleFilter),
    )
  }, [filter, project?.assets, roleFilter])

  const virtualizer = useVirtualizer({
    count: assets.length,
    getScrollElement: () => assetListRef.current,
    estimateSize: () => 76,
    overscan: 8,
  })

  async function handleImport() {
    if (!isTauri() || !recording) {
      fileInputRef.current?.click()
      if (!isTauri()) {
        toast({
          title: "Desktop import required",
          description: "Run the RecordForge desktop app to persist project assets.",
        })
      }
      return
    }

    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Media", extensions: IMPORT_EXTENSIONS }],
    })
    const paths = selected ? (Array.isArray(selected) ? selected : [selected]) : []
    if (paths.length === 0) return

    setIsImporting(true)
    try {
      const result = await importAssets({
        recordingId: recording.id,
        paths,
        strategy: "copy",
      })
      syncProject(result.project)
      await Promise.all([refreshAssetPaths(), refreshJobs()])
      toast({
        title: "Assets imported",
        description: `${result.imported.length} asset${result.imported.length === 1 ? "" : "s"} added to the project bin.`,
      })
      if (result.skipped.length > 0 || result.warnings.length > 0) {
        toast({
          title: "Some assets were skipped",
          description: [
            ...result.skipped.map((item) => `${item.sourceName}: ${item.reason}`),
            ...result.warnings,
          ].join(" "),
        })
      }
    } catch (error) {
      toast({
        title: "Import failed",
        description:
          error instanceof Error ? error.message : "The selected assets could not be imported.",
      })
    } finally {
      setIsImporting(false)
    }
  }

  function handleFallbackFileInput() {
    const files = fileInputRef.current?.files
    if (!files || files.length === 0) return
    toast({
      title: "Choose files from the desktop dialog",
      description: "Browser file handles are not persisted; use Import from the desktop build.",
    })
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function addAssetAtPlayhead(asset: ProjectAsset) {
    if (!timeline || !recording) return
    const startMs = Math.round(playheadMs)
    if (asset.kind === "audio") {
      const durationMs = assetDurationMs(asset, 30_000)
      const audioTrack = timeline.tracks.find(
        (track) => track.kind === "audio" && track.name.toLowerCase().includes("music"),
      )
      const ok = execute(
        createAddExternalAudioClipCommand(asset.id, startMs, durationMs, {
          sourceInMs: 0,
          sourceOutMs: durationMs,
          role: audioRoleForAsset(asset),
          trackId: audioTrack?.id,
          trackName: audioTrack?.name ?? "Background Music",
        }),
      )
      if (ok) {
        toast({ title: "Audio added", description: `Added ${assetLabel(asset)} at the playhead.` })
      }
      return
    }

    if (asset.kind === "image") {
      const clip = createImageClipForAsset(asset, startMs, timeline.canvas)
      const graphicsTrack = timeline.tracks.find((track) => track.kind === "graphics")
      const ok = execute(createAddImageClipCommand(clip, graphicsTrack?.id))
      if (ok) {
        setSelection({ kind: "clip", clipIds: [clip.id], primaryClipId: clip.id })
        toast({
          title: "Image overlay added",
          description: `Added ${assetLabel(asset)} at the playhead.`,
        })
      }
    }
  }

  async function handleDelete(asset: ProjectAsset) {
    if (!recording || BUILTIN_ROLES.has(asset.role)) return
    try {
      await deleteAsset({ recordingId: recording.id, assetId: asset.id })
      const loaded = await loadProject(recording.id)
      if (loaded) syncProject(loaded.project)
      await Promise.all([refreshAssetPaths(), refreshJobs()])
      toast({
        title: "Asset removed",
        description: `${assetLabel(asset)} was removed from the project bin.`,
      })
    } catch (error) {
      toast({
        title: "Asset could not be removed",
        description:
          error instanceof Error ? error.message : "The asset may still be used on the timeline.",
      })
    }
  }

  async function handleRelink(asset: ProjectAsset) {
    if (!recording || !isTauri()) return
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Media", extensions: IMPORT_EXTENSIONS }],
    })
    const newPath = typeof selected === "string" ? selected : null
    if (!newPath) return
    await relinkAsset(asset.id, newPath)
    await Promise.all([refreshAssetPaths(), refreshJobs()])
  }

  async function handleRegenerate(asset: ProjectAsset) {
    if (!recording) return
    try {
      await startAssetDerivativeJob({
        recordingId: recording.id,
        assetId: asset.id,
        force: true,
      })
      await refreshJobs()
      toast({
        title: "Derivative job queued",
        description: `Refreshing ${assetLabel(asset)} in the background.`,
      })
    } catch (error) {
      toast({
        title: "Derivative job failed to start",
        description:
          error instanceof Error ? error.message : "Try again after the asset is available.",
      })
    }
  }

  function handleDragStart(event: React.DragEvent<HTMLDivElement>, asset: ProjectAsset) {
    event.dataTransfer.effectAllowed = "copy"
    event.dataTransfer.setData("application/x-recordforge-asset", asset.id)
    event.dataTransfer.setData("text/plain", asset.id)
  }

  if (!recording || !project) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState
          icon={FolderOpen}
          title="No project assets"
          description="Open a recording to import audio, images, or video overlays."
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={IMPORT_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
        className="hidden"
        onChange={handleFallbackFileInput}
      />

      <div className="border-b border-border p-3 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-info/15 text-info">
            <FolderOpen className="size-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">Project Assets</h3>
            <p className="text-[11px] text-muted-foreground">Persistent media for this project</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleImport()}
          disabled={isImporting}
          className="mt-3 h-8 w-full gap-1.5 text-xs"
        >
          {isImporting ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Upload className="size-3.5" aria-hidden />
          )}
          Import media
        </Button>
        <div className="mt-2 flex items-center gap-1 rounded-lg bg-surface-dim p-1">
          {(["all", "audio", "image", "video"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                "flex-1 rounded-md py-1 text-[11px] font-medium capitalize transition-colors",
                filter === value
                  ? "bg-surface text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value} (
              {value === "all"
                ? project.assets.length
                : project.assets.filter((asset) => asset.kind === value).length}
              )
            </button>
          ))}
        </div>
        <label className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>Role</span>
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}
            className="h-7 rounded-md border border-border bg-surface-dim px-2 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Filter assets by role"
          >
            <option value="all">All roles</option>
            <option value="music">Music</option>
            <option value="graphic">Graphic</option>
            <option value="audio_track">Audio track</option>
            <option value="b_roll">B-roll</option>
          </select>
        </label>
      </div>

      <div
        className={cn(
          "mx-3 mt-3 flex items-center justify-center rounded-xl border-2 border-dashed p-3 text-center transition-colors",
          isDragging ? "border-primary bg-primary/10" : "border-border bg-surface-dim",
        )}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault()
            setIsDragging(true)
          }
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragging(false)
          void handleImport()
        }}
      >
        <div>
          <Upload className="mx-auto mb-1 size-5 text-muted-foreground" aria-hidden />
          <p className="text-xs font-medium text-foreground">Import audio, images, or video</p>
          <p className="text-[10px] text-muted-foreground">
            Files are copied into the project by default
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
          <span>Asset bin ({assets.length})</span>
          {isLoadingJobs ? <Skeleton className="h-3 w-12" /> : null}
        </div>
        {jobsError ? (
          <div
            className="flex items-center justify-between gap-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] text-foreground"
            role="alert"
          >
            <span className="truncate">Derivative status unavailable</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refreshJobs()}
              className="h-6 px-1.5 text-[10px]"
            >
              Retry
            </Button>
          </div>
        ) : null}
        {assets.length > 0 ? (
          <div ref={assetListRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const asset = assets[virtualItem.index]
                const Icon = assetIcon(asset)
                const job = jobForAsset(asset, jobs)
                const resolvedPath = assetPaths[asset.id] ?? asset.path
                const thumbnailUrl = asset.kind === "image" ? toAssetUrl(resolvedPath) : null
                const isInUse = Boolean(
                  timeline?.tracks.some((track) =>
                    track.clips.some((clip) => clip.assetId === asset.id),
                  ),
                )
                const canAdd = asset.kind === "audio" || asset.kind === "image"
                return (
                  <div
                    key={asset.id}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute left-0 top-0 w-full pb-2"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <Card
                      draggable={canAdd && asset.status !== "missing"}
                      onDragStart={(event) => handleDragStart(event, asset)}
                      className="overflow-hidden border-border bg-surface-container"
                    >
                      <CardContent className="flex items-center gap-2.5 p-2.5">
                        <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-dim text-muted-foreground">
                          {thumbnailUrl ? (
                            <img src={thumbnailUrl} alt="" className="size-full object-cover" />
                          ) : (
                            <Icon className="size-5" aria-hidden />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate text-xs font-semibold text-foreground"
                            title={assetLabel(asset)}
                          >
                            {assetLabel(asset)}
                          </p>
                          <p className="truncate text-[10px] text-muted-foreground">
                            {asset.status === "missing"
                              ? "Missing source"
                              : `${asset.kind ?? "media"} • ${asset.role}`}
                          </p>
                          {job && (job.status === "pending" || job.status === "running") ? (
                            <div
                              role="progressbar"
                              aria-valuenow={Math.round(job.progress * 100)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`Derivative progress for ${assetLabel(asset)}`}
                              className="mt-1 flex items-center gap-1 text-[10px] text-info"
                            >
                              <LoaderCircle className="size-3 animate-spin" aria-hidden />
                              Derivatives {Math.round(job.progress * 100)}%
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {asset.status === "missing" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Relink ${assetLabel(asset)}`}
                              title="Relink asset"
                              onClick={() => void handleRelink(asset)}
                              className="size-7 p-0"
                            >
                              <RefreshCw className="size-3.5" aria-hidden />
                            </Button>
                          ) : canAdd ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Add ${assetLabel(asset)} at playhead`}
                              title="Add at playhead"
                              onClick={() => addAssetAtPlayhead(asset)}
                              className="size-7 p-0"
                            >
                              <Plus className="size-4" aria-hidden />
                            </Button>
                          ) : null}
                          {asset.status !== "missing" &&
                          canAdd &&
                          !job?.outputs.derivatives.thumbnail ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Generate derivatives for ${assetLabel(asset)}`}
                              title="Generate derivatives"
                              onClick={() => void handleRegenerate(asset)}
                              className="size-7 p-0"
                            >
                              <RefreshCw className="size-3.5" aria-hidden />
                            </Button>
                          ) : null}
                          {!BUILTIN_ROLES.has(asset.role) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Delete ${assetLabel(asset)}`}
                              title={isInUse ? "Asset is in use" : "Delete asset"}
                              disabled={isInUse}
                              onClick={() => void handleDelete(asset)}
                              className="size-7 p-0 text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={ImagePlus}
            title="Asset bin is empty"
            description="Import media to make it available for timeline clips."
            action={
              <Button size="sm" onClick={() => void handleImport()}>
                Import media
              </Button>
            }
            className="border border-dashed border-border bg-surface-dim p-4"
          />
        )}
      </div>
    </div>
  )
}
