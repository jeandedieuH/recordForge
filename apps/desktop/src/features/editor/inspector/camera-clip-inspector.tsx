import type {
  BorderStyle,
  CameraAiStatus,
  CameraClip,
  CameraColor,
  CameraCutout,
  CameraFaceTracking,
  CameraPlacementPreset,
  ClipTransform,
  MediaMetadata,
} from "@recordforge/contracts"
import { BUNDLED_CAMERA_LUTS } from "@recordforge/contracts"
import { buildCameraPresetTransform, createSetCameraEffectsCommand } from "@recordforge/editor-core"
import { useEffect, useMemo, useRef, useState } from "react"
import { Palette, ScanFace, Sparkles, Video, Wand2 } from "lucide-react"
import { Button, ColorPicker, SimpleSelect, Switch, useToast } from "@recordforge/ui"
import { useTimelineInteraction } from "../timeline/use-timeline-interaction"
import { ClipPropertiesInspector } from "./clip-properties-inspector"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"
import { CameraPresetPicker } from "./camera-preset-picker"
import { useTimelineStore } from "../../../stores/timeline-store"
import { useRecorderStore } from "../../../stores/recorder-store"
import { useLicenseStore } from "../../../stores/license-store"
import { resolveCameraSourceSize } from "../camera/camera-sources"
import {
  analyzeCameraAi,
  cancelCameraAi,
  downloadCameraAiEngine,
  getCameraAiArtifacts,
  getCameraAiStatus,
  isCameraAiCancelled,
  notifyCameraAiArtifactsChanged,
  onCameraAiProgress,
  onCameraAiSetupProgress,
  readCameraLut,
} from "../../../lib/camera-ai"
import { toErrorMessage } from "../../../lib/errors"

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
  const licenseTier = useLicenseStore((state) => state.status.tier)
  const proEnabled = licenseTier === "pro"
  const [aiStatus, setAiStatus] = useState<CameraAiStatus | null>(null)
  const [artifacts, setArtifacts] = useState<{ mattePath?: string; faceTrackPath?: string }>({})
  const [aiBusy, setAiBusy] = useState(false)
  const [aiProgress, setAiProgress] = useState<{ phase: string; percent: number } | null>(null)
  const [lutText, setLutText] = useState<string | null>(null)
  const aiJobRef = useRef<string | null>(null)

  const recordingId = project?.recordingId ?? recording?.id
  const lutAssets = useMemo(
    () => (project?.assets ?? []).filter((asset) => asset.role === "lut"),
    [project?.assets],
  )

  const refreshAi = () => {
    if (!recordingId) return
    void getCameraAiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus(null))
    void getCameraAiArtifacts(recordingId, clip.streamIndex ?? 0)
      .then((next) =>
        setArtifacts({
          mattePath: next.mattePath ?? undefined,
          faceTrackPath: next.faceTrackPath ?? undefined,
        }),
      )
      .catch(() => setArtifacts({}))
  }

  useEffect(() => {
    refreshAi()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on clip/recording identity only
  }, [recordingId, clip.streamIndex])

  useEffect(() => {
    let dispose: (() => void) | undefined
    let setupDispose: (() => void) | undefined
    void onCameraAiProgress((event) => {
      if (event.jobId !== aiJobRef.current) return
      setAiProgress({ phase: event.phase, percent: event.percent })
    }).then((unlisten) => {
      dispose = unlisten
    })
    void onCameraAiSetupProgress((event) => {
      const total = event.totalBytes
      const percent = total > 0 ? Math.round((event.downloadedBytes / total) * 100) : 0
      setAiProgress({ phase: event.stage === "runtime" ? "Runtime" : "Model", percent })
    }).then((unlisten) => {
      setupDispose = unlisten
    })
    return () => {
      dispose?.()
      setupDispose?.()
    }
  }, [])

  // Load a user-imported `.cube` for the preview/summary once it is chosen.
  useEffect(() => {
    const lutId = clip.color?.lutId
    if (!lutId || lutId.startsWith("look:") || !recordingId) {
      setLutText(null)
      return
    }
    let cancelled = false
    readCameraLut(recordingId, lutId)
      .then((text) => {
        if (!cancelled) setLutText(text)
      })
      .catch(() => {
        if (!cancelled) setLutText(null)
      })
    return () => {
      cancelled = true
    }
  }, [clip.color?.lutId, recordingId])

  function dispatchCameraEffects(
    effects: Parameters<typeof createSetCameraEffectsCommand>[1],
    coalesceKey?: string,
  ) {
    useTimelineStore.getState().execute(
      createSetCameraEffectsCommand(clip.id, effects, {
        coalesceKey: coalesceKey ? `camera-effects:${clip.id}:${coalesceKey}` : undefined,
      }),
    )
  }

  function updateColor(partial: Partial<CameraColor>) {
    const next: CameraColor = {
      exposure: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      lutIntensity: 1,
      ...clip.color,
      ...partial,
    }
    dispatchCameraEffects({ color: next }, "color")
  }

  function updateCutout(partial: Partial<CameraCutout>) {
    const next: CameraCutout = {
      enabled: true,
      background: "none",
      blurRadius: 18,
      color: "#0f172a",
      edgeSoftness: 2,
      edgeShrink: 0,
      ...clip.cutout,
      ...partial,
    }
    dispatchCameraEffects({ cutout: next }, "cutout")
  }

  function updateFaceTracking(partial: Partial<CameraFaceTracking>) {
    const next: CameraFaceTracking = {
      enabled: true,
      framing: "medium",
      smoothness: 0.6,
      headroom: 0.12,
      ...clip.faceTracking,
      ...partial,
    }
    dispatchCameraEffects({ faceTracking: next }, "face")
  }

  async function handleDownloadModels() {
    if (!aiStatus) return
    const missing = aiStatus.models.filter((model) => !model.downloaded).map((model) => model.id)
    setAiBusy(true)
    try {
      await downloadCameraAiEngine(missing)
      refreshAi()
      toast({ title: "Camera AI ready", description: "Runtime and models downloaded." })
    } catch (error) {
      toast({ title: "Download failed", description: toErrorMessage(error) })
    } finally {
      setAiBusy(false)
      setAiProgress(null)
    }
  }

  async function handleAnalyze(features: { matte: boolean; faceTrack: boolean }) {
    if (!recordingId) return
    const jobId = crypto.randomUUID()
    aiJobRef.current = jobId
    setAiBusy(true)
    setAiProgress({ phase: "preparing", percent: 0 })
    try {
      await analyzeCameraAi({
        jobId,
        recordingId,
        assetId: clip.assetId,
        streamIndex: clip.streamIndex,
        features,
        force: false,
      })
      refreshAi()
      // The editor preview may already have cutout enabled with no matte; tell
      // it the deterministic artifact paths now resolve.
      notifyCameraAiArtifactsChanged()
      toast({
        title: "Camera AI finished",
        description: features.matte
          ? "Portrait matte ready for this camera clip."
          : "Face track ready for this camera clip.",
      })
    } catch (error) {
      if (isCameraAiCancelled(error)) {
        toast({ title: "Camera AI cancelled" })
      } else {
        toast({ title: "Camera AI failed", description: toErrorMessage(error) })
      }
    } finally {
      aiJobRef.current = null
      setAiBusy(false)
      setAiProgress(null)
    }
  }

  async function handleCancelAi() {
    if (aiJobRef.current) {
      await cancelCameraAi(aiJobRef.current).catch(() => undefined)
    }
  }

  // Crop math must use the camera source dimensions, not the screen/canvas.
  // The shared resolver checks the prepared derivative, the project asset, and
  // the probed stream metadata, falling back to a 720p webcam placeholder when
  // a camera exists but has not been probed yet. The {1,1} sentinel marks "size
  // unknown" for callers that need a value before the prepare job finishes.
  const sourceSize = useMemo(
    () =>
      resolveCameraSourceSize(clip, { project, metadata, activeJob, recording }) ?? {
        width: 1,
        height: 1,
      },
    [clip, project, metadata, activeJob, recording],
  )

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
        title: "Camera latency default saved",
        description: `Set ${clip.startMs > 0 ? `+${clip.startMs}` : clip.startMs} ms as the default camera latency offset for future recordings.`,
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

      <InspectorSection title="Camera Latency" defaultOpen>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
              <Video className="size-4 text-primary" aria-hidden />
              <span>Latency Offset</span>
            </div>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-mono font-semibold text-primary">
              {clip.startMs > 0 ? `+${clip.startMs}` : clip.startMs} ms
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Fine-tune this clip to compensate for camera latency the capture pipeline cannot measure
            (virtual cameras, capture cards). Moving right (positive) delays the video.
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

      <InspectorSection title="Colour" defaultOpen>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
              <Palette className="size-4 text-primary" aria-hidden />
              <span>Grade</span>
            </div>
            {clip.color ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => dispatchCameraEffects({ color: null })}
              >
                Reset
              </Button>
            ) : null}
          </div>
          {(
            [
              ["exposure", "Exposure", -2, 2, 0.05],
              ["contrast", "Contrast", -1, 1, 0.02],
              ["saturation", "Saturation", -1, 1, 0.02],
              ["temperature", "Temperature", -1, 1, 0.02],
              ["tint", "Tint", -1, 1, 0.02],
            ] as const
          ).map(([field, label, min, max, step]) => (
            <div key={field} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-subtle-foreground">{label}</span>
                <span className="font-mono tabular-nums">
                  {(clip.color?.[field] ?? 0).toFixed(2)}
                </span>
              </div>
              <DebouncedSlider
                value={[clip.color?.[field] ?? 0]}
                min={min}
                max={max}
                step={step}
                aria-label={`Camera ${label.toLowerCase()}`}
                onValueCommit={(value) => updateColor({ [field]: value[0] ?? 0 })}
              />
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
            <span>Look</span>
            <SimpleSelect
              aria-label="Camera LUT look"
              size="sm"
              value={clip.color?.lutId ?? "none"}
              onValueChange={(value) =>
                updateColor({ lutId: value === "none" ? undefined : value })
              }
              className="w-40"
              options={[
                { value: "none", label: "None" },
                ...BUNDLED_CAMERA_LUTS.map((look) => ({ value: look.id, label: look.label })),
                ...lutAssets.map((asset) => ({
                  value: asset.id,
                  label: asset.path.split("/").pop() ?? "Imported LUT",
                })),
              ]}
            />
          </div>
          {clip.color?.lutId ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-subtle-foreground">LUT intensity</span>
                <span className="font-mono tabular-nums">
                  {Math.round((clip.color.lutIntensity ?? 1) * 100)}%
                </span>
              </div>
              <DebouncedSlider
                value={[clip.color.lutIntensity ?? 1]}
                min={0}
                max={1}
                step={0.05}
                aria-label="Camera LUT intensity"
                onValueCommit={(value) => updateColor({ lutIntensity: value[0] ?? 1 })}
              />
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-subtle-foreground">
            Colour grading is Free. The preview and export share one composed LUT, so the rendered
            camera matches the editor.
          </p>
        </div>
      </InspectorSection>

      <InspectorSection title="Camera AI" defaultOpen={false}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-subtle-foreground">
            <Wand2 className="size-4 text-tertiary" aria-hidden />
            <span>On-device AI</span>
          </div>
          {!proEnabled ? (
            <p className="rounded-md border border-border bg-surface-dim p-2 text-[11px] text-subtle-foreground">
              Camera cutout, face tracking, and hide-during-silence are Pro features. Colour grading
              stays free.
            </p>
          ) : null}
          {aiStatus ? (
            <p className="text-[11px] leading-relaxed text-subtle-foreground">
              {aiStatus.supported
                ? aiStatus.ready
                  ? "Runtime ready. AI runs offline and never during export."
                  : "Download the runtime and models once; inference runs locally."
                : (aiStatus.reason ?? "Camera AI is not available on this platform.")}
            </p>
          ) : (
            <p className="text-[11px] text-subtle-foreground">Checking camera AI status…</p>
          )}
          {aiStatus?.supported && !aiStatus.ready ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={aiBusy || !proEnabled}
              onClick={() => void handleDownloadModels()}
              className="w-full"
            >
              Download camera AI ({aiStatus.models.filter((m) => !m.downloaded).length} models)
            </Button>
          ) : null}
          {aiBusy && aiProgress ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] text-subtle-foreground">
                <span>{aiProgress.phase}</span>
                <span className="font-mono tabular-nums">{aiProgress.percent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-dim">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${aiProgress.percent}%` }}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="self-end"
                onClick={() => void handleCancelAi()}
              >
                Cancel
              </Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2">
            <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span className="flex items-center gap-1.5">
                <Sparkles className="size-3.5" aria-hidden />
                Portrait cutout
              </span>
              <Switch
                checked={clip.cutout?.enabled === true}
                onCheckedChange={(enabled) =>
                  enabled
                    ? updateCutout({ enabled: true })
                    : dispatchCameraEffects({ cutout: null })
                }
              />
            </label>
            {clip.cutout?.enabled ? (
              <>
                {!artifacts.mattePath ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={aiBusy || !aiStatus?.ready || !proEnabled}
                    onClick={() => void handleAnalyze({ matte: true, faceTrack: false })}
                  >
                    Generate matte for this clip
                  </Button>
                ) : (
                  <p className="text-[10px] text-subtle-foreground">Matte ready.</p>
                )}
                <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                  <span>Background</span>
                  <SimpleSelect
                    aria-label="Cutout background"
                    size="sm"
                    value={clip.cutout.background}
                    onValueChange={(value) =>
                      updateCutout({ background: value as CameraCutout["background"] })
                    }
                    className="w-32"
                    options={[
                      { value: "none", label: "Transparent" },
                      { value: "blur", label: "Blur" },
                      { value: "color", label: "Colour" },
                      { value: "image", label: "Image" },
                    ]}
                  />
                </div>
                {clip.cutout.background === "blur" ? (
                  <NumberField
                    label="Blur radius"
                    value={clip.cutout.blurRadius}
                    min={0}
                    max={100}
                    onChange={(blurRadius) => updateCutout({ blurRadius })}
                  />
                ) : null}
                {clip.cutout.background === "color" ? (
                  <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                    <span>Background colour</span>
                    <ColorPicker
                      aria-label="Cutout background colour"
                      value={clip.cutout.color}
                      onChange={(color) => updateCutout({ color })}
                    />
                  </div>
                ) : null}
                {clip.cutout.background === "image" ? (
                  <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                    <span>Background image</span>
                    <SimpleSelect
                      aria-label="Cutout background image"
                      size="sm"
                      value={clip.cutout.imageAssetId ?? ""}
                      onValueChange={(value) => updateCutout({ imageAssetId: value || undefined })}
                      className="w-40"
                      options={[
                        { value: "", label: "Choose image" },
                        ...(project?.assets ?? [])
                          .filter((asset) => asset.kind === "image")
                          .map((asset) => ({
                            value: asset.id,
                            label: asset.path.split("/").pop() ?? "Image",
                          })),
                      ]}
                    />
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="Edge softness"
                    value={clip.cutout.edgeSoftness}
                    min={0}
                    max={16}
                    onChange={(edgeSoftness) => updateCutout({ edgeSoftness })}
                  />
                  <NumberField
                    label="Edge shrink"
                    value={clip.cutout.edgeShrink}
                    min={-8}
                    max={8}
                    onChange={(edgeShrink) => updateCutout({ edgeShrink })}
                  />
                </div>
              </>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-dim p-2">
            <label className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span className="flex items-center gap-1.5">
                <ScanFace className="size-3.5" aria-hidden />
                Face tracking
              </span>
              <Switch
                checked={clip.faceTracking?.enabled === true}
                onCheckedChange={(enabled) =>
                  enabled
                    ? updateFaceTracking({ enabled: true })
                    : dispatchCameraEffects({ faceTracking: null })
                }
              />
            </label>
            {clip.faceTracking?.enabled ? (
              <>
                {!artifacts.faceTrackPath ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={aiBusy || !aiStatus?.ready || !proEnabled}
                    onClick={() => void handleAnalyze({ matte: false, faceTrack: true })}
                  >
                    Track face for this clip
                  </Button>
                ) : (
                  <p className="text-[10px] text-subtle-foreground">Face track ready.</p>
                )}
                <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                  <span>Framing</span>
                  <SimpleSelect
                    aria-label="Face framing"
                    size="sm"
                    value={clip.faceTracking.framing}
                    onValueChange={(value) =>
                      updateFaceTracking({ framing: value as CameraFaceTracking["framing"] })
                    }
                    className="w-32"
                    options={[
                      { value: "tight", label: "Tight" },
                      { value: "medium", label: "Medium" },
                      { value: "wide", label: "Wide" },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-subtle-foreground">Smoothness</span>
                    <span className="font-mono tabular-nums">
                      {Math.round((clip.faceTracking.smoothness ?? 0.6) * 100)}%
                    </span>
                  </div>
                  <DebouncedSlider
                    value={[clip.faceTracking.smoothness ?? 0.6]}
                    min={0}
                    max={1}
                    step={0.05}
                    aria-label="Face tracking smoothness"
                    onValueCommit={(value) => updateFaceTracking({ smoothness: value[0] ?? 0.6 })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-subtle-foreground">Headroom</span>
                    <span className="font-mono tabular-nums">
                      {Math.round((clip.faceTracking.headroom ?? 0.12) * 100)}%
                    </span>
                  </div>
                  <DebouncedSlider
                    value={[clip.faceTracking.headroom ?? 0.12]}
                    min={0}
                    max={0.5}
                    step={0.01}
                    aria-label="Face tracking headroom"
                    onValueCommit={(value) => updateFaceTracking({ headroom: value[0] ?? 0.12 })}
                  />
                </div>
              </>
            ) : null}
          </div>
          {lutText ? (
            <p className="text-[10px] text-subtle-foreground">
              Imported LUT loaded ({Math.round(lutText.length / 1024)} KB).
            </p>
          ) : null}
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
            <span>Border style</span>
            <SimpleSelect
              aria-label="Camera border style"
              size="sm"
              value={clip.transform.borderStyle ?? "solid"}
              onValueChange={(value) => updateTransform({ borderStyle: value as BorderStyle })}
              className="w-32"
              options={[
                { value: "solid", label: "Solid" },
                { value: "gradient", label: "Gradient" },
                { value: "double", label: "Double" },
                { value: "glass", label: "Glass" },
              ]}
            />
          </div>

          {(clip.transform.borderStyle ?? "solid") === "gradient" ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Gradient start</span>
                <ColorPicker
                  aria-label="Camera border gradient start colour"
                  value={
                    clip.transform.borderGradient?.from ?? clip.transform.borderColor ?? "#ffffff"
                  }
                  onChange={(from) =>
                    updateTransform({
                      borderGradient: {
                        from,
                        to: clip.transform.borderGradient?.to ?? "#6366f1",
                        angle: clip.transform.borderGradient?.angle ?? 135,
                      },
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
                <span>Gradient end</span>
                <ColorPicker
                  aria-label="Camera border gradient end colour"
                  value={clip.transform.borderGradient?.to ?? "#6366f1"}
                  onChange={(to) =>
                    updateTransform({
                      borderGradient: {
                        from:
                          clip.transform.borderGradient?.from ??
                          clip.transform.borderColor ??
                          "#ffffff",
                        to,
                        angle: clip.transform.borderGradient?.angle ?? 135,
                      },
                    })
                  }
                />
              </div>
              <NumberField
                label="Gradient angle"
                value={clip.transform.borderGradient?.angle ?? 135}
                min={0}
                max={360}
                step={15}
                onChange={(angle) =>
                  updateTransform({
                    borderGradient: {
                      from:
                        clip.transform.borderGradient?.from ??
                        clip.transform.borderColor ??
                        "#ffffff",
                      to: clip.transform.borderGradient?.to ?? "#6366f1",
                      angle,
                    },
                  })
                }
              />
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 text-xs text-subtle-foreground">
              <span>Border color</span>
              <ColorPicker
                aria-label="Camera border color"
                value={clip.transform.borderColor ?? "#ffffff"}
                onChange={(borderColor) => updateTransform({ borderColor })}
              />
            </div>
          )}
        </div>
      </InspectorSection>
    </div>
  )
}
