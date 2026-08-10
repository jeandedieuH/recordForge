import { useRef, useState } from "react"
import { Captions, FileUp } from "lucide-react"
import type { CaptionPlacement, CaptionStylePreset } from "@recordforge/contracts"
import {
  captionFormatFromFileName,
  createImportCaptionCuesCommand,
  parseCaptionText,
} from "@recordforge/editor-core"
import { Badge, Button, EmptyState, NativeSelect } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"

export function CaptionImportPanel() {
  const execute = useTimelineStore((state) => state.execute)
  const captionTrack = useTimelineStore((state) =>
    state.engine?.history.present.tracks.find((track) => track.kind === "captions"),
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const [style, setStyle] = useState<CaptionStylePreset>("default")
  const [placement, setPlacement] = useState<CaptionPlacement>("bottom")
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    const format = captionFormatFromFileName(file.name)
    if (!format) {
      setStatus("error")
      setMessage("Choose an SRT or VTT caption file.")
      return
    }

    setStatus("loading")
    setMessage(null)
    try {
      const result = parseCaptionText(await file.text(), format)
      if (!result.ok) {
        setStatus("error")
        setMessage(result.error.message)
        return
      }
      const applied = execute(
        createImportCaptionCuesCommand(result.value.cues, {
          trackId: captionTrack?.id,
          style,
          placement,
        }),
      )
      if (!applied) {
        setStatus("error")
        setMessage("The captions could not be added to this project.")
        return
      }
      setStatus("success")
      setMessage(`${result.value.cues.length} caption cues imported.`)
    } catch {
      setStatus("error")
      setMessage("The caption file could not be read.")
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {captionTrack ? (
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface-dim px-3 py-2 text-xs">
          <span className="text-subtle-foreground">Cues in timeline</span>
          <Badge variant="outline">
            {captionTrack.clips.filter((clip) => clip.kind === "caption").length}
          </Badge>
        </div>
      ) : (
        <EmptyState
          icon={Captions}
          title="No captions track"
          description="Import a caption file to create an editable captions track without changing the original media."
          className="border border-dashed border-border bg-surface-dim p-4"
        />
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-dim p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            Style
            <NativeSelect
              aria-label="Caption style"
              value={style}
              onChange={(event) => setStyle(event.target.value as CaptionStylePreset)}
            >
              <option value="default">Default</option>
              <option value="minimal">Minimal</option>
              <option value="boxed">Boxed</option>
              <option value="highlight">Highlight</option>
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            Placement
            <NativeSelect
              aria-label="Caption placement"
              value={placement}
              onChange={(event) => setPlacement(event.target.value as CaptionPlacement)}
            >
              <option value="top">Top safe area</option>
              <option value="center">Center safe area</option>
              <option value="bottom">Bottom safe area</option>
            </NativeSelect>
          </label>
        </div>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".srt,.vtt,text/vtt,application/x-subrip"
          onChange={(event) => void handleFileChange(event)}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={status === "loading"}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp data-icon="inline-start" />
          {status === "loading" ? "Reading captions…" : "Import SRT or VTT"}
        </Button>
        {message ? (
          <p
            className={status === "error" ? "text-xs text-destructive" : "text-xs text-success"}
            role="status"
          >
            {message}
          </p>
        ) : null}
      </div>
    </div>
  )
}
