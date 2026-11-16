import { useId, useState } from "react"
import { createApplyLookCommand, lookValuesSchema, type LookValues } from "@recordforge/editor-core"
import { Button, Input, Skeleton, Switch, cn, useToast } from "@recordforge/ui"
import { Save, Sparkles } from "lucide-react"
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

  function applyLook(look: LookValues, name: string) {
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
              className={cn(
                "flex flex-col items-start gap-1 rounded-lg border border-border/60 bg-surface p-2 text-left transition-colors",
                "hover:border-primary/50 hover:bg-surface-hover",
              )}
              title={preset.description}
            >
              <span className="flex w-full items-center justify-between gap-1">
                <span className="truncate text-[11px] font-medium text-foreground">
                  {preset.name}
                </span>
                {custom && !isPro ? <ProBadge /> : null}
              </span>
              <LookSwatch values={preset.definition} />
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

// Tiny canvas-ratio swatch previewing background + camera shape.
function LookSwatch({ values }: { values: LookValues }) {
  const canvas = values.canvas
  const camera = values.camera
  return (
    <span
      aria-hidden
      className="flex h-8 w-full items-center justify-center rounded border border-border/40"
      style={{
        background: canvas.background ?? "rgb(13, 16, 22)",
        padding: `${Math.min(8, (canvas.padding ?? 40) / 16)}px`,
      }}
    >
      <span
        className="h-full w-full bg-surface"
        style={{
          borderRadius:
            camera.shape === "circle"
              ? "50%"
              : camera.shape === "rounded"
                ? "20%"
                : `${Math.min(4, (canvas.borderRadius ?? 8) / 8)}px`,
          border:
            (canvas.borderWidth ?? 0) > 0
              ? `1px solid ${canvas.borderColor ?? "rgba(255,255,255,0.3)"}`
              : undefined,
          boxShadow: canvas.shadow ? "0 2px 6px rgba(0,0,0,0.5)" : undefined,
        }}
      />
    </span>
  )
}
