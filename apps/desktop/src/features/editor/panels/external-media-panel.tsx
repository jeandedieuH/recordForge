import { useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  createAddExternalAudioClipCommand,
  createAddImageClipCommand,
} from "@recordforge/editor-core"
import type { ImageClip } from "@recordforge/contracts"
import { useTimelineStore } from "../../../stores/timeline-store"
import { Button, Card, CardContent, useToast, cn } from "@recordforge/ui"
import { FileAudio, FileImage, FolderOpen, Music, Plus, Trash2, Upload } from "lucide-react"

export interface ExternalMediaItem {
  id: string
  name: string
  kind: "audio" | "image"
  path: string
  url?: string
  sizeBytes?: number
  durationMs?: number
  width?: number
  height?: number
  role?: "music" | "sound_effect" | "voiceover" | "graphic"
}

export function ExternalMediaPanel() {
  const [mediaItems, setMediaItems] = useState<ExternalMediaItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaListRef = useRef<HTMLDivElement>(null)
  const [importType, setImportType] = useState<"all" | "audio" | "image">("all")

  const engine = useTimelineStore((state) => state.engine)
  const view = useTimelineStore((state) => state.view)
  const execute = useTimelineStore((state) => state.execute)
  const setSelection = useTimelineStore((state) => state.setSelection)
  const { toast } = useToast()

  const timeline = engine?.history.present

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    const newItems: ExternalMediaItem[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const isAudio =
        file.type.startsWith("audio/") || /\.(mp3|wav|aac|m4a|flac|ogg)$/i.test(file.name)
      const isImage =
        file.type.startsWith("image/") || /\.(png|jpe?g|svg|webp|gif)$/i.test(file.name)

      if (isAudio) {
        const id = `asset:audio:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const url = URL.createObjectURL(file)
        newItems.push({
          id,
          name: file.name,
          kind: "audio",
          path: file.name,
          url,
          sizeBytes: file.size,
          durationMs: 30000, // Default duration fallback
          role: "music",
        })
      } else if (isImage) {
        const id = `asset:image:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const url = URL.createObjectURL(file)
        newItems.push({
          id,
          name: file.name,
          kind: "image",
          path: file.name,
          url,
          sizeBytes: file.size,
          width: 400,
          height: 300,
          role: "graphic",
        })
      }
    }

    if (newItems.length > 0) {
      setMediaItems((prev) => [...prev, ...newItems])
      toast({
        title: "Media imported",
        description: `Imported ${newItems.length} media ${newItems.length === 1 ? "file" : "files"} into project assets.`,
        variant: "default",
      })
    }
  }

  function handleAddToTimeline(item: ExternalMediaItem) {
    const startMs = Math.round(view.playheadMs)

    if (item.kind === "audio") {
      const durationMs = item.durationMs ?? 30000
      const audioTrack = timeline?.tracks.find(
        (t) => t.kind === "audio" && t.name.toLowerCase().includes("music"),
      )
      const ok = execute(
        createAddExternalAudioClipCommand(item.id, startMs, durationMs, {
          sourceInMs: 0,
          sourceOutMs: durationMs,
          volume: 0.8,
          role: item.role as any,
          trackName: "Background Music",
          trackId: audioTrack?.id,
        }),
      )
      if (ok) {
        toast({
          title: "Audio track added",
          description: `Added "${item.name}" to the timeline at ${Math.round(startMs / 1000)}s`,
        })
      }
    } else if (item.kind === "image") {
      const durationMs = 4000
      const graphicsTrack = timeline?.tracks.find((t) => t.kind === "graphics")
      const clipId = `image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const clip: ImageClip = {
        id: clipId,
        assetId: item.id,
        kind: "image",
        startMs,
        durationMs,
        sourceInMs: 0,
        sourceOutMs: durationMs,
        speed: 1,
        x: 80,
        y: 80,
        width: 320,
        height: 200,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        zIndex: 0,
        opacity: 1,
        borderRadius: 8,
        borderWidth: 0,
        borderColor: "#ffffff",
        shadowEnabled: true,
        shadowColor: "rgba(0, 0, 0, 0.5)",
        shadowBlur: 12,
        fit: "contain",
        animationIn: "fade",
        animationOut: "fade",
        overlayAnimation: {
          inType: "fade",
          outType: "fade",
          inDurationMs: 350,
          outDurationMs: 350,
          easing: "expo-out",
        },
        enabled: true,
        locked: false,
      }
      const ok = execute(createAddImageClipCommand(clip, graphicsTrack?.id))
      if (ok) {
        setSelection({
          kind: "clip",
          clipIds: [clip.id],
          primaryClipId: clip.id,
        })
        toast({
          title: "Image overlay added",
          description: `Added "${item.name}" to the timeline at ${Math.round(startMs / 1000)}s`,
        })
      }
    }
  }

  function handleRemoveItem(id: string) {
    setMediaItems((prev) => prev.filter((item) => item.id !== id))
  }

  const filteredItems = mediaItems.filter((item) => {
    if (importType === "all") return true
    return item.kind === importType
  })
  const mediaVirtualizer = useVirtualizer({
    count: filteredItems.length,
    getScrollElement: () => mediaListRef.current,
    estimateSize: () => 58,
    overscan: 8,
  })

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="audio/*,image/*,.mp3,.wav,.aac,.flac,.m4a,.png,.jpg,.jpeg,.svg,.webp,.gif"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {/* Header */}
      <div className="border-b border-border p-3.5 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-info/15 text-info">
              <FolderOpen className="size-4" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">External Media</h3>
              <p className="text-[11px] text-muted-foreground">
                Import audio tracks & image overlays
              </p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 gap-1.5 text-xs bg-surface-dim border-border hover:bg-surface-container-high"
          >
            <Upload className="size-3.5" aria-hidden />
            Import Files
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="h-8 gap-1.5 text-xs bg-surface-dim border-border hover:bg-surface-container-high"
          >
            <Music className="size-3.5" aria-hidden />
            Add Music
          </Button>
        </div>

        {/* Filter Tabs */}
        <div className="mt-2.5 flex items-center gap-1 rounded-lg bg-surface-dim p-1">
          <button
            type="button"
            onClick={() => setImportType("all")}
            className={cn(
              "flex-1 rounded-md py-1 text-[11px] font-medium transition-all text-center",
              importType === "all"
                ? "bg-surface text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            All ({mediaItems.length})
          </button>
          <button
            type="button"
            onClick={() => setImportType("audio")}
            className={cn(
              "flex-1 rounded-md py-1 text-[11px] font-medium transition-all text-center",
              importType === "audio"
                ? "bg-surface text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Audio
          </button>
          <button
            type="button"
            onClick={() => setImportType("image")}
            className={cn(
              "flex-1 rounded-md py-1 text-[11px] font-medium transition-all text-center",
              importType === "image"
                ? "bg-surface text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Graphics
          </button>
        </div>
      </div>

      {/* Drop Zone & Media List */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        {/* Drag & Drop Area */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setIsDragging(false)
            handleFiles(e.dataTransfer.files)
          }}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center transition-all duration-fast",
            isDragging
              ? "border-primary bg-primary/10"
              : "border-border bg-surface-dim hover:border-primary/50 hover:bg-surface-container",
          )}
        >
          <Upload className="mb-1.5 size-6 text-muted-foreground/60" aria-hidden />
          <p className="text-xs font-semibold text-foreground">Drag & drop media files</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Supports MP3, WAV, AAC, PNG, JPG, SVG, WebP
          </p>
        </div>

        {/* Media Items List */}
        <div className="mt-3.5 flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            <span>Imported Assets ({filteredItems.length})</span>
          </div>
          {filteredItems.length > 0 ? (
            <div ref={mediaListRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="relative w-full" style={{ height: mediaVirtualizer.getTotalSize() }}>
                {mediaVirtualizer.getVirtualItems().map((virtualItem) => {
                  const item = filteredItems[virtualItem.index]
                  return (
                    <div
                      key={item.id}
                      ref={mediaVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      className="absolute left-0 top-0 w-full pb-2"
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                    >
                      <Card className="group overflow-hidden border border-border bg-surface-container transition-all hover:border-primary/50 hover:bg-surface-container-high">
                        <CardContent className="flex items-center gap-2.5 p-2.5">
                          <div
                            className={cn(
                              "flex size-9 shrink-0 items-center justify-center rounded-lg text-foreground",
                              item.kind === "audio"
                                ? "bg-emerald-500/15 text-emerald-400"
                                : "bg-cyan-500/15 text-cyan-400",
                            )}
                          >
                            {item.kind === "audio" ? (
                              <FileAudio className="size-5" aria-hidden />
                            ) : (
                              <FileImage className="size-5" aria-hidden />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <p
                              className="truncate text-xs font-semibold text-foreground"
                              title={item.name}
                            >
                              {item.name}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {item.kind === "audio"
                                ? "Audio Track • Click + to add"
                                : "Image Overlay • Click + to add"}
                            </p>
                          </div>

                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleAddToTimeline(item)}
                              className="size-7 p-0 text-muted-foreground hover:bg-primary hover:text-primary-foreground"
                              title="Add to timeline at playhead"
                            >
                              <Plus className="size-4" aria-hidden />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleRemoveItem(item.id)}
                              className="size-7 p-0 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                              title="Remove asset"
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No external media imported yet.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
