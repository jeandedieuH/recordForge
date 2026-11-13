import { getCurrentWindow } from "@tauri-apps/api/window"
import { ChevronDown, Copy, Minus, Monitor, Square, Video, X } from "lucide-react"
import { useEffect, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@recordforge/ui"
import { isTauri } from "../lib/settings"

export type RecordSourceChoice = "screen" | "camera"

interface TitlebarProps {
  /** Current view name shown as a header title. */
  view: string
  /** Callback when the user starts a recording — carries the split-button's
      chosen mode (undefined = last-used mode). */
  onOpenRecord?: (source?: RecordSourceChoice) => void
}

export function Titlebar({ view, onOpenRecord }: TitlebarProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  const appWindow = isTauri() ? getCurrentWindow() : null

  useEffect(() => {
    if (!appWindow) return
    void appWindow
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {})
    const unlistenPromise = appWindow.onResized(() => {
      void appWindow
        .isMaximized()
        .then(setIsMaximized)
        .catch(() => {})
    })
    return () => {
      void unlistenPromise.then((fn) => fn()).catch(() => {})
    }
  }, [appWindow])

  return (
    <header
      data-tauri-drag-region
      className="flex h-16 shrink-0 items-center justify-between border-b border-border/40 px-6 select-none bg-background"
    >
      <div data-tauri-drag-region className="flex items-center gap-3">
        <h2 className="font-serif text-2xl font-bold tracking-tight text-foreground">{view}</h2>
      </div>

      <div className="flex items-center gap-3">
        {/* Primary Record split button — main half opens the last-used mode,
            the chevron picks screen vs camera explicitly. The dot stays solid:
            the pulse belongs to an active recording, not to a pending start. */}
        {onOpenRecord ? (
          <div className="flex items-stretch overflow-hidden rounded-lg border border-border-strong bg-surface-container-high shadow-e1">
            <button
              type="button"
              onClick={() => onOpenRecord()}
              className="flex h-8 cursor-pointer items-center gap-2 px-3 text-xs font-semibold text-foreground transition-colors duration-fast hover:bg-overlay focus-visible:bg-overlay focus-visible:outline-none"
            >
              <span className="size-2 shrink-0 rounded-full bg-recording" aria-hidden />
              <span>Record</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Choose what to record"
                  className="flex h-8 w-7 cursor-pointer items-center justify-center border-l border-border text-muted-foreground transition-colors duration-fast hover:bg-overlay hover:text-foreground focus-visible:bg-overlay focus-visible:outline-none"
                >
                  <ChevronDown className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onOpenRecord("screen")}>
                  <Monitor className="size-4" aria-hidden />
                  Record screen
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpenRecord("camera")}>
                  <Video className="size-4" aria-hidden />
                  Record camera
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        {/* Desktop Window Controls - Pinned to far right */}
        <div className="flex items-center -mr-2">
          <button
            type="button"
            onClick={() => void appWindow?.minimize()}
            title="Minimize"
            aria-label="Minimize"
            className="flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground active:bg-surface-container-high"
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void appWindow?.toggleMaximize()}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore" : "Maximize"}
            className="flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground active:bg-surface-container-high"
          >
            {isMaximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void appWindow?.close()}
            title="Close"
            aria-label="Close"
            className="flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[#e81123] hover:text-white active:bg-[#c40e1e]"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    </header>
  )
}
