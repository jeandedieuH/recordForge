import { getCurrentWindow } from "@tauri-apps/api/window"
import { Minus, ScrollText, X } from "lucide-react"
import { cn, IconButton, ToggleGroup, ToggleGroupItem } from "@recordforge/ui"
import { isTauri } from "../../../lib/settings"
import { useTeleprompterStore } from "../teleprompter-store"

interface TeleprompterTitlebarProps {
  /** Chrome auto-hide state; the bar keeps its space but fades out. */
  visible: boolean
  /** e.g. "2:14 left" or "Done" — only rendered in prompt mode. */
  statusText: string | null
}

export function TeleprompterTitlebar({ visible, statusText }: TeleprompterTitlebarProps) {
  const mode = useTeleprompterStore((state) => state.mode)
  const setMode = useTeleprompterStore((state) => state.setMode)
  const hasNotes = useTeleprompterStore((state) => state.notes.trim() !== "")

  const minimize = () => {
    if (isTauri()) void getCurrentWindow().minimize()
  }
  const close = () => {
    if (isTauri()) void getCurrentWindow().close()
  }

  return (
    <header
      data-testid="teleprompter-titlebar"
      data-teleprompter-chrome
      // "deep": the whole bar drags; Tauri still excludes clickable descendants.
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-10 shrink-0 select-none items-center gap-2 border-b border-border/60 px-2.5 transition-opacity duration-base ease-forge",
        !visible && "pointer-events-none opacity-0",
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent/15 text-accent">
          <ScrollText className="size-3.5" aria-hidden />
        </span>
        <span className="text-xs font-semibold tracking-wide text-muted-foreground max-[500px]:hidden">
          Teleprompter
        </span>
      </div>

      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(value) => {
          // Radix reports "" on re-click — deselection is not allowed here.
          if (value === "edit" || value === "prompt") setMode(value)
        }}
        aria-label="Teleprompter mode"
        className="rounded-md border border-border/60 bg-surface/60 p-0.5"
      >
        <ToggleGroupItem value="edit" aria-label="Edit script" className="h-6 px-2.5 text-xs">
          Edit
        </ToggleGroupItem>
        <ToggleGroupItem
          value="prompt"
          aria-label="Prompt mode"
          disabled={!hasNotes}
          className="h-6 px-2.5 text-xs"
        >
          Prompt
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="min-w-2 flex-1" />

      {statusText ? (
        <span className="tnum shrink-0 text-xs text-muted-foreground">{statusText}</span>
      ) : null}
      <IconButton label="Minimize" onClick={minimize} className="size-8">
        <Minus className="size-4" aria-hidden />
      </IconButton>
      <IconButton
        label="Close"
        onClick={close}
        className="size-8 hover:bg-destructive/15 hover:text-destructive"
      >
        <X className="size-4" aria-hidden />
      </IconButton>
    </header>
  )
}
