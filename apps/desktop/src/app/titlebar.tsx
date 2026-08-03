import { getCurrentWindow } from "@tauri-apps/api/window"
import { Copy, Flame, Minus, Square, X } from "lucide-react"
import { useEffect, useState } from "react"
import { IconButton } from "@recordforge/ui"
import { isTauri } from "../lib/settings"

interface TitlebarProps {
  /** Current view name shown as a breadcrumb next to the wordmark. */
  view: string
}

// Custom frameless titlebar: drag region, wordmark + view breadcrumb left,
// minimize / maximize / close right. Replaces the native window chrome.
export function Titlebar({ view }: TitlebarProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  const appWindow = isTauri() ? getCurrentWindow() : null

  useEffect(() => {
    if (!appWindow) return
    void appWindow.isMaximized().then(setIsMaximized)
    const unlisten = appWindow.onResized(() => {
      void appWindow.isMaximized().then(setIsMaximized)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [appWindow])

  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center justify-between border-b border-border pr-1 pl-3 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2">
        <Flame className="size-4 text-accent" aria-hidden />
        <span className="text-sm font-semibold tracking-tight">
          record<span className="text-accent">Forge</span>
        </span>
        <span className="text-sm text-subtle-foreground" aria-hidden>
          /
        </span>
        <span className="text-sm text-muted-foreground">{view}</span>
      </div>

      <div className="flex items-center gap-0.5">
        <IconButton label="Minimize" size="sm" onClick={() => void appWindow?.minimize()}>
          <Minus />
        </IconButton>
        <IconButton
          label={isMaximized ? "Restore" : "Maximize"}
          size="sm"
          onClick={() => void appWindow?.toggleMaximize()}
        >
          {isMaximized ? <Copy /> : <Square />}
        </IconButton>
        <IconButton
          label="Close"
          size="sm"
          className="hover:bg-recording/15 hover:text-recording"
          onClick={() => void appWindow?.close()}
        >
          <X />
        </IconButton>
      </div>
    </header>
  )
}
