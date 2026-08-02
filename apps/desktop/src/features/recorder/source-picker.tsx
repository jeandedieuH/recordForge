import { useEffect, useState } from "react"
import { Button, Input } from "@recordforge/ui"
import type { Bounds, CaptureSource } from "@recordforge/contracts"
import { listCaptureSources } from "../../lib/recorder"

interface SourcePickerProps {
  value?: CaptureSource | null
  onSelect: (source: CaptureSource) => void
}

type SourceTab = "display" | "window" | "region"

function boundsInputValue(value: number) {
  return Number.isFinite(value) ? String(value) : ""
}

function parseBoundsValue(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

// Tabbed picker for capture sources. It fetches the list of available displays
// and windows directly from the Rust recorder and lets the user either pick one
// or define a custom screen region.
export function SourcePicker({ value, onSelect }: SourcePickerProps) {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<SourceTab>(value?.kind ?? "display")

  const [regionBounds, setRegionBounds] = useState<Bounds>({
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  })
  const [prefillDisplayId, setPrefillDisplayId] = useState<string>("")

  const displays = sources.filter((s) => s.kind === "display")
  const windows = sources.filter((s) => s.kind === "window")

  async function loadSources() {
    setIsLoading(true)
    setError(null)
    try {
      const result = await listCaptureSources()
      setSources(result)
      if (value?.kind === "region") setRegionBounds(value.bounds)
      if (prefillDisplayId === "" && result.some((s) => s.kind === "display")) {
        const firstDisplay = result.find((s) => s.kind === "display")
        if (firstDisplay) setPrefillDisplayId(firstDisplay.id)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (value?.kind === "region") {
      setActiveTab("region")
      setRegionBounds(value.bounds)
    }
  }, [value])

  function handleSelectSource(source: CaptureSource) {
    onSelect(source)
    setActiveTab(source.kind)
  }

  function handleRegionChange(field: keyof Bounds, input: string) {
    setRegionBounds((prev) => ({ ...prev, [field]: parseBoundsValue(input) }))
  }

  function handlePrefillDisplayChange(displayId: string) {
    setPrefillDisplayId(displayId)
    const display = displays.find((d) => d.id === displayId)
    if (display) setRegionBounds(display.bounds)
  }

  function handleSelectRegion() {
    if (regionBounds.width < 1 || regionBounds.height < 1) return

    const regionSource: CaptureSource = {
      kind: "region",
      id: crypto.randomUUID(),
      name: `Region ${regionBounds.width}x${regionBounds.height}`,
      bounds: regionBounds,
    }

    onSelect(regionSource)
  }

  const selectedId = value?.id ?? ""

  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <div className="mb-3 flex gap-2 border-b border-border pb-2">
        {(["display", "window", "region"] as SourceTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`rounded-t px-3 py-1 text-sm font-medium capitalize ${
              activeTab === tab ? "border-b-2 border-primary text-primary" : "text-foreground/70"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {error ? <div className="mb-2 text-sm text-red-600">{error}</div> : null}

      {activeTab === "display" ? (
        <div className="space-y-2">
          {isLoading ? <p className="text-sm text-foreground/70">Loading displays...</p> : null}
          {displays.map((source) => (
            <button
              key={source.id}
              type="button"
              onClick={() => handleSelectSource(source)}
              className={`w-full rounded border p-2 text-left text-sm ${
                selectedId === source.id
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:bg-muted"
              }`}
            >
              <span className="mr-2">🖥️</span>
              {source.name} ({source.bounds.width}x{source.bounds.height})
            </button>
          ))}
          {!isLoading && displays.length === 0 ? (
            <p className="text-sm text-foreground/70">No displays found.</p>
          ) : null}
        </div>
      ) : null}

      {activeTab === "window" ? (
        <div className="space-y-2">
          {isLoading ? <p className="text-sm text-foreground/70">Loading windows...</p> : null}
          {windows.map((source) => (
            <button
              key={source.id}
              type="button"
              onClick={() => handleSelectSource(source)}
              className={`w-full rounded border p-2 text-left text-sm ${
                selectedId === source.id
                  ? "border-primary bg-primary/10"
                  : "border-border bg-background hover:bg-muted"
              }`}
            >
              <span className="mr-2">🪟</span>
              {source.name} ({source.bounds.width}x{source.bounds.height})
            </button>
          ))}
          {!isLoading && windows.length === 0 ? (
            <p className="text-sm text-foreground/70">No windows found.</p>
          ) : null}
        </div>
      ) : null}

      {activeTab === "region" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="region-x">
                X
              </label>
              <Input
                id="region-x"
                type="number"
                value={boundsInputValue(regionBounds.x)}
                onChange={(e) => handleRegionChange("x", e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="region-y">
                Y
              </label>
              <Input
                id="region-y"
                type="number"
                value={boundsInputValue(regionBounds.y)}
                onChange={(e) => handleRegionChange("y", e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="region-width">
                Width
              </label>
              <Input
                id="region-width"
                type="number"
                value={boundsInputValue(regionBounds.width)}
                onChange={(e) => handleRegionChange("width", e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium" htmlFor="region-height">
                Height
              </label>
              <Input
                id="region-height"
                type="number"
                value={boundsInputValue(regionBounds.height)}
                onChange={(e) => handleRegionChange("height", e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium" htmlFor="prefill-display">
                Pre-fill from display
              </label>
              <select
                id="prefill-display"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                value={prefillDisplayId}
                onChange={(e) => handlePrefillDisplayChange(e.target.value)}
              >
                <option value="">Select a display</option>
                {displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.bounds.width}x{d.bounds.height})
                  </option>
                ))}
              </select>
            </div>
            <Button
              onClick={handleSelectRegion}
              disabled={regionBounds.width < 1 || regionBounds.height < 1}
            >
              Select region
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
