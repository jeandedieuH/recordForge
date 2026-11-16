import { useId, useRef, useState } from "react"
import {
  applyLookToState,
  createApplyLookCommand,
  lookValuesSchema,
  type LookValues,
} from "@recordforge/editor-core"
import type { TimelineState } from "@recordforge/contracts"
import { Button, Input, Skeleton, Switch, cn, useToast } from "@recordforge/ui"
import { MousePointer2, Save, Sparkles, User } from "lucide-react"
import { useTimelineStore } from "../../../../stores/timeline-store"
import { useLicenseStore } from "../../../../stores/license-store"
import { ProBadge } from "../../../licensing/pro-badge"
import { useLookPresetRegistry } from "../../presets/preset-store"

/**
 * Whole-look presets: one click restyles canvas + every camera transform +
 * cursor settings as a single undoable command. Built-ins are Free; saving the
 * current styling as a custom look is Pro.
 */
export function LooksCard() {
  const execute = useTimelineStore((state) => state.execute)
  const timeline = useTimelineStore((state) => state.engine?.history.present)
  const isPro = useLicenseStore((state) => state.status.tier === "pro")
  const openUpgradeDialog = useLicenseStore((state) => state.openUpgradeDialog)
  const { registry, snapshot, isLoading, error } = useLookPresetRegistry()
  const { toast } = useToast()
  const [includeAspectRatio, setIncludeAspectRatio] = useState(false)
  const [saveName, setSaveName] = useState("")
  const nameId = useId()
  // Tracks the draft we installed for hover preview so we never clear a
  // draft that belongs to an in-progress drag gesture.
  const previewDraft = useRef<TimelineState | null>(null)

  // Hover preview: push the applied look through `draftTimeline` — the same
  // transient channel gestures use — so canvas, camera and cursor changes
  // show in the real preview without touching undo history.
  function previewLook(look: LookValues) {
    if (!timeline) return
    const draft = applyLookToState(timeline, look, { includeAspectRatio })
    previewDraft.current = draft
    useTimelineStore.getState().setDraftTimeline(draft)
  }

  function endLookPreview() {
    const draft = previewDraft.current
    previewDraft.current = null
    if (!draft) return
    const store = useTimelineStore.getState()
    if (store.draftTimeline === draft) store.clearDraft()
  }

  function applyLook(look: LookValues, name: string) {
    endLookPreview()
    const ok = execute(
      createApplyLookCommand(look, { name: `Apply look: ${name}`, includeAspectRatio }),
    )
    if (ok) {
      toast({ title: "Look applied", description: `${name} — undo with Ctrl+Z.` })
    } else {
      toast({
        title: "Look could not be applied",
        description: "Try again on an editable timeline.",
        variant: "error",
      })
    }
  }

  // Snapshot the current styling into a look record. Aspect ratio is included
  // only when the toggle is on — matching the apply-time contract.
  async function saveCurrentLook() {
    if (!timeline || !saveName.trim()) return
    if (!isPro) {
      openUpgradeDialog(["custom-looks"])
      return
    }
    const canvas = timeline.canvas
    const camera = timeline.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.kind === "camera")
    // PiP placement comes from the camera-layout lane when it's in use.
    const pip = timeline.cameraLayouts?.find(
      (segment) => segment.layout === "pip" && segment.enabled,
    )?.pip
    const values: LookValues = lookValuesSchema.parse({
      version: 1,
      // Custom image backgrounds are `data:` URLs, so they travel inside the
      // look record itself — portable across projects with no app-data copy
      // step and no new filesystem surface.
      canvas: {
        background: canvas.background,
        padding: canvas.padding,
        borderRadius: canvas.borderRadius,
        shadow: canvas.shadow,
        shadowColor: canvas.shadowColor,
        shadowBlur: canvas.shadowBlur,
        shadowOffsetX: canvas.shadowOffsetX,
        shadowOffsetY: canvas.shadowOffsetY,
        backgroundBlur: canvas.backgroundBlur,
        backgroundDim: canvas.backgroundDim,
        backgroundFit: canvas.backgroundFit,
        borderWidth: canvas.borderWidth,
        borderColor: canvas.borderColor,
        borderOpacity: canvas.borderOpacity,
        borderStyle: canvas.borderStyle,
        borderGradient: canvas.borderGradient,
        videoPositionY: canvas.videoPositionY,
        motionBlur: canvas.motionBlur,
      },
      camera:
        camera?.kind === "camera"
          ? {
              shape: camera.transform.shape,
              borderWidth: camera.transform.borderWidth,
              borderColor: camera.transform.borderColor,
              borderOpacity: camera.transform.borderOpacity,
              borderStyle: camera.transform.borderStyle,
              borderGradient: camera.transform.borderGradient,
              shadowEnabled: camera.transform.shadowEnabled,
              shadowColor: camera.transform.shadowColor,
              shadowBlur: camera.transform.shadowBlur,
              shadowOffsetX: camera.transform.shadowOffsetX,
              shadowOffsetY: camera.transform.shadowOffsetY,
              opacity: camera.transform.opacity,
              preset: camera.transform.preset,
              color: camera.color,
              cutout: camera.cutout,
              ...(pip ? { layout: pip } : {}),
            }
          : {},
      cursor: { ...canvas.cursorSettings },
      ...(includeAspectRatio && canvas.aspectRatio ? { aspectRatio: canvas.aspectRatio } : {}),
    })
    try {
      await registry.saveCustomPreset({
        name: saveName.trim(),
        description: "Saved from the current canvas styling",
        category: "look",
        tags: ["look", "custom"],
        definition: values,
      })
      setSaveName("")
      toast({ title: "Look saved", description: "It now appears in your look library." })
    } catch (reason) {
      toast({
        title: "Look could not be saved",
        description: reason instanceof Error ? reason.message : "Try again.",
        variant: "error",
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading looks">
        <Skeleton className="h-3 w-24 rounded" />
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }
  if (error) {
    return <p className="text-[11px] text-destructive">{error}</p>
  }

  const presets = snapshot?.presets ?? []

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-dim/40 p-3">
      <div className="flex items-center justify-between text-xs font-semibold text-foreground">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          <span>Looks</span>
        </span>
        <label
          htmlFor={nameId}
          className="flex items-center gap-1.5 text-[10px] font-normal text-muted-foreground"
        >
          Include aspect ratio
          <Switch
            id={`${nameId}-aspect`}
            aria-label="Include aspect ratio when applying a look"
            checked={includeAspectRatio}
            onCheckedChange={setIncludeAspectRatio}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {presets.map((preset) => {
          const custom = snapshot?.customPresetIds?.includes(preset.id) ?? false
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                // Custom looks are a Pro feature even after saving — applying one
                // on Free routes to the upgrade dialog instead of silently working.
                custom && !isPro
                  ? openUpgradeDialog(["custom-looks"])
                  : applyLook(preset.definition, preset.name)
              }
              onMouseEnter={() => previewLook(preset.definition)}
              onMouseLeave={endLookPreview}
              onFocus={() => previewLook(preset.definition)}
              onBlur={endLookPreview}
              className={cn(
                "group flex flex-col gap-1.5 rounded-xl p-1 text-left outline-none transition-all",
                "hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-primary/60",
                "active:scale-[0.98]",
              )}
              title={preset.description}
            >
              <LookSwatch values={preset.definition} includeAspectRatio={includeAspectRatio} />
              <span className="flex w-full items-center justify-between gap-1 px-1 pb-0.5">
                <span className="truncate text-[11px] font-medium text-foreground">
                  {preset.name}
                </span>
                {custom && !isPro ? <ProBadge /> : null}
              </span>
            </button>
          )
        })}
      </div>
      {/* Save current styling — Pro */}
      <div className="flex items-center gap-2 pt-1">
        <Input
          id={nameId}
          value={saveName}
          onChange={(event) => setSaveName(event.target.value)}
          placeholder={isPro ? "Name this look…" : "Saving looks is Pro"}
          disabled={!isPro}
          className="h-7 flex-1 text-xs"
          aria-label="Custom look name"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!isPro || !saveName.trim()}
          onClick={() => void saveCurrentLook()}
        >
          <Save className="size-3" aria-hidden />
          Save
          {!isPro && <ProBadge />}
        </Button>
      </div>
    </div>
  )
}

/**
 * Miniature composition of a look: backdrop, a mock app window (padding,
 * radius, border, shadow), a camera bubble and the cursor. The window content
 * is the same for every look so differences in styling are what the eye
 * compares. Values map to the preview by ratio, not 1:1 pixels.
 */
function LookSwatch({
  values,
  includeAspectRatio,
}: {
  values: LookValues
  includeAspectRatio: boolean
}) {
  const { canvas, camera, cursor } = values
  const isVertical = includeAspectRatio && values.aspectRatio === "9:16"
  const padding = canvas.padding ?? 40
  const inset = padding === 0 ? 0 : 3 + padding / 12
  const radius =
    (canvas.borderRadius ?? 8) === 0 ? 0 : Math.min(10, 1.5 + (canvas.borderRadius ?? 8) / 4)
  const borderWidth =
    (canvas.borderWidth ?? 0) > 0 ? Math.min(2, Math.max(1, (canvas.borderWidth ?? 0) / 2)) : 0
  const borderColor = canvas.borderColor ?? FALLBACK_BORDER
  const borderMix = Math.round((canvas.borderOpacity ?? 1) * 100)
  const cameraRadius =
    camera.shape === "circle" ? "50%" : camera.shape === "rounded" ? "28%" : "2px"
  const dim = canvas.backgroundDim ?? 0

  return (
    <span
      aria-hidden
      className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg ring-1 ring-inset ring-border/60 transition-shadow group-hover:ring-primary/60"
      style={{ background: canvas.background ?? FALLBACK_BACKDROP }}
    >
      {dim > 0 ? (
        <span className="absolute inset-0" style={{ background: `rgba(0,0,0,${dim * 0.6})` }} />
      ) : null}
      {/* Canvas: full-height 9:16 column when the look reframes the output */}
      <span
        className={cn("relative block", isVertical ? "h-full aspect-[9/16]" : "h-full w-full")}
        style={{ padding: `${inset}%` }}
      >
        <span
          className="relative flex h-full w-full flex-col overflow-hidden"
          style={{
            background: MOCK_WINDOW_BG,
            borderRadius: radius,
            border: borderWidth
              ? `${borderWidth}px solid color-mix(in srgb, ${borderColor} ${borderMix}%, transparent)`
              : undefined,
            boxShadow: canvas.shadow
              ? `0 4px 12px ${canvas.shadowColor ?? FALLBACK_SHADOW}, 0 1px 3px ${FALLBACK_SHADOW}`
              : undefined,
          }}
        >
          {/* Mock title bar + content lines */}
          <span
            className="flex h-[14%] min-h-1.5 shrink-0 items-center gap-[2px] px-[5%]"
            style={{ background: MOCK_BAR_BG }}
          >
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="size-[3px] rounded-full"
                style={{ background: MOCK_DOT_BG }}
              />
            ))}
          </span>
          <span className="flex flex-1 flex-col gap-[3px] p-[7%]">
            <span className="h-[3px] w-2/5 rounded-full" style={{ background: MOCK_LINE_STRONG }} />
            <span className="h-[3px] w-4/5 rounded-full" style={{ background: MOCK_LINE_SOFT }} />
            <span className="h-[3px] w-3/5 rounded-full" style={{ background: MOCK_LINE_SOFT }} />
          </span>
          {cursor.spotlightMode ? (
            <span
              className="absolute inset-0"
              style={{
                background: `radial-gradient(circle at 42% 58%, transparent 0 16%, rgba(0,0,0,${cursor.spotlightDimOpacity ?? 0.5}) 42%)`,
              }}
            />
          ) : null}
        </span>
        {/* Cursor, tinted with the look's cursor colours */}
        <MousePointer2
          className="absolute size-2.5"
          style={{
            left: "42%",
            top: "56%",
            fill: cursor.fillColor ?? FALLBACK_CURSOR_FILL,
            stroke: cursor.strokeColor ?? FALLBACK_CURSOR_STROKE,
          }}
          strokeWidth={1.5}
        />
        {/* Camera bubble */}
        <span
          className="absolute bottom-[8%] right-[8%] flex size-[28%] items-center justify-center overflow-hidden"
          style={{
            aspectRatio: "1",
            borderRadius: cameraRadius,
            background: MOCK_CAMERA_BG,
            border: `${Math.min(2, Math.max(1, (camera.borderWidth ?? 2) / 2))}px solid ${camera.borderColor ?? FALLBACK_BORDER}`,
            boxShadow: `0 2px 6px ${FALLBACK_SHADOW}`,
          }}
        >
          <User className="size-2/3 translate-y-[12%] text-white/70" strokeWidth={2.5} />
        </span>
      </span>
    </span>
  )
}

// The mock screen content depicts recorded footage, so it stays constant
// across app themes and is not a UI token.
const MOCK_WINDOW_BG = "linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)"
const MOCK_BAR_BG = "rgba(15, 23, 42, 0.08)"
const MOCK_DOT_BG = "rgba(15, 23, 42, 0.3)"
const MOCK_LINE_STRONG = "rgba(15, 23, 42, 0.45)"
const MOCK_LINE_SOFT = "rgba(15, 23, 42, 0.18)"
const MOCK_CAMERA_BG = "linear-gradient(160deg, #64748b 0%, #334155 100%)"
const FALLBACK_BACKDROP = "rgb(13, 16, 22)"
const FALLBACK_BORDER = "rgba(255, 255, 255, 0.3)"
const FALLBACK_SHADOW = "rgba(0, 0, 0, 0.45)"
const FALLBACK_CURSOR_FILL = "#ffffff"
const FALLBACK_CURSOR_STROKE = "#111111"
