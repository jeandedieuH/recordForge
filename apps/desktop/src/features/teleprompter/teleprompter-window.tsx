import { useCallback, useDeferredValue, useMemo, useState } from "react"
import { Play } from "lucide-react"
import { Button } from "@recordforge/ui"
import { ControlDock } from "./components/control-dock"
import { PrompterView } from "./components/prompter-view"
import { ScriptEditor } from "./components/script-editor"
import { TeleprompterTitlebar } from "./components/teleprompter-titlebar"
import { useAutoScroll, type PrompterScrollInfo } from "./hooks/use-auto-scroll"
import { useChromeVisibility } from "./hooks/use-chrome-visibility"
import { usePrompterMetrics } from "./hooks/use-prompter-metrics"
import { useTeleprompterShortcuts } from "./hooks/use-teleprompter-shortcuts"
import {
  countWords,
  estimateReadSeconds,
  estimateRemainingSeconds,
  formatClock,
  pxPerSecondFromWpm,
} from "./lib/teleprompter-math"
import { useTeleprompterStore } from "./teleprompter-store"

// Standalone auxiliary window — frameless + transparent, one rounded card
// floating over the desktop, always dark themed (wired in index.html/App.tsx).
export function TeleprompterWindow() {
  const notes = useTeleprompterStore((state) => state.notes)
  const settings = useTeleprompterStore((state) => state.settings)
  const mode = useTeleprompterStore((state) => state.mode)
  const playing = useTeleprompterStore((state) => state.playing)
  const restartToken = useTeleprompterStore((state) => state.restartToken)
  const setNotes = useTeleprompterStore((state) => state.setNotes)
  const setMode = useTeleprompterStore((state) => state.setMode)
  const play = useTeleprompterStore((state) => state.play)
  const togglePlay = useTeleprompterStore((state) => state.togglePlay)

  const hasNotes = notes.trim() !== ""
  const deferredNotes = useDeferredValue(notes)
  const wordCount = useMemo(() => countWords(deferredNotes), [deferredNotes])

  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null)
  const [textEl, setTextEl] = useState<HTMLDivElement | null>(null)
  const { viewportHeight, textHeight } = usePrompterMetrics(viewportEl, textEl)

  const pxPerSecond = pxPerSecondFromWpm({
    wpm: settings.wpm,
    wordCount,
    textHeight,
  })

  const [scrollInfo, setScrollInfo] = useState<PrompterScrollInfo>({
    position: 0,
    maxScroll: 0,
    progress: 0,
    atEnd: false,
  })

  const { seekTo } = useAutoScroll({
    viewportEl,
    playing,
    pxPerSecond,
    restartToken,
    relayoutKey: `${viewportHeight}:${textHeight}`,
    onProgress: setScrollInfo,
  })

  const [settingsOpen, setSettingsOpen] = useState(false)
  const chromeVisible = useChromeVisibility({ playing, pinned: settingsOpen })

  // Replay semantics: pressing Play at the end restarts the script from the top.
  const togglePlayOrReplay = useCallback(() => {
    if (!playing && scrollInfo.atEnd) seekTo(0)
    togglePlay()
  }, [playing, scrollInfo.atEnd, seekTo, togglePlay])

  useTeleprompterShortcuts({ onTogglePlay: togglePlayOrReplay })

  // Derived live (not pushed by the engine) so a speed change while paused
  // updates the countdown immediately.
  const statusText =
    mode === "prompt"
      ? scrollInfo.atEnd
        ? "Done"
        : `${formatClock(
            estimateRemainingSeconds({
              position: scrollInfo.position,
              maxScroll: scrollInfo.maxScroll,
              pxPerSecond,
            }),
          )} left`
      : null

  const statsText =
    wordCount === 0
      ? "No script yet"
      : `${wordCount} words · ${formatClock(estimateReadSeconds({ wordCount, wpm: settings.wpm }))}`

  return (
    <div className="flex h-screen w-screen bg-transparent p-3">
      <div
        data-testid="teleprompter-card"
        data-chrome-visible={chromeVisible}
        className="flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border-strong/60 shadow-e3"
        style={{
          backgroundColor: `color-mix(in srgb, var(--color-background) ${settings.opacity}%, transparent)`,
        }}
      >
        <TeleprompterTitlebar visible={chromeVisible} statusText={statusText} />

        <div className="min-h-0 flex-1">
          {mode === "prompt" ? (
            <PrompterView
              notes={notes}
              fontSize={settings.fontSize}
              mirror={settings.mirror}
              viewportHeight={viewportHeight}
              onViewportRef={setViewportEl}
              onTextRef={setTextEl}
              onTogglePlay={togglePlayOrReplay}
              onEdit={() => setMode("edit")}
            />
          ) : (
            <ScriptEditor notes={notes} onNotesChange={setNotes} />
          )}
        </div>

        {mode === "prompt" ? (
          <ControlDock
            visible={chromeVisible}
            progress={scrollInfo.progress}
            atEnd={scrollInfo.atEnd}
            onTogglePlay={togglePlayOrReplay}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
        ) : (
          <footer
            data-teleprompter-chrome
            className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-border/60 px-3"
          >
            <span className="tnum truncate text-xs text-muted-foreground">{statsText}</span>
            <Button size="sm" onClick={play} disabled={!hasNotes}>
              <Play aria-hidden />
              Start prompting
            </Button>
          </footer>
        )}
      </div>
    </div>
  )
}
