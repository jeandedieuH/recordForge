import { getCurrentWindow } from "@tauri-apps/api/window"
import { ChevronDown, Copy, Minus, Monitor, Square, Video, X } from "lucide-react"
import { useEffect, useState } from "react"
import {
  Button,
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
            the chevron picks screen vs camera explicitly. */}
        {onOpenRecord ? (
          <div className="flex items-stretch">
            <Button
              onClick={() => onOpenRecord()}
              className="bg-recording hover:bg-recording-hover text-white font-medium text-xs px-4 py-1.5 h-8 rounded-l-md rounded-r-none flex items-center gap-2 shadow-sm border-0 cursor-pointer"
            >
              <span className="size-2 rounded-full bg-white animate-pulse" />
              <span>Record</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Choose what to record"
                  className="h-8 w-7 rounded-l-none rounded-r-md border-0 border-l border-white/25 bg-recording px-0 text-white shadow-sm hover:bg-recording-hover cursor-pointer"
                >
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
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
