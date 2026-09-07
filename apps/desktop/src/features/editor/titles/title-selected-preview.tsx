import { useMemo, useState } from "react"
import type { TextClip, TextPresetRecord } from "@recordforge/editor-core"
import { Button, IconButton, NativeSelect, Slider, Switch } from "@recordforge/ui"
import { Pause, Plus, RotateCcw } from "lucide-react"
import { TitlePreview } from "./title-preview"
import { TITLE_PREVIEW_STILL_MS, type TitleReplaceOptions } from "./title-preview-plan"

interface TitleSelectedPreviewProps {
  preset: TextPresetRecord
  previewClip?: TextClip
  canvasWidth: number
  canvasHeight: number
  onAdd?: (preset: TextPresetRecord) => void
  onReplace?: (preset: TextPresetRecord, options?: TitleReplaceOptions) => void
}

export function TitleSelectedPreview({
  preset,
  previewClip,
  canvasWidth,
  canvasHeight,
  onAdd,
  onReplace,
}: TitleSelectedPreviewProps) {
  const [playing, setPlaying] = useState(false)
  const [replayKey, setReplayKey] = useState(0)
  const [timeMs, setTimeMs] = useState(TITLE_PREVIEW_STILL_MS)
  const [background, setBackground] = useState<"neutral" | "light">("neutral")
  const [preserveLayout, setPreserveLayout] = useState(true)
  const [preserveStyle, setPreserveStyle] = useState(false)
  const options = useMemo(
    () => ({ preserveLayout, preserveStyle }),
    [preserveLayout, preserveStyle],
  )
  const duration = previewClip?.durationMs ?? 4000
  const currentTime = Math.min(timeMs, duration - 1)

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-container-low p-2.5"
      aria-label="Selected title preview"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-xs font-semibold text-foreground">{preset.name}</h4>
          <p className="line-clamp-2 text-xs text-muted-foreground">{preset.description}</p>
        </div>
      </div>
      <div className="flex justify-center">
        <TitlePreview
          preset={preset}
          previewClip={previewClip}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          options={options}
          playing={playing}
          explicitPlayback
          replayKey={replayKey}
          timeMs={currentTime}
          onTimeChange={setTimeMs}
          onPlaybackEnd={() => setPlaying(false)}
          background={background}
          className={canvasHeight > canvasWidth ? "max-w-36" : undefined}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <IconButton
          label={playing ? "Pause title preview" : "Replay title preview"}
          className="size-7 shrink-0"
          onClick={() => {
            if (playing) setPlaying(false)
            else {
              setTimeMs(0)
              setReplayKey((value) => value + 1)
              setPlaying(true)
            }
          }}
        >
          {playing ? (
            <Pause className="size-3.5" aria-hidden />
          ) : (
            <RotateCcw className="size-3.5" aria-hidden />
          )}
        </IconButton>
        <Slider
          aria-label="Title preview time"
          min={0}
          max={Math.max(1, duration - 1)}
          step={10}
          value={[currentTime]}
          onValueChange={([value]) => {
            setPlaying(false)
            setTimeMs(value)
          }}
          size="sm"
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {(currentTime / 1000).toFixed(1)}s
        </span>
        <NativeSelect
          aria-label="Preview background"
          className="h-7 w-24 shrink-0 text-xs"
          value={background}
          onChange={(event) => setBackground(event.target.value as "neutral" | "light")}
        >
          <option value="neutral">Neutral</option>
          <option value="light">Light</option>
        </NativeSelect>
      </div>
      <p className="text-xs text-muted-foreground">
        {previewClip
          ? "Selected text · project canvas · sample background"
          : "Sample text · 16:9 canvas"}
      </p>
      {onReplace ? (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-2">
          <legend className="sr-only">Replacement options</legend>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={preserveLayout}
              onCheckedChange={setPreserveLayout}
              disabled={!previewClip}
            />
            Keep Layout
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={preserveStyle}
              onCheckedChange={setPreserveStyle}
              disabled={!previewClip}
            />
            Keep Style
          </label>
          <p className="w-full text-xs text-muted-foreground">
            Your words and timing stay unchanged.
          </p>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onAdd ? (
          <Button size="sm" className="flex-1" onClick={() => onAdd(preset)}>
            <Plus className="size-3.5" aria-hidden />
            Add New
          </Button>
        ) : null}
        {onReplace ? (
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => onReplace(preset, options)}
            disabled={!previewClip}
          >
            Replace Selected
          </Button>
        ) : null}
      </div>
    </section>
  )
}
