import type { AnnotationClip, AnnotationType } from "@recordforge/contracts"
import { ANNOTATION_PALETTES } from "@recordforge/editor-core"
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  cn,
} from "@recordforge/ui"
import {
  ArrowUpRight,
  Circle,
  Eye,
  Lock,
  MessageSquare,
  Minus,
  Radio,
  Shapes,
  ShieldAlert,
  Square,
} from "lucide-react"
import { InspectorSection, NumberField } from "./fields"

interface AnnotationClipInspectorProps {
  clip: AnnotationClip
  onChange: (update: Partial<AnnotationClip>) => void
}

export function AnnotationClipInspector({ clip, onChange }: AnnotationClipInspectorProps) {
  const isArrowOrLine = clip.annotationType === "arrow" || clip.annotationType === "line"
  const hasText = clip.annotationType === "callout" || clip.annotationType === "badge"

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
            <p className="text-[10px] text-muted-foreground">Annotation Vector</p>
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
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1.5">
            Color Swatches
          </label>
          <div className="flex items-center gap-1.5 flex-wrap">
            {ANNOTATION_PALETTES.map((palette) => (
              <button
                key={palette.id}
                type="button"
                onClick={() => onChange({ strokeColor: palette.color })}
                className={cn(
                  "size-5 rounded-full border border-border transition-all",
                  clip.strokeColor.toLowerCase() === palette.color.toLowerCase() &&
                    "ring-2 ring-primary ring-offset-1 ring-offset-surface scale-110",
                )}
                style={{ backgroundColor: palette.color }}
                title={palette.name}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-1">
          <Input
            type="color"
            value={clip.strokeColor}
            onChange={(e) => onChange({ strokeColor: e.target.value })}
            className="size-8 p-0.5 rounded cursor-pointer"
          />
          <Input
            type="text"
            value={clip.strokeColor}
            onChange={(e) => onChange({ strokeColor: e.target.value })}
            className="h-8 font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>Stroke Width</span>
            <span>{clip.strokeWidth}px</span>
          </div>
          <Slider
            min={1}
            max={24}
            step={1}
            value={[clip.strokeWidth]}
            onValueChange={([val]) => onChange({ strokeWidth: val })}
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
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Fill Opacity</span>
              <span>{Math.round(clip.fillOpacity * 100)}%</span>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[clip.fillOpacity]}
              onValueChange={([val]) => onChange({ fillOpacity: val })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="color"
              value={clip.fillColor}
              onChange={(e) => onChange({ fillColor: e.target.value })}
              className="size-8 p-0.5 rounded cursor-pointer"
            />
            <Input
              type="text"
              value={clip.fillColor}
              onChange={(e) => onChange({ fillColor: e.target.value })}
              className="h-8 font-mono text-xs"
            />
          </div>

          {clip.annotationType === "rounded-rect" || clip.annotationType === "callout" ? (
            <div className="space-y-1.5 mt-1">
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Corner Radius</span>
                <span>{clip.cornerRadius ?? 12}px</span>
              </div>
              <Slider
                min={0}
                max={48}
                step={2}
                value={[clip.cornerRadius ?? 12]}
                onValueChange={([val]) => onChange({ cornerRadius: val })}
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
            <div className="flex items-center gap-1.5 flex-1">
              <Input
                type="color"
                value={clip.textColor ?? "#ffffff"}
                onChange={(e) => onChange({ textColor: e.target.value })}
                className="size-7 p-0.5 rounded"
              />
              <span className="text-[11px] text-muted-foreground">Text Color</span>
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
            <Slider
              min={2}
              max={32}
              step={1}
              value={[clip.shadowBlur ?? 8]}
              onValueChange={([val]) => onChange({ shadowBlur: val })}
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
