import { useRef, useState } from "react"
import { Captions, FileUp } from "lucide-react"
import type { CaptionPlacement, CaptionStylePreset } from "@recordforge/contracts"
import {
  captionFormatFromFileName,
  createImportCaptionCuesCommand,
  parseCaptionText,
} from "@recordforge/editor-core"
import { Badge, Button, EmptyState, SimpleSelect } from "@recordforge/ui"
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
          <div className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            <span>Style</span>
            <SimpleSelect
              aria-label="Caption style"
              size="sm"
              value={style}
              onValueChange={(val) => setStyle(val as CaptionStylePreset)}
              options={[
                { value: "default", label: "Default" },
                { value: "minimal", label: "Minimal" },
                { value: "boxed", label: "Boxed" },
                { value: "highlight", label: "Highlight" },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1 text-[11px] text-subtle-foreground">
            <span>Placement</span>
            <SimpleSelect
              aria-label="Caption placement"
              size="sm"
              value={placement}
              onValueChange={(val) => setPlacement(val as CaptionPlacement)}
              options={[
                { value: "top", label: "Top safe area" },
                { value: "center", label: "Center safe area" },
                { value: "bottom", label: "Bottom safe area" },
              ]}
            />
          </div>
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
