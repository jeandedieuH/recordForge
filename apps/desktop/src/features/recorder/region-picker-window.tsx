import { useCallback, useEffect, useRef, useState } from "react"
import { emit } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Check, Crop, Ratio, X } from "lucide-react"
import { Button } from "@recordforge/ui"
import { boundsSchema, type Bounds } from "@recordforge/contracts"

type AspectRatioOption = "free" | "16:9" | "4:3" | "1:1"
type ResizeHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | null

const ASPECT_RATIOS: Record<Exclude<AspectRatioOption, "free">, number> = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1 / 1,
}

// Minimum selectable size in physical pixels. Keeps the region usable after
// scaling and avoids degenerate crops for the encoder.
const MIN_PHYSICAL_SIZE = 64

function toEven(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function clampPhysical(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

// Fullscreen window that covers exactly one monitor (positioned by Rust) and
// lets the user draw, drag, and fine-tune the capture region. On confirm the
// CSS-pixel selection is converted to absolute physical desktop coordinates
// using the window's own position and the monitor scale factor, then broadcast
// to the main window via the `region-selected` event.
export function RegionPickerWindow() {
  const windowEl = useRef<HTMLDivElement>(null)

  const [bounds, setBounds] = useState<Bounds>(() => ({
    x: Math.round(window.innerWidth * 0.15),
    y: Math.round(window.innerHeight * 0.15),
    width: Math.round(window.innerWidth * 0.7),
    height: Math.round(window.innerHeight * 0.7),
  }))
  const [aspectRatio, setAspectRatio] = useState<AspectRatioOption>("free")
  const [isDrawing, setIsDrawing] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [resizingHandle, setResizingHandle] = useState<ResizeHandle>(null)
  const [isClosing, setIsClosing] = useState(false)

  const dragStartRef = useRef({ x: 0, y: 0 })
  const initialBoundsRef = useRef<Bounds>({ ...bounds })

  const applyAspectRatio = useCallback(
    (w: number, h: number, ratioOpt: AspectRatioOption, priority: "width" | "height" = "width") => {
      if (ratioOpt === "free") return { width: w, height: h }
      const ratio = ASPECT_RATIOS[ratioOpt]
      if (priority === "width") return { width: w, height: Math.round(w / ratio) }
      return { width: Math.round(h * ratio), height: h }
    },
    [],
  )

  const closeWindow = useCallback(async () => {
    setIsClosing(true)
    try {
      await getCurrentWindow().close()
    } catch {
      setIsClosing(false)
    }
  }, [])

  const handleConfirm = useCallback(async () => {
    if (isClosing) return
    setIsClosing(true)
    try {
      // The picker window covers its monitor exactly, so CSS (0,0) is the
      // monitor's top-left corner. Convert the selection from CSS pixels to
      // physical desktop coordinates via the window origin and scale factor.
      const win = getCurrentWindow()
      const origin = await win.outerPosition()
      const scale = window.devicePixelRatio

      const physicalWidth = clampPhysical(
        toEven(bounds.width * scale),
        MIN_PHYSICAL_SIZE,
        Math.round(window.innerWidth * scale),
      )
      const physicalHeight = clampPhysical(
        toEven(bounds.height * scale),
        MIN_PHYSICAL_SIZE,
        Math.round(window.innerHeight * scale),
      )

      const physicalBounds = boundsSchema.parse({
        x: origin.x + Math.round(bounds.x * scale),
        y: origin.y + Math.round(bounds.y * scale),
        width: physicalWidth,
        height: physicalHeight,
      })

      await emit("region-selected", { bounds: physicalBounds })
      await win.close()
    } catch {
      setIsClosing(false)
    }
  }, [bounds, isClosing])

  const handleCancel = useCallback(() => {
    void closeWindow()
  }, [closeWindow])

  const handleMouseDownCanvas = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const rect = windowEl.current?.getBoundingClientRect()
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

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDrawing && !isMoving && !resizingHandle) return

      const deltaX = e.clientX - dragStartRef.current.x
      const deltaY = e.clientY - dragStartRef.current.y
      const init = initialBoundsRef.current
      const screenW = window.innerWidth
      const screenH = window.innerHeight

      if (isDrawing) {
        const rawW = Math.max(2, Math.abs(deltaX))
        const rawH = Math.max(2, Math.abs(deltaY))
        const x = deltaX >= 0 ? init.x : init.x + deltaX
        const y = deltaY >= 0 ? init.y : init.y + deltaY
        const sized = applyAspectRatio(rawW, rawH, aspectRatio, rawW >= rawH ? "width" : "height")
        setBounds({
          x: clampPhysical(Math.round(x), 0, screenW - 2),
          y: clampPhysical(Math.round(y), 0, screenH - 2),
          width: clampPhysical(sized.width, 2, screenW - x),
          height: clampPhysical(sized.height, 2, screenH - y),
        })
      } else if (isMoving) {
        setBounds({
          ...init,
          x: Math.round(clampPhysical(init.x + deltaX, 0, screenW - init.width)),
          y: Math.round(clampPhysical(init.y + deltaY, 0, screenH - init.height)),
        })
      } else if (resizingHandle) {
        let x = init.x
        let y = init.y
        let w = init.width
        let h = init.height

        if (resizingHandle.includes("e")) w = init.width + deltaX
        if (resizingHandle.includes("s")) h = init.height + deltaY
        if (resizingHandle.includes("w")) {
          w = init.width - deltaX
          x = init.x + deltaX
        }
        if (resizingHandle.includes("n")) {
          h = init.height - deltaY
          y = init.y + deltaY
        }

        const sized = applyAspectRatio(Math.max(2, w), Math.max(2, h), aspectRatio, "width")
        const finalW = Math.min(sized.width, screenW)
        const finalH = Math.min(sized.height, screenH)
        setBounds({
          x: Math.round(clampPhysical(x, 0, screenW - finalW)),
          y: Math.round(clampPhysical(y, 0, screenH - finalH)),
          width: finalW,
          height: finalH,
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        handleCancel()
      } else if (e.key === "Enter") {
        e.preventDefault()
        void handleConfirm()
      } else if (e.key.startsWith("Arrow")) {
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
  }, [handleCancel, handleConfirm])

  const scale = window.devicePixelRatio
  const physicalW = Math.round(bounds.width * scale)
  const physicalH = Math.round(bounds.height * scale)

  return (
    <div
      ref={windowEl}
      onMouseDown={handleMouseDownCanvas}
      className="fixed inset-0 cursor-crosshair select-none overflow-hidden"
    >
      {/* Selection rectangle with a dimming "hole" */}
      <div
        onMouseDown={handleMouseDownRegion}
        style={{
          left: `${bounds.x}px`,
          top: `${bounds.y}px`,
          width: `${bounds.width}px`,
          height: `${bounds.height}px`,
        }}
        className="absolute cursor-move border-2 border-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
      >
        {/* Live dimension badge */}
        <div className="pointer-events-none absolute -top-8 left-0 flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 font-mono text-[11px] font-semibold text-primary-foreground shadow-lg">
          <span>
            {physicalW} × {physicalH}
          </span>
          <span className="text-[10px] opacity-80">px</span>
        </div>

        {/* Thirds guides */}
        <div className="pointer-events-none absolute inset-0 opacity-25">
          <div className="absolute top-1/3 h-px w-full bg-primary" />
          <div className="absolute top-2/3 h-px w-full bg-primary" />
          <div className="absolute left-1/3 h-full w-px bg-primary" />
          <div className="absolute left-2/3 h-full w-px bg-primary" />
        </div>

        {/* Resize handles */}
        {(
          [
            ["nw", "-top-1.5 -left-1.5 cursor-nwse-resize"],
            ["ne", "-top-1.5 -right-1.5 cursor-nesw-resize"],
            ["sw", "-bottom-1.5 -left-1.5 cursor-nesw-resize"],
            ["se", "-bottom-1.5 -right-1.5 cursor-nwse-resize"],
          ] as const
        ).map(([handle, position]) => (
          <div
            key={handle}
            onMouseDown={(e) => handleMouseDownHandle(e, handle)}
            className={`absolute size-3.5 rounded-full border-2 border-primary bg-surface transition-transform hover:scale-125 ${position}`}
          />
        ))}
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "n")}
          className="absolute -top-1 left-1/2 h-2 w-7 -translate-x-1/2 cursor-ns-resize rounded-full border border-primary bg-surface"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "s")}
          className="absolute -bottom-1 left-1/2 h-2 w-7 -translate-x-1/2 cursor-ns-resize rounded-full border border-primary bg-surface"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "w")}
          className="absolute top-1/2 -left-1 h-7 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border border-primary bg-surface"
        />
        <div
          onMouseDown={(e) => handleMouseDownHandle(e, "e")}
          className="absolute top-1/2 -right-1 h-7 w-2 -translate-y-1/2 cursor-ew-resize rounded-full border border-primary bg-surface"
        />
      </div>

      {/* Control bar */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-5 z-10 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border-strong bg-surface/95 px-4 py-2.5 shadow-e3 backdrop-blur-xl"
      >
        <div className="flex items-center gap-2 border-r border-border/60 pr-3">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary/20 text-primary">
            <Crop className="size-4" aria-hidden />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold leading-tight text-foreground">Select Region</span>
            <span className="font-mono text-[10px] text-subtle-foreground">
              {physicalW} × {physicalH} px
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-border/50 bg-surface-dim p-1">
          <Ratio className="mx-1.5 size-3.5 text-muted-foreground" aria-hidden />
          {(["free", "16:9", "4:3", "1:1"] as AspectRatioOption[]).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => {
                setAspectRatio(opt)
                if (opt !== "free") {
                  const adjusted = applyAspectRatio(bounds.width, bounds.height, opt, "width")
                  const width = Math.min(adjusted.width, window.innerWidth - bounds.x)
                  const height = Math.min(adjusted.height, window.innerHeight - bounds.y)
                  setBounds((prev) => ({ ...prev, width, height }))
                }
              }}
              className={`cursor-pointer rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-all ${
                aspectRatio === opt
                  ? "bg-primary font-semibold text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 border-l border-border/60 pl-3">
          <Button
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={isClosing}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md hover:brightness-110"
          >
            <Check className="size-3.5" aria-hidden />
            <span>Confirm</span>
            <kbd className="ml-1 hidden rounded bg-black/20 px-1 py-0.5 font-mono text-[9px] md:inline-block">
              Enter
            </kbd>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            className="flex cursor-pointer items-center gap-1 rounded-lg text-xs text-muted-foreground hover:bg-overlay hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
            <kbd className="font-mono text-[9px] text-subtle-foreground">Esc</kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}
