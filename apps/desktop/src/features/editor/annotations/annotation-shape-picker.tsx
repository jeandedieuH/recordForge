import type { AnnotationType } from "@recordforge/contracts"
import { ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import {
  ArrowUpRight,
  Circle,
  Focus,
  MessageSquare,
  Minus,
  RectangleHorizontal,
  Square,
  Tag,
} from "lucide-react"

interface AnnotationShapePickerProps {
  value: AnnotationType
  onChange: (value: AnnotationType) => void
}

export function AnnotationShapePicker({ value, onChange }: AnnotationShapePickerProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        const tool = ANNOTATION_TOOLS.find((item) => item.type === next)
        if (tool) onChange(tool.type)
      }}
      aria-label="Annotation shape"
      className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-surface-dim p-1"
    >
      {ANNOTATION_TOOLS.map(({ type, label, icon: Icon }) => (
        <ToggleGroupItem
          key={type}
          value={type}
          aria-label={label}
          className="min-w-0 flex-col gap-2 px-1 py-3 text-xs motion-reduce:transition-none"
        >
          <Icon aria-hidden />
          <span>{label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export const ANNOTATION_TOOLS = [
  { type: "rectangle", label: "Frame", icon: Square },
  { type: "rounded-rect", label: "Rounded", icon: RectangleHorizontal },
  { type: "circle", label: "Ellipse", icon: Circle },
  { type: "arrow", label: "Arrow", icon: ArrowUpRight },
  { type: "line", label: "Line", icon: Minus },
  { type: "callout", label: "Callout", icon: MessageSquare },
  { type: "spotlight", label: "Focus", icon: Focus },
  { type: "badge", label: "Badge", icon: Tag },
] satisfies { type: AnnotationType; label: string; icon: typeof Square }[]
