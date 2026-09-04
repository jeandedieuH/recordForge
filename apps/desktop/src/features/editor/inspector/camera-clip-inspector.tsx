import type {
  CameraClip,
  CameraPlacementPreset,
  ClipTransform,
  MediaMetadata,
} from "@recordforge/contracts"
import { buildCameraPresetTransform } from "@recordforge/editor-core"
import { useEffect, useMemo } from "react"
import { Sparkles, Video } from "lucide-react"
import { Button, ColorPicker, SimpleSelect, Switch, useToast } from "@recordforge/ui"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { ClipPropertiesInspector } from "./clip-properties-inspector"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"
import { CameraPresetPicker } from "./camera-preset-picker"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useRecorderStore } from "../../../stores/recorder-store"

interface CameraClipInspectorProps {
  clip: CameraClip
  track: import("@recordforge/contracts").TimelineTrack
  metadata: MediaMetadata | null
  selectedClipCount?: number
}

const GEOMETRY_KEYS: Array<keyof ClipTransform> = ["x", "y", "width", "height", "crop"]

export function CameraClipInspector({
  clip,
  track,
  metadata,
  selectedClipCount = 1,
}: CameraClipInspectorProps) {
  const interaction = useTimelineInteraction()
  const activeJob = useTimelineStore((state) => state.activeJob)
  const canvas = useTimelineStore((state) => state.engine?.history.present?.canvas)
  const recording = useTimelineStore((state) => state.recording)
  const project = useTimelineStore((state) => state.project)

  // Crop math must use the camera source dimensions, not the screen/canvas.
  // 1. The prepared derivative is the most reliable source once it exists.
  // 2. The durable project asset may carry the original stream size.
  // 3. For multiplexed recordings, the same stream is described in metadata.
  // 4. Standalone webcam files have a separate path but the prepare job gives us
  //    the size; if it is still running we cannot know the exact size, so we
  //    use a sensible 720p fallback rather than the screen dimensions.
  const cameraAsset = useMemo(
    () => project?.assets.find((asset) => asset.id === clip.assetId),
    [project?.assets, clip.assetId],
  )
  const cameraOutput = activeJob?.outputs?.videoTracks.find(
    (output) => output.streamIndex === clip.streamIndex,
  )
  const metadataStream = metadata?.streams.find(
    (stream) => stream.index === clip.streamIndex && stream.kind === "video",
  )
  const fallbackWebcamSize =
    recording?.webcamPath || (clip.streamIndex ?? 0) > 0 ? { width: 1280, height: 720 } : null
  const sourceSize = {
    width:
      cameraOutput?.width ??
      cameraAsset?.width ??
      metadataStream?.width ??
      fallbackWebcamSize?.width ??
      1,
    height:
      cameraOutput?.height ??
      cameraAsset?.height ??
      metadataStream?.height ??
      fallbackWebcamSize?.height ??
      1,
  }

  // If a clip was previously auto-framed using an approximate source size (e.g.
  // the canvas fallback), recompute the crop when the real camera size is known.
  // This only runs while the preset is still active; manual geometry edits clear
  // the preset and therefore opt out of this auto-correction.
  useEffect(() => {
    if (!clip.transform.preset || !canvas || sourceSize.width <= 1 || sourceSize.height <= 1) return

    const expected = buildCameraPresetTransform(clip.transform.preset, {
      canvas,
      source: sourceSize,
    })
    const current = clip.transform

    if (
      current.x !== expected.x ||
      current.y !== expected.y ||
      current.width !== expected.width ||
      current.height !== expected.height ||
      current.crop?.x !== expected.crop?.x ||
      current.crop?.y !== expected.crop?.y ||
      current.crop?.width !== expected.crop?.width ||
      current.crop?.height !== expected.crop?.height
    ) {
      interaction.updateClipTransform(
        clip.id,
        {
          ...current,
          x: expected.x,
          y: expected.y,
          width: expected.width,
          height: expected.height,
          crop: expected.crop,
        },
        { phase: "commit" },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to preset and source-size scalar changes
  }, [clip.id, clip.transform.preset, canvas, sourceSize.width, sourceSize.height])

  function isGeometryChange(partial: Partial<ClipTransform>): boolean {
    return (Object.keys(partial) as Array<keyof ClipTransform>).some((key) =>
      GEOMETRY_KEYS.includes(key),
    )
  }

  function updateTransform(partial: Partial<ClipTransform>) {
    const next: ClipTransform = { ...clip.transform, ...partial }
    // Once the user manually nudges the position or size, the transform no longer
    // exactly matches the selected preset, so clear it to avoid confusion.
    if (isGeometryChange(partial)) {
      next.preset = undefined
      next.locked = false
    }
    interaction.updateClipTransform(clip.id, next, { phase: "commit" })
  }

  function selectPreset(preset: CameraPlacementPreset) {
    if (!canvas) return
    // If we have not resolved a real camera size yet, fall back to a sensible
    // 720p placeholder so the geometry is still reasonable while the prepare
    // job completes. The effect above will recompute the crop with the real
    // source dimensions once they are available.
    const resolvedSource =
      sourceSize.width > 1 && sourceSize.height > 1 ? sourceSize : { width: 1280, height: 720 }
    const next = buildCameraPresetTransform(preset, { canvas, source: resolvedSource })
    interaction.updateClipTransform(clip.id, next, { phase: "commit" })
  }

  const savePreferences = useRecorderStore((state) => state.savePreferences)
  const { toast } = useToast()

  function nudgeOffset(deltaMs: number) {
    const nextStartMs = Math.max(0, clip.startMs + deltaMs)
    interaction.moveClip(clip, track, nextStartMs, { phase: "commit" })
  }

  function handleSaveAsDefault() {
    void savePreferences({ cameraSyncOffsetMs: clip.startMs }).then(() => {
      toast({
        title: "Lip-sync default saved",
        description: `Set ${clip.startMs > 0 ? `+${clip.startMs}` : clip.startMs} ms as the default camera sync offset for future recordings.`,
      })
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <InspectorSection title="Basic" defaultOpen>
        <ClipPropertiesInspector
          clip={clip}
          track={track}
          metadata={metadata}
          selectedClipCount={selectedClipCount}
        />
      </InspectorSection>

      <InspectorSection title="Lip-Sync & Timing" defaultOpen>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
              <Video className="size-4 text-primary" aria-hidden />
              <span>Camera Sync Offset</span>
            </div>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-mono font-semibold text-primary">
              {clip.startMs > 0 ? `+${clip.startMs}` : clip.startMs} ms
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Nudge this camera clip forward or backward to achieve perfect lip-sync with audio.
            Moving right (positive) delays the camera video.
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => nudgeOffset(-250)}
              className="h-7 px-2 text-xs font-mono"
            >
              -250ms
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nudgeOffset(-50)}
              className="h-7 px-2 text-xs font-mono"
            >
              -50ms
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nudgeOffset(50)}
              className="h-7 px-2 text-xs font-mono"
            >
              +50ms
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => nudgeOffset(250)}
              className="h-7 px-2 text-xs font-mono"
            >
              +250ms
            </Button>
            {clip.startMs !== 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => interaction.moveClip(clip, track, 0, { phase: "commit" })}
                className="h-7 px-2 text-xs text-subtle-foreground hover:text-foreground"
              >
                Reset (0ms)
              </Button>
            )}
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleSaveAsDefault}
            className="w-full text-xs cursor-pointer"
          >
            Save current offset ({clip.startMs}ms) as default
          </Button>
        </div>
      </InspectorSection>

      <InspectorSection title="Placement" defaultOpen>
        <div className="flex flex-col gap-3">
          <CameraPresetPicker activePreset={clip.transform.preset} onSelect={selectPreset} />
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Pick a starting layout. Camera-only fills the canvas and cannot be dragged; the other
            presets can be moved, resized, and styled below.
          </p>
        </div>
      </InspectorSection>

      <InspectorSection title="Advanced" defaultOpen>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Sparkles className="size-4 text-tertiary" aria-hidden />
            <span>Picture in picture</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="X"
              value={clip.transform.x}
              onChange={(value) => updateTransform({ x: value })}
            />
            <NumberField
              label="Y"
              value={clip.transform.y}
              onChange={(value) => updateTransform({ y: value })}
            />
            <NumberField
              label="Width"
              value={clip.transform.width}
              onChange={(value) => updateTransform({ width: value })}
            />
            <NumberField
              label="Height"
              value={clip.transform.height}
              onChange={(value) => updateTransform({ height: value })}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-subtle-foreground">Opacity</span>
            <span className="font-mono tabular-nums">
              {Math.round(clip.transform.opacity * 100)}%
            </span>
          </div>
          <DebouncedSlider
            value={[clip.transform.opacity]}
            min={0}
            max={1}
            step={0.05}
            aria-label="Camera opacity"
            onValueCommit={(value) => updateTransform({ opacity: value[0] ?? 1 })}
          />
          <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Show camera</span>
            <Switch
              checked={clip.transform.visible !== false}
              onCheckedChange={(visible) => updateTransform({ visible })}
            />
          </label>
          <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Shape</span>
            <SimpleSelect
              aria-label="Camera shape"
              size="sm"
              value={clip.transform.shape}
              onValueChange={(val) =>
                updateTransform({
                  shape: val as ClipTransform["shape"],
                })
              }
              className="w-32"
              options={[
                { value: "rectangle", label: "Rectangle" },
                { value: "rounded", label: "Rounded" },
                { value: "circle", label: "Circle" },
              ]}
            />
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle-foreground">
              Crop (source pixels)
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(["x", "y", "width", "height"] as const).map((field) => (
                <NumberField
                  key={field}
                  label={field}
                  value={clip.transform.crop?.[field] ?? 0}
                  onChange={(value) =>
                    updateTransform({
                      crop: {
                        x: clip.transform.crop?.x ?? 0,
                        y: clip.transform.crop?.y ?? 0,
                        width: clip.transform.crop?.width ?? sourceSize.width,
                        height: clip.transform.crop?.height ?? sourceSize.height,
                        [field]: value,
                      },
                    })
                  }
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Border width"
              value={clip.transform.borderWidth ?? 0}
              onChange={(value) => updateTransform({ borderWidth: value })}
            />
            <NumberField
              label="Border opacity"
              value={clip.transform.borderOpacity ?? 1}
              onChange={(value) => updateTransform({ borderOpacity: value })}
            />
            <NumberField
              label="Shadow blur"
              value={clip.transform.shadowBlur ?? 0}
              onChange={(value) => updateTransform({ shadowBlur: value, shadowEnabled: value > 0 })}
            />
            <NumberField
              label="Shadow X"
              value={clip.transform.shadowOffsetX ?? 0}
              onChange={(value) => updateTransform({ shadowOffsetX: value })}
            />
            <NumberField
              label="Shadow Y"
              value={clip.transform.shadowOffsetY ?? 0}
              onChange={(value) => updateTransform({ shadowOffsetY: value })}
            />
          </div>

          <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Border color</span>
            <ColorPicker
              aria-label="Camera border color"
              value={clip.transform.borderColor ?? "#ffffff"}
              onChange={(borderColor) => updateTransform({ borderColor })}
            />
          </div>
        </div>
      </InspectorSection>
    </div>
  )
}
