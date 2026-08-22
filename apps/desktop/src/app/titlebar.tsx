import { getCurrentWindow } from "@tauri-apps/api/window"
import { Copy, Minus, Square, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@recordforge/ui"
import { isTauri } from "../lib/settings"

interface TitlebarProps {
  /** Current view name shown as a header title. */
  view: string
  /** Callback when user clicks the main Record action button. */
  onOpenRecord?: () => void
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
        {/* Primary Record Action Button */}
        {onOpenRecord ? (
          <Button
            onClick={onOpenRecord}
            className="bg-recording hover:bg-recording-hover text-white font-medium text-xs px-4 py-1.5 h-8 rounded-md flex items-center gap-2 shadow-sm border-0 cursor-pointer"
          >
            <span className="size-2 rounded-full bg-white animate-pulse" />
            <span>Record</span>
          </Button>
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
