import { useCallback, useEffect, useRef, useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Pause, Play, X } from "lucide-react"
import { IconButton, Slider } from "@recordforge/ui"

const NOTES_STORAGE_KEY = "recordforge.teleprompter.notes"
const SETTINGS_STORAGE_KEY = "recordforge.teleprompter.settings"

interface TeleprompterSettings {
  speed: number // px per second while playing
  fontSize: number // px
  mirror: boolean
}

const DEFAULT_SETTINGS: TeleprompterSettings = { speed: 60, fontSize: 28, mirror: false }

function loadSettings(): TeleprompterSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

// Standalone auxiliary window — deliberately self-contained (own theme, own
// storage) so it opens instantly without booting the full app shell.
export function TeleprompterWindow() {
  const [notes, setNotes] = useState(() => localStorage.getItem(NOTES_STORAGE_KEY) ?? "")
  const [settings, setSettings] = useState<TeleprompterSettings>(loadSettings)
  const [playing, setPlaying] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)

  // Persist notes/settings — the prompter is opened fresh per session.
  useEffect(() => {
    localStorage.setItem(NOTES_STORAGE_KEY, notes)
  }, [notes])
  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  // Autoscroll: advance scrollTop in px/second via rAF.
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const el = scrollerRef.current
      if (el) {
        el.scrollTop += settings.speed * dt
        // Auto-pause at the end so the last line never scrolls off-screen.
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          setPlaying(false)
          return
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, settings.speed])

  const close = useCallback(() => {
    void getCurrentWindow().close()
  }, [])

  return (
    <div className="flex h-screen flex-col bg-black/95 text-white">
      <div
        className="flex items-center justify-between border-b border-white/10 px-3 py-2"
        data-tauri-drag-region
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
          Teleprompter
        </span>
        <div className="flex items-center gap-1">
          <IconButton
            label={playing ? "Pause" : "Play"}
            onClick={() => setPlaying((p) => !p)}
            className="text-white/80 hover:bg-white/10 hover:text-white"
          >
            {playing ? (
              <Pause className="size-4" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
          </IconButton>
          <IconButton
            label="Close teleprompter"
            onClick={close}
            className="text-white/80 hover:bg-white/10 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Paste your script or speaker notes here…"
          spellCheck={false}
          className="h-full min-h-[200px] w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-white/30"
          style={{
            fontSize: `${settings.fontSize}px`,
            transform: settings.mirror ? "scaleX(-1)" : undefined,
          }}
        />
      </div>

      <div className="flex items-center gap-4 border-t border-white/10 px-4 py-2.5 text-[11px] text-white/60">
        <label className="flex flex-1 items-center gap-2">
          <span className="shrink-0">Speed</span>
          <Slider
            value={[settings.speed]}
            onValueChange={([speed]) => setSettings((s) => ({ ...s, speed }))}
            min={10}
            max={240}
            step={10}
            className="flex-1"
            aria-label="Scroll speed"
          />
          <span className="w-12 text-right tabular-nums">{settings.speed} px/s</span>
        </label>
        <label className="flex flex-1 items-center gap-2">
          <span className="shrink-0">Size</span>
          <Slider
            value={[settings.fontSize]}
            onValueChange={([fontSize]) => setSettings((s) => ({ ...s, fontSize }))}
            min={16}
            max={56}
            step={2}
            className="flex-1"
            aria-label="Font size"
          />
          <span className="w-10 text-right tabular-nums">{settings.fontSize}px</span>
        </label>
      </div>
    </div>
  )
}
