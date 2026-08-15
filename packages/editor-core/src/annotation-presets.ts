import type {
  AnnotationClip,
  AnnotationHead,
  AnnotationStrokeStyle,
  AnnotationType,
} from "@recordforge/domain"

export interface AnnotationColorPalette {
  id: string
  name: string
  color: string
}

export const ANNOTATION_PALETTES: AnnotationColorPalette[] = [
  { id: "sky", name: "Sky Blue", color: "#38bdf8" },
  { id: "emerald", name: "Emerald", color: "#34d399" },
  { id: "violet", name: "Violet", color: "#a78bfa" },
  { id: "amber", name: "Sunset Amber", color: "#f59e0b" },
  { id: "rose", name: "Coral Rose", color: "#f43f5e" },
  { id: "white", name: "Pure White", color: "#ffffff" },
  { id: "yellow", name: "Vibrant Yellow", color: "#facc15" },
  { id: "cyan", name: "Neon Cyan", color: "#22d3ee" },
]

export interface AnnotationShapePreset {
  type: AnnotationType
  name: string
  description: string
  defaultWidth: number
  defaultHeight: number
  defaultStrokeWidth: number
  defaultStrokeColor: string
  defaultFillColor: string
  defaultFillOpacity: number
  defaultCornerRadius: number
  defaultArrowStartHead: AnnotationHead
  defaultArrowEndHead: AnnotationHead
  defaultStrokeStyle: AnnotationStrokeStyle
}

export const ANNOTATION_SHAPES: AnnotationShapePreset[] = [
  {
    type: "rectangle",
    name: "Rectangle Box",
    description: "Outlined box to focus and highlight areas",
    defaultWidth: 260,
    defaultHeight: 160,
    defaultStrokeWidth: 4,
    defaultStrokeColor: "#38bdf8",
    defaultFillColor: "#38bdf8",
    defaultFillOpacity: 0.1,
    defaultCornerRadius: 0,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
  {
    type: "rounded-rect",
    name: "Rounded Card",
    description: "Smooth rounded frame for modern UI callouts",
    defaultWidth: 280,
    defaultHeight: 160,
    defaultStrokeWidth: 4,
    defaultStrokeColor: "#38bdf8",
    defaultFillColor: "#38bdf8",
    defaultFillOpacity: 0.12,
    defaultCornerRadius: 14,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
  {
    type: "circle",
    name: "Circle / Ellipse",
    description: "Circular spotlight ring to point at key buttons or icons",
    defaultWidth: 180,
    defaultHeight: 180,
    defaultStrokeWidth: 4,
    defaultStrokeColor: "#f59e0b",
    defaultFillColor: "#f59e0b",
    defaultFillOpacity: 0.1,
    defaultCornerRadius: 0,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
  {
    type: "arrow",
    name: "Direct Arrow",
    description: "Directional pointer arrow with sharp arrowhead",
    defaultWidth: 240,
    defaultHeight: 120,
    defaultStrokeWidth: 5,
    defaultStrokeColor: "#f43f5e",
    defaultFillColor: "#f43f5e",
    defaultFillOpacity: 0,
    defaultCornerRadius: 0,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "arrow",
    defaultStrokeStyle: "solid",
  },
  {
    type: "line",
    name: "Straight Line",
    description: "Clean underline or connector line",
    defaultWidth: 240,
    defaultHeight: 40,
    defaultStrokeWidth: 4,
    defaultStrokeColor: "#34d399",
    defaultFillColor: "#34d399",
    defaultFillOpacity: 0,
    defaultCornerRadius: 0,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
  {
    type: "callout",
    name: "Speech Bubble",
    description: "Speech callout container with optional text caption",
    defaultWidth: 280,
    defaultHeight: 140,
    defaultStrokeWidth: 3,
    defaultStrokeColor: "#a78bfa",
    defaultFillColor: "#1e1b4b",
    defaultFillOpacity: 0.85,
    defaultCornerRadius: 12,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
  {
    type: "spotlight",
    name: "Soft Spotlight",
    description: "Dim surrounding canvas to draw intense focus to a region",
    defaultWidth: 320,
    defaultHeight: 200,
    defaultStrokeWidth: 2,
    defaultStrokeColor: "rgba(255, 255, 255, 0.4)",
    defaultFillColor: "rgba(0, 0, 0, 0.6)",
    defaultFillOpacity: 0.6,
    defaultCornerRadius: 16,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
  {
    type: "badge",
    name: "Notice Badge",
    description: "Compact framed badge with custom icon or warning",
    defaultWidth: 200,
    defaultHeight: 70,
    defaultStrokeWidth: 3,
    defaultStrokeColor: "#f59e0b",
    defaultFillColor: "#451a03",
    defaultFillOpacity: 0.85,
    defaultCornerRadius: 20,
    defaultArrowStartHead: "none",
    defaultArrowEndHead: "none",
    defaultStrokeStyle: "solid",
  },
]

export function getAnnotationShapePreset(type: AnnotationType): AnnotationShapePreset {
  const found = ANNOTATION_SHAPES.find((s) => s.type === type)
  return found ?? ANNOTATION_SHAPES[0]
}

export function createAnnotationClip(
  type: AnnotationType,
  options?: {
    id?: string
    startMs?: number
    durationMs?: number
    x?: number
    y?: number
    width?: number
    height?: number
    endX?: number
    endY?: number
    strokeColor?: string
    strokeWidth?: number
    text?: string
    canvasWidth?: number
    canvasHeight?: number
  },
): AnnotationClip {
  const preset = getAnnotationShapePreset(type)
  const id = options?.id ?? `annot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const startMs = options?.startMs ?? 0
  const durationMs = options?.durationMs ?? 3000
  const canvasWidth = options?.canvasWidth ?? 1920
  const canvasHeight = options?.canvasHeight ?? 1080

  const width = options?.width ?? preset.defaultWidth
  const height = options?.height ?? preset.defaultHeight
  const x = options?.x ?? Math.max(40, Math.round((canvasWidth - width) / 2))
  const y = options?.y ?? Math.max(40, Math.round((canvasHeight - height) / 2))

  return {
    id,
    assetId: `synthetic:annotation:${id}`,
    kind: "annotation",
    annotationType: type,
    startMs,
    durationMs,
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    x,
    y,
    width,
    height,
    endX: options?.endX ?? (type === "arrow" || type === "line" ? x + width : undefined),
    endY: options?.endY ?? (type === "arrow" || type === "line" ? y + height : undefined),
    strokeColor: options?.strokeColor ?? preset.defaultStrokeColor,
    strokeWidth: options?.strokeWidth ?? preset.defaultStrokeWidth,
    strokeStyle: preset.defaultStrokeStyle,
    fillColor: preset.defaultFillColor,
    fillOpacity: preset.defaultFillOpacity,
    cornerRadius: preset.defaultCornerRadius,
    arrowStartHead: preset.defaultArrowStartHead,
    arrowEndHead: preset.defaultArrowEndHead,
    shadowEnabled: true,
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowBlur: 10,
    text: options?.text ?? (type === "callout" ? "Add note here..." : undefined),
    textColor: "#ffffff",
    fontSize: 16,
    animationIn: "fade",
    animationOut: "fade",
    enabled: true,
    locked: false,
  }
}
