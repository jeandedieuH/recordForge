import type { CaptureSource } from "@recordforge/contracts"

interface CaptureBoundaryOverlayProps {
  source: CaptureSource | null
  isActive: boolean
  isPaused?: boolean
}

// Visual overlay that renders a primary-colored boundary line around the
// capture area (display, window, or region) while recording.
// Uses `pointer-events-none` so it never interferes with user mouse clicks.
export function CaptureBoundaryOverlay({
  source,
  isActive,
  isPaused = false,
}: CaptureBoundaryOverlayProps) {
  if (!isActive) return null

  const isRegion = source?.kind === "region" && source.bounds
  const bounds = isRegion ? source.bounds : null

  const style: React.CSSProperties = bounds
    ? {
        position: "fixed",
        left: `${bounds.x}px`,
        top: `${bounds.y}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
      }
    : {
        position: "fixed",
        inset: 0,
      }

  const targetName = source?.name || "Primary Display"

  return (
    <div
      style={style}
      className="pointer-events-none z-50 flex h-screen w-screen flex-col justify-between border-4 border-primary shadow-[0_0_30px_rgba(99,102,241,0.5)] transition-all duration-200 select-none"
    >
      {/* Top Header Badge */}
      <div className="flex w-full items-center justify-center pt-3">
        <div className="flex items-center gap-2 rounded-full border border-primary/50 bg-slate-950/95 px-4 py-1.5 text-xs font-bold text-white shadow-2xl backdrop-blur-xl">
          <span
            className={`size-2.5 rounded-full ${
              isPaused ? "bg-amber-400" : "bg-recording animate-pulse"
            }`}
          />
          <span className="truncate">
            {isPaused ? "PAUSED" : "RECORDING"} · {targetName}
            {bounds ? ` (${bounds.width}×${bounds.height})` : ""}
          </span>
        </div>
      </div>

      {/* Corner Frame Accents */}
      <div className="absolute top-0 left-0 size-5 border-t-4 border-l-4 border-primary" />
      <div className="absolute top-0 right-0 size-5 border-t-4 border-r-4 border-primary" />
      <div className="absolute bottom-0 left-0 size-5 border-b-4 border-l-4 border-primary" />
      <div className="absolute bottom-0 right-0 size-5 border-b-4 border-r-4 border-primary" />
    </div>
  )
}
