import { Crop, Pencil, X } from "lucide-react"
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@recordforge/ui"
import type { ScreenProfileId } from "@recordforge/contracts"
import { useRecorderStore } from "../../../hooks/use-recorder"

interface ScreenSourcePanelProps {
  onOpenRegionPicker: () => void
}

// Screen/window/region left column: source preview card, per-mode pickers
// and the screen quality profile. Camera mode renders a separate panel.
export function ScreenSourcePanel({ onOpenRegionPicker }: ScreenSourcePanelProps) {
  const {
    sources,
    sourcesLoaded,
    profiles,
    profilesLoaded,
    selectedSource,
    selectedSourceType,
    selectedProfileId,
    setSelectedSource,
    setSelectedSourceType,
    setSelectedProfileId,
  } = useRecorderStore()

  const displaySources = sources.filter((s) => s.kind === "display")
  const windowSources = sources.filter((s) => s.kind === "window")
  const regionSource = selectedSource?.kind === "region" ? selectedSource : null

  const selectedDisplayResolution = selectedSource?.bounds
    ? `${selectedSource.bounds.width}×${selectedSource.bounds.height}`
    : "2560×1440"

  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground">
        Video Source
      </h3>

      {/* Display Preview Thumbnail Container */}
      <div className="flex flex-col gap-1.5">
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(var(--color-primary)_1px,transparent_1px)] bg-size-[16px_16px]" />
          <div className="relative z-10 flex flex-col items-center gap-2 rounded-md border border-border-strong bg-surface/90 px-4 py-2 text-xs font-medium text-foreground backdrop-blur text-center max-w-[85%]">
            {!sourcesLoaded && !selectedSource ? (
              <Skeleton className="h-4 w-40 rounded" />
            ) : (
              <span className="truncate">
                {selectedSourceType === "region"
                  ? regionSource
                    ? regionSource.name
                    : "No region selected yet"
                  : `${selectedSource?.name || "Display 1"} (${selectedDisplayResolution})`}
              </span>
            )}
          </div>
        </div>

        {selectedSourceType === "screen" && displaySources.length > 1 ? (
          <Select
            value={selectedSource?.id || displaySources[0]?.id || ""}
            onValueChange={(val) => {
              const source = displaySources.find((s) => s.id === val)
              if (source) setSelectedSource(source)
            }}
          >
            <SelectTrigger className="border-border bg-surface-dim text-xs text-foreground mt-1">
              <SelectValue placeholder="Select display" />
            </SelectTrigger>
            <SelectContent>
              {displaySources.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.bounds.width}×{s.bounds.height})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {selectedSourceType === "window" ? (
          !sourcesLoaded ? (
            <Skeleton className="mt-1 h-9 w-full rounded-md" />
          ) : windowSources.length > 0 ? (
            <Select
              value={selectedSource?.id || windowSources[0]?.id || ""}
              onValueChange={(val) => {
                const source = windowSources.find((s) => s.id === val)
                if (source) setSelectedSource(source)
              }}
            >
              <SelectTrigger className="border-border bg-surface-dim text-xs text-foreground mt-1">
                <SelectValue placeholder="Select window" />
              </SelectTrigger>
              <SelectContent>
                {windowSources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-[11px] text-subtle-foreground mt-1">No open windows detected.</p>
          )
        ) : null}

        {selectedSourceType === "region" ? (
          regionSource ? (
            <div className="mt-1 flex items-center gap-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2">
              <Crop className="size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-foreground">
                  {regionSource.bounds.width}×{regionSource.bounds.height} region selected
                </div>
                <div className="truncate font-mono text-[10px] text-subtle-foreground">
                  at x={regionSource.bounds.x}, y={regionSource.bounds.y} (physical px)
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenRegionPicker}
                className="h-7 cursor-pointer gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3" aria-hidden />
                Redraw
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const display = displaySources[0] || sources.find((s) => s.kind === "display")
                  if (display) {
                    setSelectedSource(display)
                    setSelectedSourceType("screen")
                  }
                }}
                className="h-7 cursor-pointer px-2 text-muted-foreground hover:text-foreground"
                aria-label="Clear region selection"
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          ) : (
            <Button
              onClick={onOpenRegionPicker}
              className="mt-1 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-dim px-3 py-3 text-xs font-semibold text-foreground shadow-none transition-all hover:bg-overlay"
            >
              <Crop className="size-4 text-primary" aria-hidden />
              <span>Select Area on Screen</span>
            </Button>
          )
        ) : null}
      </div>

      {/* Quality Profile Select — `profiles` is screen-only; camera tiers
          live in the camera panel's quality picker. */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="modal-quality-profile"
          className="font-label text-xs font-bold tracking-wider uppercase text-subtle-foreground"
        >
          Quality Profile
        </label>
        {!profilesLoaded && profiles.length === 0 ? (
          <Skeleton className="h-9 w-full rounded-md" />
        ) : (
          <Select
            value={selectedProfileId}
            onValueChange={(val) => setSelectedProfileId(val as ScreenProfileId)}
          >
            <SelectTrigger
              id="modal-quality-profile"
              className="border-border bg-surface-dim text-xs text-foreground"
            >
              <SelectValue placeholder="Select quality profile" />
            </SelectTrigger>
            <SelectContent>
              {profiles.length > 0 ? (
                profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label} ({p.width}×{p.height}, {p.fps}fps)
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="balanced">Balanced (1080p, 30fps)</SelectItem>
              )}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  )
}
