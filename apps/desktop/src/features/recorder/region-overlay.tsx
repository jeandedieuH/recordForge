import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Crop, Maximize2, Move, Ratio, X } from "lucide-react"
import { Button } from "@recordforge/ui"
import type { Bounds } from "@recordforge/contracts"

export type AspectRatioOption = "free" | "16:9" | "4:3" | "1:1" | "9:16"

interface RegionOverlayProps {
  open: boolean
  initialBounds?: Bounds
  onConfirm: (bounds: Bounds) => void
  onCancel: () => void
}

type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | null

const ASPECT_RATIOS: Record<Exclude<AspectRatioOption, "free">, number> = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1 / 1,
  "9:16": 9 / 16,
}

// Full-screen interactive overlay canvas for selecting, drawing, dragging,
// and fine-tuning capture regions on screen.
export function RegionOverlay({ open, initialBounds, onConfirm, onCancel }: RegionOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Current selected region bounds relative to current viewport
  const [bounds, setBounds] = useState<Bounds>(() => ({
    x: initialBounds?.x ?? Math.max(0, Math.round(window.innerWidth * 0.15)),
    y: initialBounds?.y ?? Math.max(0, Math.round(window.innerHeight * 0.15)),
    width: initialBounds?.width ?? Math.min(1920, Math.round(window.innerWidth * 0.7)),
    height: initialBounds?.height ?? Math.min(1080, Math.round(window.innerHeight * 0.7)),
  }))

  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>("free")
  const [isDrawing, setIsDrawing] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [resizingHandle, setResizingHandle] = useState<ResizeHandle>(null)

  // Drag offsets
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const initialBoundsRef = useRef<Bounds>({ ...bounds })

  // Sync initial bounds when opened
  useEffect(() => {
    if (open) {
      const defaultW = Math.min(1920, Math.round(window.innerWidth * 0.7))
      const defaultH = Math.min(1080, Math.round(window.innerHeight * 0.7))
      const defaultX = Math.max(0, Math.round((window.innerWidth - defaultW) / 2))
      const defaultY = Math.max(0, Math.round((window.innerHeight - defaultH) / 2))

      setBounds({
        x: initialBounds?.x ?? defaultX,
        y: initialBounds?.y ?? defaultY,
        width: initialBounds?.width ?? defaultW,
        height: initialBounds?.height ?? defaultH,
      })
    }
  }, [open, initialBounds])

  // Helper to enforce aspect ratio on width/height
  const applyAspectRatio = useCallback(
    (w: number, h: number, ratioOpt: AspectRatioOption, priority: "width" | "height" = "width") => {
      if (ratioOpt === "free") return { width: Math.max(50, w), height: Math.max(50, h) }
      const ratio = ASPECT_RATIOS[ratioOpt]
      if (priority === "width") {
        const targetW = Math.max(50, w)
        return { width: targetW, height: Math.max(50, Math.round(targetW / ratio)) }
      }
      const targetH = Math.max(50, h)
      return { width: Math.max(50, Math.round(targetH * ratio)), height: targetH }
    },
    [],
  )

  // Handle aspect ratio toggle
  const handleAspectRatioChange = (ratio: AspectRatioOption) => {
    setAspectRatio(ratio)
    if (ratio !== "free") {
      const adjusted = applyAspectRatio(bounds.width, bounds.height, ratio, "width")
      setBounds((prev) => ({
        ...prev,
        width: adjusted.width,
        height: adjusted.height,
      }))
    }
  }

  // Preset size shortcuts
  const applyPreset = (w: number, h: number) => {
    const screenW = window.innerWidth
    const screenH = window.innerHeight
    const targetW = Math.min(w, screenW)
    const targetH = Math.min(h, screenH)
    const targetX = Math.max(0, Math.round((screenW - targetW) / 2))
    const targetY = Math.max(0, Math.round((screenH - targetH) / 2))

    setBounds({ x: targetX, y: targetY, width: targetW, height: targetH })
    if (w / h === 16 / 9) setAspectRatio("16:9")
    else if (w / h === 1) setAspectRatio("1:1")
    else setAspectRatio("free")
  }

  // Center current box
  const centerRegion = () => {
    const screenW = window.innerWidth
    const screenH = window.innerHeight
    setBounds((prev) => ({
      ...prev,
      x: Math.max(0, Math.round((screenW - prev.width) / 2)),
      y: Math.max(0, Math.round((screenH - prev.height) / 2)),
    }))
  }

  // Confirm selection
  const handleConfirm = useCallback(() => {
    onConfirm({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(50, Math.round(bounds.width)),
      height: Math.max(50, Math.round(bounds.height)),
    })
  }, [bounds, onConfirm])

  // Mouse interaction handlers
  const handleMouseDownCanvas = (e: React.MouseEvent) => {
    // Only initiate canvas selection on left click outside toolbar
    if (e.button !== 0) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return

    const startX = e.clientX - rect.left
    const startY = e.clientY - rect.top

    dragStartRef.current = { x: startX, y: startY }
    initialBoundsRef.current = { x: startX, y: startY, width: 0, height: 0 }

    setIsDrawing(true)
    setBounds({ x: startX, y: startY, width: 2, height: 2 })
  }

  const handleMouseDownRegion = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return

    dragStartRef.current = { x: e.clientX, y: e.clientY }
    initialBoundsRef.current = { ...bounds }
    setIsMoving(true)
  }

  const handleMouseDownHandle = (e: React.MouseEvent, handle: ResizeHandle) => {
    e.stopPropagation()
    if (e.button !== 0) return

    dragStartRef.current = { x: e.clientX, y: e.clientY }
    initialBoundsRef.current = { ...bounds }
    setResizingHandle(handle)
  }

  // Mouse move handler
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDrawing && !isMoving && !resizingHandle) return

      const deltaX = e.clientX - dragStartRef.current.x
      const deltaY = e.clientY - dragStartRef.current.y
      const init = initialBoundsRef.current

      if (isDrawing) {
        const rawW = Math.abs(deltaX)
        const rawH = Math.abs(deltaY)
        const newX = deltaX >= 0 ? init.x : init.x + deltaX
        const newY = deltaY >= 0 ? init.y : init.y + deltaY

        const sized = applyAspectRatio(rawW, rawH, aspectRatio, rawW >= rawH ? "width" : "height")
        setBounds({
          x: Math.max(0, Math.round(newX)),
          y: Math.max(0, Math.round(newY)),
          width: sized.width,
          height: sized.height,
        })
      } else if (isMoving) {
        const newX = Math.max(0, Math.min(window.innerWidth - init.width, init.x + deltaX))
        const newY = Math.max(0, Math.min(window.innerHeight - init.height, init.y + deltaY))
        setBounds({
          ...init,
          x: Math.round(newX),
          y: Math.round(newY),
        })
      } else if (resizingHandle) {
        let newX = init.x
        let newY = init.y
        let newW = init.width
        let newH = init.height

        switch (resizingHandle) {
          case "se":
            newW = init.width + deltaX
            newH = init.height + deltaY
            break
          case "sw":
            newW = init.width - deltaX
            newX = init.x + deltaX
            newH = init.height + deltaY
            break
          case "ne":
            newW = init.width + deltaX
            newH = init.height - deltaY
            newY = init.y + deltaY
            break
          case "nw":
            newW = init.width - deltaX
            newX = init.x + deltaX
            newH = init.height - deltaY
            newY = init.y + deltaY
            break
          case "e":
            newW = init.width + deltaX
            break
          case "w":
            newW = init.width - deltaX
            newX = init.x + deltaX
            break
          case "s":
            newH = init.height + deltaY
            break
          case "n":
            newH = init.height - deltaY
            newY = init.y + deltaY
            break
        }

        const sized = applyAspectRatio(newW, newH, aspectRatio, "width")
        setBounds({
          x: Math.max(0, Math.round(newX)),
          y: Math.max(0, Math.round(newY)),
          width: sized.width,
          height: sized.height,
        })
      }
    },
    [isDrawing, isMoving, resizingHandle, aspectRatio, applyAspectRatio],
  )

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false)
    setIsMoving(false)
    setResizingHandle(null)
  }, [])

  // Global mouse event listeners while dragging
  useEffect(() => {
    if (isDrawing || isMoving || resizingHandle) {
      window.addEventListener("mousemove", handleMouseMove)
      window.addEventListener("mouseup", handleMouseUp)
      return () => {
        window.removeEventListener("mousemove", handleMouseMove)
        window.removeEventListener("mouseup", handleMouseUp)
      }
    }
  }, [isDrawing, isMoving, resizingHandle, handleMouseMove, handleMouseUp])

  // Keyboard navigation & shortcuts
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel()
      } else if (e.key === "Enter") {
        e.preventDefault()
        handleConfirm()
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        setBounds((prev) => {
          let { x, y } = prev
          const { width, height } = prev
          if (e.key === "ArrowLeft") x = Math.max(0, x - step)
          if (e.key === "ArrowRight") x = Math.min(window.innerWidth - width, x + step)
          if (e.key === "ArrowUp") y = Math.max(0, y - step)
          if (e.key === "ArrowDown") y = Math.min(window.innerHeight - height, y + step)
          return { x, y, width, height }
        })
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, onCancel, handleConfirm])

  if (!open) return null

  // Calculate current aspect ratio string label
  const calculatedRatio = (bounds.width / bounds.height).toFixed(2)
  const isExact169 = Math.abs(bounds.width / bounds.height - 16 / 9) < 0.05
  const isExact43 = Math.abs(bounds.width / bounds.height - 4 / 3) < 0.05
  const isExact11 = Math.abs(bounds.width / bounds.height - 1) < 0.05
  const ratioLabel = isExact169
    ? "16:9"
    : isExact43
      ? "4:3"
      : isExact11
        ? "1:1"
        : `${calculatedRatio}:1`

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDownCanvas}
      className="fixed inset-0 z-[100] select-none cursor-crosshair overflow-hidden bg-black/60 backdrop-blur-[1px]"
    >
      {/* Top Floating Control Toolbar */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-5 left-1/2 -translate-x-1/2 z-[110] flex items-center gap-3 rounded-xl border border-border-strong bg-surface/95 px-4 py-2.5 shadow-2xl backdrop-blur-md"
      >
        <div className="flex items-center gap-2 border-r border-border/60 pr-3">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary/20 text-primary">
            <Crop className="size-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-foreground leading-tight">Region Capture</span>
            <span className="text-[10px] text-subtle-foreground font-mono">
              {bounds.width} × {bounds.height} px
            </span>
          </div>
        </div>

        {/* Aspect Ratio Selector */}
        <div className="flex items-center gap-1 bg-surface-dim rounded-lg p-1 border border-border/50">
          <Ratio className="size-3.5 text-muted-foreground ml-1.5 mr-0.5" />
          {(["free", "16:9", "4:3", "1:1"] as AspectRatioOption[]).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => handleAspectRatioChange(opt)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium capitalize transition-all ${
                aspectRatio === opt
                  ? "bg-primary text-primary-foreground shadow-sm font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        {/* Quick Presets */}
        <div className="hidden sm:flex items-center gap-1 border-l border-border/60 pl-3">
          <button
            type="button"
            onClick={() => applyPreset(1920, 1080)}
            className="px-2 py-1 rounded bg-surface-dim hover:bg-overlay text-[11px] font-medium text-foreground transition-colors border border-border/40"
          >
            1080p
          </button>
          <button
            type="button"
            onClick={() => applyPreset(1280, 720)}
            className="px-2 py-1 rounded bg-surface-dim hover:bg-overlay text-[11px] font-medium text-foreground transition-colors border border-border/40"
          >
            720p
          </button>
          <button
            type="button"
            onClick={centerRegion}
            title="Center region on screen"
            className="p-1 rounded bg-surface-dim hover:bg-overlay text-foreground transition-colors border border-border/40"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 border-l border-border/60 pl-3">
          <Button
            size="sm"
            onClick={handleConfirm}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md hover:brightness-110 cursor-pointer"
          >
            <Check className="size-3.5" />
            <span>Confirm</span>
            <kbd className="hidden md:inline-block ml-1 rounded bg-black/20 px-1 py-0.5 text-[9px] font-mono">
              Enter
            </kbd>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            className="flex items-center gap-1 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-overlay cursor-pointer"
          >
            <X className="size-3.5" />
            <kbd className="hidden md:inline-block ml-0.5 text-[9px] font-mono text-subtle-foreground">
              Esc
            </kbd>
          </Button>
        </div>
      </div>

      {/* Selected Viewport Hole Cutout & Border */}
      <div
        onMouseDown={handleMouseDownRegion}
        style={{
          left: `${bounds.x}px`,
          top: `${bounds.y}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        }}
        className="absolute z-[105] cursor-move border-2 border-primary bg-primary/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-shadow"
      >
        {/* Top-Left Live Dimension Badge */}
        <div className="absolute -top-7 left-0 flex items-center gap-1.5 rounded-md bg-primary px-2 py-0.5 text-[11px] font-semibold font-mono text-primary-foreground shadow-md pointer-events-none">
          <Move className="size-3" />
          <span>
            {bounds.width} × {bounds.height}
          </span>
          <span className="opacity-80 text-[10px]">({ratioLabel})</span>
        </div>

        {/* Center Guide Crosshair Lines */}
        <div className="absolute inset-0 pointer-events-none opacity-30 flex items-center justify-center">
          <div className="w-full h-px border-b border-dashed border-primary" />
          <div className="h-full w-px border-r border-dashed border-primary absolute" />
        </div>

        {/* Resize Handles */}
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "nw")}
          className="absolute -top-1.5 -left-1.5 size-3.5 rounded-full border-2 border-primary bg-surface cursor-nwse-resize hover:scale-125 transition-transform"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "ne")}
          className="absolute -top-1.5 -right-1.5 size-3.5 rounded-full border-2 border-primary bg-surface cursor-nesw-resize hover:scale-125 transition-transform"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "sw")}
          className="absolute -bottom-1.5 -left-1.5 size-3.5 rounded-full border-2 border-primary bg-surface cursor-nesw-resize hover:scale-125 transition-transform"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "se")}
          className="absolute -bottom-1.5 -right-1.5 size-3.5 rounded-full border-2 border-primary bg-surface cursor-nwse-resize hover:scale-125 transition-transform"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "n")}
          className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-6 h-2 rounded-full border border-primary bg-surface cursor-ns-resize"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "s")}
          className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-6 h-2 rounded-full border border-primary bg-surface cursor-ns-resize"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "w")}
          className="absolute -left-1.5 top-1/2 -translate-y-1/2 h-6 w-2 rounded-full border border-primary bg-surface cursor-ew-resize"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "e")}
          className="absolute -right-1.5 top-1/2 -translate-y-1/2 h-6 w-2 rounded-full border border-primary bg-surface cursor-ew-resize"
        />
      </div>
    </div>
  )
}
