import { useEffect, useRef, useState } from "react"
import { FileUp } from "lucide-react"
import { z } from "zod"
import type { CaptionPlacement, CaptionStylePreset } from "@recordforge/contracts"
import {
  captionFormatFromFileName,
  createImportCaptionCuesCommand,
  parseCaptionText,
} from "@recordforge/editor-core"
import { cn, useToast } from "@recordforge/ui"
import { useTimelineStore } from "../../../stores/timeline-store"
import { invokeValidated } from "../../../lib/ipc"

interface CaptionImportPanelProps {
  style: CaptionStylePreset
  placement: CaptionPlacement
}

const CAPTION_PATH_PATTERN = /\.(srt|vtt)$/i

export function CaptionImportPanel({ style, placement }: CaptionImportPanelProps) {
  const execute = useTimelineStore((state) => state.execute)
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const dropzoneRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle")
  const [message, setMessage] = useState<string | null>(null)

  // The Tauri drop listener is registered once; the ref keeps the latest
  // look defaults visible inside its callback.
  const defaultsRef = useRef({ style, placement })
  defaultsRef.current = { style, placement }

  function importText(fileName: string, text: string) {
    const format = captionFormatFromFileName(fileName)
    if (!format) {
      setStatus("error")
      setMessage("Choose an SRT or VTT caption file.")
      return
    }
    setStatus("loading")
    setMessage(null)
    try {
      const result = parseCaptionText(text, format)
      if (!result.ok) {
        setStatus("error")
        setMessage(result.error.message)
        return
      }
      const applied = execute(
        createImportCaptionCuesCommand(result.value.cues, {
          style: defaultsRef.current.style,
          placement: defaultsRef.current.placement,
        }),
      )
      if (!applied) {
        setStatus("error")
        setMessage("The captions could not be added — cues must not overlap existing ones.")
        return
      }
      setStatus("idle")
      setMessage(null)
      toast({
        title: "Captions imported",
        description: `${result.value.cues.length} cues added to the captions track.`,
        variant: "success",
      })
    } catch {
      setStatus("error")
      setMessage("The caption file could not be read.")
    }
  }

  async function importPath(path: string) {
    try {
      const text = await invokeValidated("read_caption_source", { path }, z.string())
      importText(path, text)
    } catch (error) {
      setStatus("error")
      setMessage(error instanceof Error ? error.message : "The caption file could not be read.")
    }
  }

  // Tauri delivers drops as filesystem paths (not File handles), scoped to the
  // dropzone rect so files dropped elsewhere in the window don't import.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    function isOverDropzone(position: { x: number; y: number }): boolean {
      const rect = dropzoneRef.current?.getBoundingClientRect()
      if (!rect) return false
      const ratio = window.devicePixelRatio || 1
      return (
        position.x >= rect.left * ratio &&
        position.x <= rect.right * ratio &&
        position.y >= rect.top * ratio &&
        position.y <= rect.bottom * ratio
      )
    }

    try {
      import("@tauri-apps/api/webview")
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            const payload = event.payload
            if (payload.type === "enter" || payload.type === "over") {
              setDragging(isOverDropzone(payload.position))
            } else if (payload.type === "drop") {
              setDragging(false)
              if (!isOverDropzone(payload.position)) return
              const path = payload.paths.find((candidate) => CAPTION_PATH_PATTERN.test(candidate))
              if (path) void importPath(path)
            } else {
              setDragging(false)
            }
          }),
        )
        .then((fn) => {
          if (cancelled) fn()
          else unlisten = fn
        })
        .catch(() => {})
    } catch {
      // Browser dev mode (bun run dev) — drag-drop is a no-op outside Tauri.
    }
    return () => {
      cancelled = true
      unlisten?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    try {
      importText(file.name, await file.text())
    } catch {
      setStatus("error")
      setMessage("The caption file could not be read.")
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        onChange={(event) => void handleFileChange(event)}
      />
      <div
        ref={dropzoneRef}
        role="button"
        tabIndex={0}
        aria-label="Import captions — drop an SRT or VTT file, or press Enter to browse"
        aria-disabled={status === "loading"}
        onClick={() => status !== "loading" && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-5 text-center transition-colors duration-fast ease-forge",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
          dragging
            ? "border-primary/70 bg-primary/10"
            : "border-border bg-surface-dim hover:border-border-strong hover:bg-surface",
          status === "loading" && "pointer-events-none opacity-60",
        )}
      >
        <FileUp
          className={cn("size-5", dragging ? "text-primary" : "text-subtle-foreground")}
          aria-hidden
        />
        <p className="text-xs font-medium text-foreground">
          {status === "loading" ? "Reading captions…" : "Drop an SRT or VTT file"}
        </p>
        <p className="text-[11px] text-subtle-foreground">or click to browse</p>
      </div>
      {message ? (
        <p className="text-xs text-destructive" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  )
}
