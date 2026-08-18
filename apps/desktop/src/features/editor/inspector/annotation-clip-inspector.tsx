import { useMemo, useState } from "react"
import type { AnnotationClip, AnnotationType } from "@recordforge/contracts"
import {
  annotationPresetFromClip,
  annotationPresetToShapePreset,
  applyPresetToAnnotationClip,
  type AnnotationPresetRecord,
} from "@recordforge/editor-core"
import {
  Button,
  ColorPicker,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  cn,
  useToast,
} from "@recordforge/ui"
import {
  ArrowUpRight,
  Circle,
  Eye,
  FolderOpen,
  Lock,
  MessageSquare,
  Minus,
  Radio,
  Save,
  Shapes,
  ShieldAlert,
  Square,
} from "lucide-react"
import { DebouncedSlider, InspectorSection, NumberField } from "./fields"
import { useAnnotationPresetRegistry } from "../presets/preset-store"
import { PresetBrowser, type BrowserPreset } from "../panels/preset-browser"
import { SavePresetDialog, type SavePresetFormData } from "../presets/save-preset-dialog"

interface AnnotationClipInspectorProps {
  clip: AnnotationClip
  onChange: (update: Partial<AnnotationClip>) => void
}

export function AnnotationClipInspector({ clip, onChange }: AnnotationClipInspectorProps) {
  const isArrowOrLine = clip.annotationType === "arrow" || clip.annotationType === "line"
  const hasText = clip.annotationType === "callout" || clip.annotationType === "badge"
  const { registry, snapshot } = useAnnotationPresetRegistry()
  const { toast } = useToast()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const activePresetName = useMemo(() => {
    const preset = clip.presetId ? registry.getPresetById(clip.presetId) : undefined
    return preset?.name ?? clip.annotationType.replace("-", " ")
  }, [registry, clip.presetId, clip.annotationType])

  function handleApplyPreset(preset: BrowserPreset) {
    const shape = annotationPresetToShapePreset(preset as AnnotationPresetRecord)
    const updated = applyPresetToAnnotationClip(clip, shape)
    onChange(updated)
  }

  async function handleSavePreset(data: SavePresetFormData) {
    const record = annotationPresetFromClip(clip, {
      name: data.name,
      description: data.description,
      category: data.category,
      tags: data.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    })
    try {
      await registry.saveCustomPreset(record)
      toast({ title: "Preset saved", description: `${data.name} is now in your library.` })
    } catch (error) {
      toast({
        title: "Could not save preset",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "error",
      })
    }
  }

  return (
    <div className="flex flex-col gap-4 p-3 text-xs">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-secondary/20 text-secondary">
            <Shapes className="size-4 text-purple-400" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold capitalize text-foreground">
              {clip.annotationType.replace("-", " ")}
            </h3>
            <p className="text-[10px] text-muted-foreground">{activePresetName}</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.enabled === false && "text-muted-foreground")}
            onClick={() => onChange({ enabled: clip.enabled === false ? true : false })}
            title={clip.enabled === false ? "Enable annotation" : "Disable annotation"}
          >
            <Eye className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("size-7 p-0", clip.locked && "text-primary")}
            onClick={() => onChange({ locked: !clip.locked })}
            title={clip.locked ? "Unlock position" : "Lock position"}
          >
            <Lock className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Preset Controls */}
      <InspectorSection title="Shape Preset">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-dim px-2.5 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
              Active Preset
            </span>
            <span
              className="truncate text-xs font-medium text-foreground text-right"
              title={activePresetName}
            >
              {activePresetName}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 text-xs justify-center"
              onClick={() => setBrowserOpen(true)}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              Browse
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs justify-center"
              onClick={() => setSaveOpen(true)}
            >
              <Save className="size-3.5" aria-hidden />
              Save
            </Button>
          </div>
        </div>
      </InspectorSection>

      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="flex max-h-[min(760px,90vh)] max-w-3xl flex-col gap-3 overflow-hidden p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shapes className="size-4 text-secondary" aria-hidden />
              Browse annotation presets
            </DialogTitle>
          </DialogHeader>
          <PresetBrowser
            kind="annotation"
            selectedPresetId={clip.presetId}
            onSelect={(preset) => {
              handleApplyPreset(preset)
              setBrowserOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>

      <SavePresetDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultCategory={clip.annotationType}
        categories={snapshot.categories}
        onSave={handleSavePreset}
      />

      {/* Shape Type Selector */}
      <InspectorSection title="Shape Type">
        <div className="grid grid-cols-4 gap-1">
          <ShapeTypeButton
            type="rectangle"
            current={clip.annotationType}
            icon={Square}
            label="Rect"
            onClick={() => onChange({ annotationType: "rectangle" })}
          />
          <ShapeTypeButton
            type="rounded-rect"
            current={clip.annotationType}
            icon={Square}
            label="Rounded"
            onClick={() => onChange({ annotationType: "rounded-rect", cornerRadius: 16 })}
          />
          <ShapeTypeButton
            type="circle"
            current={clip.annotationType}
            icon={Circle}
            label="Circle"
            onClick={() => onChange({ annotationType: "circle" })}
          />
          <ShapeTypeButton
            type="arrow"
            current={clip.annotationType}
            icon={ArrowUpRight}
            label="Arrow"
            onClick={() => onChange({ annotationType: "arrow" })}
          />
          <ShapeTypeButton
            type="line"
            current={clip.annotationType}
            icon={Minus}
            label="Line"
            onClick={() => onChange({ annotationType: "line" })}
          />
          <ShapeTypeButton
            type="callout"
            current={clip.annotationType}
            icon={MessageSquare}
            label="Callout"
            onClick={() =>
              onChange({
                annotationType: "callout",
                text: clip.text || "Note here",
                fillColor: "#0f172a",
                fillOpacity: 0.9,
              })
            }
          />
          <ShapeTypeButton
            type="spotlight"
            current={clip.annotationType}
            icon={Radio}
            label="Spotlight"
            onClick={() =>
              onChange({
                annotationType: "spotlight",
                fillColor: "#000000",
                fillOpacity: 0.6,
                strokeWidth: 2,
              })
            }
          />
          <ShapeTypeButton
            type="badge"
            current={clip.annotationType}
            icon={ShieldAlert}
            label="Badge"
            onClick={() =>
              onChange({
                annotationType: "badge",
                text: clip.text || "IMPORTANT",
                fillColor: "#ef4444",
                fillOpacity: 0.2,
                strokeColor: "#ef4444",
              })
            }
          />
        </div>
      </InspectorSection>

      {/* Stroke & Color Style */}
      <InspectorSection title="Stroke & Color">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">Stroke Color</span>
          <ColorPicker
            aria-label="Stroke color"
            size="sm"
            value={clip.strokeColor}
            onChange={(strokeColor) => onChange({ strokeColor })}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Stroke Width</span>
            <span>{clip.strokeWidth}px</span>
          </div>
          <DebouncedSlider
            min={1}
            max={24}
            step={1}
            value={[clip.strokeWidth]}
            onValueCommit={([val]) => onChange({ strokeWidth: val })}
          />
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
            Stroke Style
          </label>
          <ToggleGroup
            type="single"
            value={clip.strokeStyle}
            onValueChange={(val) => val && onChange({ strokeStyle: val as any })}
            className="bg-surface-dim p-0.5 rounded-lg border border-border grid grid-cols-3"
          >
            <ToggleGroupItem value="solid" className="h-6 text-[10px]">
              Solid
            </ToggleGroupItem>
            <ToggleGroupItem value="dashed" className="h-6 text-[10px]">
              Dashed
            </ToggleGroupItem>
            <ToggleGroupItem value="dotted" className="h-6 text-[10px]">
              Dotted
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </InspectorSection>

      {/* Fill & Background */}
      {!isArrowOrLine && (
        <InspectorSection title="Fill & Background">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">Fill Color</span>
            <ColorPicker
              aria-label="Fill color"
              size="sm"
              value={clip.fillColor}
              onChange={(fillColor) => onChange({ fillColor })}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Fill Opacity</span>
              <span>{Math.round(clip.fillOpacity * 100)}%</span>
            </div>
            <DebouncedSlider
              min={0}
              max={1}
              step={0.05}
              value={[clip.fillOpacity]}
              onValueCommit={([val]) => onChange({ fillOpacity: val })}
            />
          </div>

          {clip.annotationType === "rounded-rect" || clip.annotationType === "callout" ? (
            <div className="space-y-1.5 mt-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Corner Radius</span>
                <span>{clip.cornerRadius ?? 12}px</span>
              </div>
              <DebouncedSlider
                min={0}
                max={48}
                step={2}
                value={[clip.cornerRadius ?? 12]}
                onValueCommit={([val]) => onChange({ cornerRadius: val })}
              />
            </div>
          ) : null}
        </InspectorSection>
      )}

      {/* Text Settings for Callouts & Badges */}
      {hasText && (
        <InspectorSection title="Text Content">
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span>Label / Note Text</span>
            <Input
              type="text"
              value={clip.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value })}
              placeholder="Enter callout text..."
              className="h-8 text-xs font-medium"
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center justify-between gap-2 flex-1">
              <span className="text-[11px] text-muted-foreground">Text Color</span>
              <ColorPicker
                aria-label="Text color"
                size="sm"
                value={clip.textColor ?? "#ffffff"}
                onChange={(textColor) => onChange({ textColor })}
              />
            </div>

            <div className="w-20">
              <NumberField
                label="Size"
                value={clip.fontSize ?? 14}
                onChange={(val) => onChange({ fontSize: val })}
                min={8}
              />
            </div>
          </div>
        </InspectorSection>
      )}

      {/* Arrow Heads */}
      {isArrowOrLine && (
        <InspectorSection title="Arrow Heads">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
                Start Head
              </label>
              <Select
                value={clip.arrowStartHead}
                onValueChange={(val) => onChange({ arrowStartHead: val as any })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="arrow">Arrow</SelectItem>
                  <SelectItem value="circle">Circle</SelectItem>
                  <SelectItem value="square">Square</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
                End Head
              </label>
              <Select
                value={clip.arrowEndHead}
                onValueChange={(val) => onChange({ arrowEndHead: val as any })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="arrow">Arrow</SelectItem>
                  <SelectItem value="circle">Circle</SelectItem>
                  <SelectItem value="square">Square</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </InspectorSection>
      )}

      {/* Shadow & Glow */}
      <InspectorSection title="Shadow & Glow">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-foreground">Drop Shadow</span>
          <Switch
            checked={clip.shadowEnabled ?? false}
            onCheckedChange={(checked) => onChange({ shadowEnabled: checked })}
          />
        </div>

        {clip.shadowEnabled && (
          <div className="space-y-1.5 mt-1">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Shadow Blur</span>
              <span>{clip.shadowBlur ?? 8}px</span>
            </div>
            <DebouncedSlider
              min={2}
              max={32}
              step={1}
              value={[clip.shadowBlur ?? 8]}
              onValueCommit={([val]) => onChange({ shadowBlur: val })}
            />
          </div>
        )}
      </InspectorSection>

      {/* Animation */}
      <InspectorSection title="Animation">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Intro
            </label>
            <Select
              value={clip.animationIn ?? "fade"}
              onValueChange={(val) => onChange({ animationIn: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="scale-up">Pop Scale</SelectItem>
                <SelectItem value="draw">Vector Draw</SelectItem>
                <SelectItem value="slide-up">Slide Up</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              Outro
            </label>
            <Select
              value={clip.animationOut ?? "fade"}
              onValueChange={(val) => onChange({ animationOut: val as any })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="scale-down">Shrink Scale</SelectItem>
                <SelectItem value="slide-down">Slide Down</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </InspectorSection>

      {/* Geometry / Transform */}
      <InspectorSection title="Transform & Layout">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="X Pos"
            value={Math.round(clip.x)}
            onChange={(val) => onChange({ x: val })}
          />
          <NumberField
            label="Y Pos"
            value={Math.round(clip.y)}
            onChange={(val) => onChange({ y: val })}
          />
          <NumberField
            label="Width"
            value={Math.round(clip.width)}
            onChange={(val) => onChange({ width: Math.max(10, val) })}
            min={10}
          />
          <NumberField
            label="Height"
            value={Math.round(clip.height)}
            onChange={(val) => onChange({ height: Math.max(10, val) })}
            min={10}
          />
        </div>
      </InspectorSection>
    </div>
  )
}

function ShapeTypeButton({
  type,
  current,
  icon: Icon,
  label,
  onClick,
}: {
  type: AnnotationType
  current: AnnotationType
  icon: any
  label: string
  onClick: () => void
}) {
  const isSelected = current === type
  return (
    <Button
      variant={isSelected ? "secondary" : "ghost"}
      size="sm"
      className={cn(
        "flex-col gap-0.5 h-12 p-1 text-[10px]",
        isSelected && "bg-primary/20 text-primary border border-primary/40",
      )}
      onClick={onClick}
    >
      <Icon className="size-4" />
      <span>{label}</span>
    </Button>
  )
}
