import type {
  CameraLayoutCorner,
  CameraLayoutKind,
  CameraLayoutSegment,
  ZoomEasing,
} from "@recordforge/contracts"
import {
  createDeleteCameraLayoutCommand,
  createUpdateCameraLayoutCommand,
  formatTime,
} from "@recordforge/editor-core"
import { Button, SimpleSelect, Switch, cn } from "@recordforge/ui"
import { Columns2, EyeOff, PictureInPicture2, RectangleHorizontal, Trash2 } from "lucide-react"
import { useTimelineStore } from "../../../stores/timeline-store"
import { DebouncedSlider, InspectorSection } from "./fields"

interface CameraLayoutInspectorProps {
  segment: CameraLayoutSegment
  onClear: () => void
}

const LAYOUT_OPTIONS: Array<{
  kind: CameraLayoutKind
  label: string
  icon: typeof PictureInPicture2
}> = [
  { kind: "pip", label: "PiP", icon: PictureInPicture2 },
  { kind: "fullscreen", label: "Fullscreen", icon: RectangleHorizontal },
  { kind: "side-by-side", label: "Split", icon: Columns2 },
  { kind: "hidden", label: "Hidden", icon: EyeOff },
]

const CORNER_OPTIONS: Array<{ value: CameraLayoutCorner; label: string }> = [
  { value: "tl", label: "Top left" },
  { value: "tr", label: "Top right" },
  { value: "bl", label: "Bottom left" },
  { value: "br", label: "Bottom right" },
  { value: "custom", label: "Custom position" },
]

const SHAPE_OPTIONS: Array<{ value: "rectangle" | "rounded" | "circle"; label: string }> = [
  { value: "rounded", label: "Rounded" },
  { value: "rectangle", label: "Square" },
  { value: "circle", label: "Circle" },
]

const EASING_OPTIONS: Array<{ value: ZoomEasing; label: string }> = [
  { value: "smooth", label: "Smooth" },
  { value: "cinematic", label: "Cinematic" },
  { value: "snappy", label: "Snappy" },
  { value: "linear", label: "Linear" },
  { value: "ease-in-out", label: "Ease in-out" },
]

/**
 * Camera layout segment inspector (#5). The lane edits timing; this panel owns
 * the presentation (layout kind, PiP corner/size/shape, transitions, easing).
 */
export function CameraLayoutInspector({ segment, onClear }: CameraLayoutInspectorProps) {
  const execute = useTimelineStore((state) => state.execute)
  const update = (next: Parameters<typeof createUpdateCameraLayoutCommand>[1]) =>
    execute(createUpdateCameraLayoutCommand(segment.id, next))

  const pip = segment.pip
  const pipKind = segment.layout === "pip"

  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Camera layout</h3>
          <p className="font-mono text-[10px] text-muted-foreground">
            {formatTime(segment.startMs)} → {formatTime(segment.startMs + segment.durationMs)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive"
          onClick={() => {
            if (execute(createDeleteCameraLayoutCommand(segment.id))) onClear()
          }}
        >
          <Trash2 className="mr-1 size-3" aria-hidden />
          Delete
        </Button>
      </div>

      <InspectorSection title="Layout">
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUT_OPTIONS.map(({ kind, label, icon: Icon }) => (
            <Button
              key={kind}
              variant={segment.layout === kind ? "primary" : "outline"}
              size="sm"
              disabled={segment.locked}
              className="justify-start gap-1.5"
              onClick={() =>
                update({
                  layout: kind,
                  ...(kind === "pip" && !pip
                    ? { pip: { corner: "br", sizeFraction: 0.24, shape: "rounded" } }
                    : {}),
                })
              }
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
            </Button>
          ))}
        </div>
      </InspectorSection>

      {pipKind ? (
        <InspectorSection title="Picture in picture">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Corner</span>
            <SimpleSelect
              aria-label="Picture-in-picture corner"
              size="sm"
              value={pip?.corner ?? "br"}
              disabled={segment.locked}
              className="w-36"
              options={CORNER_OPTIONS}
              onValueChange={(value) => update({ pip: { corner: value as CameraLayoutCorner } })}
            />
          </div>

          <div className="mt-3 space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Size</span>
              <span>{Math.round((pip?.sizeFraction ?? 0.24) * 100)}% of height</span>
            </div>
            <DebouncedSlider
              min={0.05}
              max={0.6}
              step={0.01}
              value={[pip?.sizeFraction ?? 0.24]}
              onValueCommit={([value]) => update({ pip: { sizeFraction: value } })}
            />
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Shape</span>
            <SimpleSelect
              aria-label="Picture-in-picture shape"
              size="sm"
              value={pip?.shape ?? "rounded"}
              disabled={segment.locked}
              className="w-36"
              options={SHAPE_OPTIONS}
              onValueChange={(value) =>
                update({ pip: { shape: value as "rectangle" | "rounded" | "circle" } })
              }
            />
          </div>

          {(pip?.corner ?? "br") === "custom" ? (
            <>
              <div className="mt-3 space-y-1.5">
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Position X</span>
                  <span>{Math.round((pip?.x ?? 0.7) * 100)}%</span>
                </div>
                <DebouncedSlider
                  min={0}
                  max={1}
                  step={0.01}
                  value={[pip?.x ?? 0.7]}
                  onValueCommit={([value]) => update({ pip: { x: value } })}
                />
              </div>
              <div className="mt-3 space-y-1.5">
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Position Y</span>
                  <span>{Math.round((pip?.y ?? 0.7) * 100)}%</span>
                </div>
                <DebouncedSlider
                  min={0}
                  max={1}
                  step={0.01}
                  value={[pip?.y ?? 0.7]}
                  onValueCommit={([value]) => update({ pip: { y: value } })}
                />
              </div>
            </>
          ) : null}
        </InspectorSection>
      ) : null}

      <InspectorSection title="Transition">
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Ease in</span>
            <span>{segment.transitionInMs}ms</span>
          </div>
          <DebouncedSlider
            min={0}
            max={2_000}
            step={50}
            value={[segment.transitionInMs]}
            onValueCommit={([value]) => update({ transitionInMs: Math.round(value) })}
          />
        </div>
        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Ease out</span>
            <span>{segment.transitionOutMs}ms</span>
          </div>
          <DebouncedSlider
            min={0}
            max={2_000}
            step={50}
            value={[segment.transitionOutMs]}
            onValueCommit={([value]) => update({ transitionOutMs: Math.round(value) })}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">Easing</span>
          <SimpleSelect
            aria-label="Camera layout easing"
            size="sm"
            value={segment.easing}
            disabled={segment.locked}
            className="w-36"
            options={EASING_OPTIONS}
            onValueChange={(value) => update({ easing: value as ZoomEasing })}
          />
        </div>
      </InspectorSection>

      <InspectorSection title="State">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-foreground">Enabled</span>
          <Switch
            checked={segment.enabled}
            disabled={segment.locked}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </div>
        <div className={cn("mt-3 flex items-center justify-between")}>
          <span className="text-[11px] font-medium text-foreground">Locked</span>
          <Switch checked={segment.locked} onCheckedChange={(locked) => update({ locked })} />
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-subtle-foreground">
          Outside this segment the camera keeps its clip transform, so a layout fades back to the
          bubble when it ends.
        </p>
      </InspectorSection>
    </div>
  )
}
