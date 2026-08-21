import type { CameraPlacementPreset } from "@recordforge/contracts"
import { cn } from "@recordforge/ui"

interface CameraPresetThumbnailProps {
  preset: CameraPlacementPreset
  className?: string
}

// Small SVG preview for each placement preset. The shapes use the parent text
// color so the thumbnails automatically adapt to selected / unselected states.
export function CameraPresetThumbnail({ preset, className }: CameraPresetThumbnailProps) {
  return (
    <svg
      viewBox="0 0 80 50"
      className={cn("h-8 w-auto", className)}
      fill="currentColor"
      aria-hidden
    >
      {preset === "camera-only" ? (
        <>
          <rect x="2" y="2" width="76" height="46" rx="5" opacity={0.9} />
          <circle cx="40" cy="25" r="6" opacity={0.5} />
        </>
      ) : null}

      {preset === "vertical-pip" ? (
        <>
          <rect x="2" y="2" width="76" height="46" rx="5" opacity={0.35} />
          <rect x="54" y="10" width="18" height="38" rx="3" />
        </>
      ) : null}

      {preset === "circle-pip" ? (
        <>
          <rect x="2" y="2" width="76" height="46" rx="5" opacity={0.35} />
          <circle cx="62" cy="36" r="11" />
        </>
      ) : null}

      {preset === "side-by-side" ? (
        <>
          <rect x="2" y="7" width="58" height="36" rx="4" opacity={0.35} />
          <rect x="62" y="13" width="16" height="24" rx="3" />
        </>
      ) : null}
    </svg>
  )
}
