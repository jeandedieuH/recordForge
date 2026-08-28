import { useEffect, useMemo, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { save } from "@tauri-apps/plugin-dialog"
import { join } from "@tauri-apps/api/path"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  ToastViewport,
  TooltipProvider,
  cn,
  useToast,
} from "@recordforge/ui"
import { EditorSession, EditorView } from "../features/editor"
import { ExportView } from "../features/export"
import { LibraryView } from "../features/library"
import { ProjectsView } from "../features/projects"
import { StorageView } from "../features/storage"
import { NewRecordingModal } from "../features/recorder"
import { SettingsView } from "../features/settings"
import { AboutView } from "../features/about"
import { OnboardingModal } from "../features/onboarding"
import { toErrorMessage } from "../lib/errors"
import { getDiagnosticsReport } from "../lib/recorder"
import { getSetting, isTauri, setSetting } from "../lib/settings"
import { useEditorStore } from "../stores/editor-store"
import { useThemeStore } from "../stores/theme-store"
import { useTimelineStore } from "../stores/timeline-store"
import { useRecorderStore } from "../hooks/use-recorder"
import { useUpdaterStore } from "../stores/updater-store"
import { ViewErrorBoundary } from "../components/error-boundary"
import { Sidebar, type View } from "./sidebar"
import { Titlebar } from "./titlebar"

const VIEW_TITLES: Record<View, string> = {
  library: "Library",
  projects: "Projects",
  storage: "Storage",
  editor: "Editor",
  export: "Export",
  settings: "Settings",
  about: "About RecordForge",
}

export function AppShell() {
  const { toast } = useToast()
  const [activeView, setActiveView] = useState<View>("library")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isNewRecordingOpen, setIsNewRecordingOpen] = useState(false)
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false)
  // Opened by the Rust `request-discard-confirmation` event (tray menu): the
  // destructive action itself runs only after the user confirms here.
  const [isDiscardConfirmOpen, setIsDiscardConfirmOpen] = useState(false)

  const editorRecordingId = useEditorStore((state) => state.recordingId)
  const openEditor = useEditorStore((state) => state.open)
  const closeEditor = useEditorStore((state) => state.close)
  const loadTheme = useThemeStore((state) => state.load)
  const startRecording = useRecorderStore((state) => state.start)
  const setSelectedProfileId = useRecorderStore((state) => state.setSelectedProfileId)
  const completedRecordingId = useRecorderStore((state) => state.completedRecordingId)
  const queuePreparation = useRecorderStore((state) => state.queuePreparation)
  const clearCompletedRecording = useRecorderStore((state) => state.clearCompletedRecording)
  const saveMessage = useRecorderStore((state) => state.saveMessage)
  const clearSaveMessage = useRecorderStore((state) => state.clearSaveMessage)
  const discardRecording = useRecorderStore((state) => state.discard)
  const pendingAction = useRecorderStore((state) => state.pendingAction)
  const timelineRecording = useTimelineStore((state) => state.recording)
  const timelineCanvas = useTimelineStore((state) => state.engine?.history.present.canvas)
  const timelineDurationMs = useTimelineStore((state) => state.view?.durationMs ?? 0)
  const exportSettings = useTimelineStore((state) => state.project?.exportSettings)
  const captionMode = useTimelineStore(
    (state) => state.project?.exportSettings?.captionMode ?? "burn-in",
  )
  const chapterMode = useTimelineStore(
    (state) => state.project?.exportSettings?.chapterMode ?? "embed",
  )
  const setCaptionMode = useTimelineStore((state) => state.setCaptionMode)
  const setChapterMode = useTimelineStore((state) => state.setChapterMode)
  const timelineMarkers = useTimelineStore((state) => state.engine?.history.present.markers)
  const setExportContainer = useTimelineStore((state) => state.setExportContainer)
  const setExportPreset = useTimelineStore((state) => state.setExportPreset)
  const setExportCodec = useTimelineStore((state) => state.setExportCodec)
  const setExportEncoder = useTimelineStore((state) => state.setExportEncoder)
  const setExportRange = useTimelineStore((state) => state.setExportRange)
  const cancelExport = useTimelineStore((state) => state.cancelExport)
  const retryExport = useTimelineStore((state) => state.retryExport)
  const revealExport = useTimelineStore((state) => state.revealExport)
  const timelineExport = useTimelineStore((state) => state.export)
  const closeSession = useTimelineStore((state) => state.closeSession)
  const timelineError = useTimelineStore((state) => state.error)
  const clearTimelineError = useTimelineStore((state) => state.clearError)
  const activeExportJob = useTimelineStore((state) => state.activeExportJob)
  const detectedEncoders = useRecorderStore((state) => state.encoders)
  const loadEncoders = useRecorderStore((state) => state.loadEncoders)
  const loadRecovery = useRecorderStore((state) => state.loadRecovery)
  const checkForUpdate = useUpdaterStore((state) => state.checkForUpdate)
  const markUpdateNotified = useUpdaterStore((state) => state.markUpdateNotified)

  // Mirror the Rust hardware priority (NVENC, QSV, AMF, Media Foundation) when
  // surfacing which encoder the Auto export preference would use.
  const hardwareEncoderName = useMemo(() => {
    const priority = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"]
    const available = new Set(
      (detectedEncoders ?? [])
        .filter((encoder) => encoder?.available)
        .map((encoder) => encoder?.id),
    )
    const best = priority.find((id) => available.has(id))
    if (!best) return null
    return detectedEncoders?.find((encoder) => encoder?.id === best)?.name ?? null
  }, [detectedEncoders])

  // Load the detected encoder list once so the export view can advertise
  // hardware availability.
  useEffect(() => {
    if (!isTauri()) return
    void loadEncoders()
  }, [loadEncoders])

  // Scan for interrupted sessions once at startup so a force-quit recording is
  // surfaced immediately, not only when the user happens to open the Library.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void loadRecovery().then(() => {
      if (cancelled) return
      const sessions = useRecorderStore.getState().recovery
      const recoverable = sessions.filter((session) => session.isRecoverable)
      const unrecoverable = sessions.filter((session) => !session.isRecoverable)

      if (recoverable.length > 0) {
        toast({
          title:
            recoverable.length === 1
              ? "Interrupted recording found"
              : `${recoverable.length} interrupted recordings found`,
          description: "Recover or delete them from the Library.",
        })
      } else if (unrecoverable.length > 0) {
        toast({
          title: "Incomplete recording session found",
          description:
            "An interrupted session with no recoverable video was detected. Review or discard it in the Library.",
          variant: "warning",
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [loadRecovery, toast])

  // Check the signed GitHub Release updater after the shell is visible so startup
  // remains responsive and auxiliary recording windows never perform checks.
  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return

    let cancelled = false
    const runCheck = () => {
      void checkForUpdate().then((update) => {
        if (cancelled || !update) return
        const { notifiedVersion } = useUpdaterStore.getState()
        if (notifiedVersion === update.version) return

        markUpdateNotified(update.version)
        toast({
          title: `RecordForge ${update.version} is available`,
          description: update.body ?? "A signed update is ready to install.",
          variant: "info",
          duration: 20_000,
          action: {
            label: "View update",
            onClick: () => setActiveView("about"),
          },
        })
      })
    }

    const initialCheck = window.setTimeout(runCheck, 10_000)
    const interval = window.setInterval(runCheck, 6 * 60 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearTimeout(initialCheck)
      window.clearInterval(interval)
    }
  }, [checkForUpdate, markUpdateNotified, toast])

  // The tray's "Discard Recording…" entry routes here: Rust restores this
  // window and emits `request-discard-confirmation`; the destructive command
  // only runs after the user confirms in the dialog below (ADR 011).
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    let active = true
    listen("request-discard-confirmation", () => {
      setIsDiscardConfirmOpen(true)
    }).then((fn) => {
      if (active) unlisten = fn
      else fn()
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  // Load persisted theme/transparency preferences once at startup.
  useEffect(() => {
    void loadTheme()
  }, [loadTheme])

  // Restore the sidebar collapsed preference.
  useEffect(() => {
    if (!isTauri()) return
    void getSetting("sidebarCollapsed").then((value) => {
      if (value === "true") setSidebarCollapsed(true)
    })
  }, [])

  // Check hardware specs on first launch and recommend Low Impact profile for low-end machines (<= 2 cores).
  useEffect(() => {
    if (!isTauri()) return

    async function checkHardware() {
      try {
        const checked = await getSetting("hardwareCheckDone")
        if (checked === "true") return

        const diagnostics = await getDiagnosticsReport()
        const cpuStr = diagnostics?.platform?.cpu ?? ""
        const coreMatch = cpuStr.match(/(\d+)\s*(?:logical\s*)?cores?/i)
        const cores = coreMatch ? parseInt(coreMatch[1], 10) : (navigator.hardwareConcurrency ?? 4)

        if (cores <= 2) {
          setSelectedProfileId("low-impact")
          toast({
            title: "Low-Spec Hardware Detected",
            description: `Detected ${cores} CPU core${cores === 1 ? "" : "s"}. The "Low Impact" (720p/480p) recording profile was automatically selected to minimize CPU usage and prevent dropped frames.`,
            variant: "info",
            action: {
              label: "Settings",
              onClick: () => setActiveView("settings"),
            },
          })
        }
        await setSetting("hardwareCheckDone", "true")
      } catch (err) {
        console.warn("Initial hardware check failed:", err)
      }
    }

    void checkHardware()
  }, [setSelectedProfileId, toast])

  // Check if first-run onboarding has been completed.
  useEffect(() => {
    async function checkOnboarding() {
      try {
        const done = await getSetting("onboardingCompleted")
        if (done !== "true") {
          setIsOnboardingOpen(true)
        }
      } catch {
        // Fallback
      }
    }
    void checkOnboarding()
  }, [])

  // Open the editor view when a recording is opened from the library.
  useEffect(() => {
    if (editorRecordingId) {
      setActiveView("editor")
    }
  }, [editorRecordingId])

  // A successful stop publishes the exact library ID after persistence. Queue
  // derivatives here so opening the editor never owns or blocks preparation.
  useEffect(() => {
    if (!completedRecordingId) return
    void queuePreparation(completedRecordingId)
    openEditor(completedRecordingId)
    setActiveView("editor")
    clearCompletedRecording()
  }, [clearCompletedRecording, completedRecordingId, openEditor, queuePreparation])

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      if (isTauri()) void setSetting("sidebarCollapsed", String(!prev))
      return !prev
    })
  }

  async function prepareForUpdate() {
    const closed = await useTimelineStore.getState().closeSession()
    if (!closed) {
      const error = useEditorStore.getState().saveError
      throw new Error(error ?? "Save the current editor changes before updating.")
    }

    closeEditor()
    setActiveView((current) => (current === "editor" || current === "export" ? "library" : current))
  }

  async function handleStartRecording() {
    if (editorRecordingId) {
      const closed = await closeSession()
      if (!closed) return
    }
    setActiveView("library")
    void startRecording()
  }

  async function handleCloseEditor() {
    // Phase 1: close the session, flushing any unsaved changes. If the flush
    // fails, do not leave the editor so the user can recover.
    const closed = await closeSession()
    if (!closed) return
    closeEditor()
    setActiveView("library")
  }

  // Phase 1: guard navigation away from the editor when a session is open.
  // Moving between editor and export keeps the session alive; other views close it.
  async function handleNavigate(view: View) {
    if (view === activeView) return
    if (editorRecordingId && view !== "editor" && view !== "export") {
      const closed = await closeSession()
      if (!closed) return
    }
    setActiveView(view)
  }

  async function handleStartExport() {
    if (!timelineRecording) return
    try {
      const isGif =
        exportSettings?.container === "gif" || exportSettings?.preset?.startsWith("gif-")
      const isWebp =
        exportSettings?.container === "webp" || exportSettings?.preset?.startsWith("webp-")
      const extension = isGif ? "gif" : isWebp ? "webp" : "mp4"
      let defaultPath = `${timelineRecording.name}-edited.${extension}`
      if (isTauri()) {
        const defaultFolder = await getSetting("defaultOutputFolder").catch(() => null)
        if (defaultFolder) {
          try {
            defaultPath = await join(defaultFolder, `${timelineRecording.name}-edited.${extension}`)
          } catch {
            defaultPath = `${defaultFolder}\\${timelineRecording.name}-edited.${extension}`
          }
        }
      }
      const outputPath = await save({
        title: isGif
          ? "Export animated GIF"
          : isWebp
            ? "Export animated WebP"
            : "Export edited recording",
        defaultPath,
        filters: isGif
          ? [{ name: "Animated GIF", extensions: ["gif"] }]
          : isWebp
            ? [{ name: "Animated WebP", extensions: ["webp"] }]
            : [{ name: "MP4 video", extensions: ["mp4"] }],
      })
      if (!outputPath) return
      // Phase 1: the export path flushes and freezes a durable project revision
      // before building the render plan, so it never exports unsaved edits.
      await timelineExport(outputPath)
    } catch (error) {
      useTimelineStore.setState({ error: toErrorMessage(error) })
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground font-sans antialiased">
        {editorRecordingId ? <EditorSession recordingId={editorRecordingId} /> : null}
        <Titlebar view={VIEW_TITLES[activeView]} onOpenRecord={() => setIsNewRecordingOpen(true)} />

        <div className="flex min-h-0 flex-1">
          {activeView === "editor" || activeView === "export" ? null : (
            <Sidebar
              activeView={activeView}
              onNavigate={handleNavigate}
              editorOpen={editorRecordingId !== null}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={toggleSidebar}
            />
          )}

          <main
            className={cn(
              "min-w-0 flex-1 bg-background",
              activeView === "editor" || activeView === "export"
                ? "flex flex-col overflow-hidden"
                : "overflow-y-auto",
            )}
          >
            {saveMessage ? (
              <div
                role="status"
                className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground"
              >
                <span>{saveMessage}</span>
                <button
                  type="button"
                  className="shrink-0 text-subtle-foreground underline"
                  onClick={clearSaveMessage}
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            {activeView === "library" ? (
              <ViewErrorBoundary viewName="Library" resetKey={activeView}>
                <LibraryView />
              </ViewErrorBoundary>
            ) : null}
            {activeView === "projects" ? (
              <ViewErrorBoundary
                viewName="Projects"
                resetKey={activeView}
                onNavigateHome={() => setActiveView("library")}
              >
                <ProjectsView
                  onOpenProject={(recId) => {
                    openEditor(recId)
                    setActiveView("editor")
                  }}
                  onNavigateToLibrary={() => setActiveView("library")}
                />
              </ViewErrorBoundary>
            ) : null}
            {activeView === "storage" ? (
              <ViewErrorBoundary
                viewName="Storage"
                resetKey={activeView}
                onNavigateHome={() => setActiveView("library")}
              >
                <StorageView onNavigateToSettings={() => setActiveView("settings")} />
              </ViewErrorBoundary>
            ) : null}
            {activeView === "editor" ? (
              <ViewErrorBoundary
                viewName="Editor"
                resetKey={activeView}
                onNavigateHome={() => setActiveView("library")}
              >
                <EditorView
                  recordingId={editorRecordingId ?? "rec-1"}
                  onClose={handleCloseEditor}
                  onOpenExport={() => setActiveView("export")}
                />
              </ViewErrorBoundary>
            ) : null}
            {activeView === "export" ? (
              <ViewErrorBoundary
                viewName="Export"
                resetKey={activeView}
                onNavigateHome={() => setActiveView("library")}
              >
                <ExportView
                  projectName={timelineRecording?.name}
                  canvas={timelineCanvas}
                  durationMs={timelineDurationMs}
                  exportSettings={exportSettings}
                  captionMode={captionMode}
                  onCaptionModeChange={setCaptionMode}
                  chapterMode={chapterMode}
                  onChapterModeChange={setChapterMode}
                  markers={timelineMarkers}
                  onContainerChange={setExportContainer}
                  onPresetChange={setExportPreset}
                  onCodecChange={setExportCodec}
                  onEncoderChange={setExportEncoder}
                  hardwareEncoderName={hardwareEncoderName}
                  onRangeChange={setExportRange}
                  exportJob={activeExportJob}
                  error={timelineError}
                  onDismissError={clearTimelineError}
                  onCancelExport={cancelExport}
                  onRetryExport={retryExport}
                  onRevealExport={revealExport}
                  onBack={() => setActiveView("editor")}
                  onStartExport={handleStartExport}
                />
              </ViewErrorBoundary>
            ) : null}
            {activeView === "settings" ? (
              <ViewErrorBoundary
                viewName="Settings"
                resetKey={activeView}
                onNavigateHome={() => setActiveView("library")}
              >
                <SettingsView
                  onNavigateToAbout={() => setActiveView("about")}
                  onReplayOnboarding={() => setIsOnboardingOpen(true)}
                  onPrepareForUpdate={prepareForUpdate}
                />
              </ViewErrorBoundary>
            ) : null}
            {activeView === "about" ? (
              <ViewErrorBoundary
                viewName="About"
                resetKey={activeView}
                onNavigateHome={() => setActiveView("library")}
              >
                <AboutView
                  onNavigateToSettings={() => setActiveView("settings")}
                  onReplayOnboarding={() => setIsOnboardingOpen(true)}
                  onPrepareForUpdate={prepareForUpdate}
                />
              </ViewErrorBoundary>
            ) : null}
          </main>
        </div>

        {/* First-Run Onboarding Experience */}
        <OnboardingModal
          open={isOnboardingOpen}
          onClose={() => setIsOnboardingOpen(false)}
          onStartRecording={() => {
            setIsOnboardingOpen(false)
            setIsNewRecordingOpen(true)
          }}
        />

        {/* New Recording Modal Overlay */}
        <NewRecordingModal
          open={isNewRecordingOpen}
          onClose={() => setIsNewRecordingOpen(false)}
          onStart={handleStartRecording}
          onNavigateToSettings={() => setActiveView("settings")}
        />

        {/* Tray-initiated discard confirmation (destructive, ADR 011) */}
        <AlertDialog open={isDiscardConfirmOpen} onOpenChange={setIsDiscardConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard this recording?</AlertDialogTitle>
              <AlertDialogDescription>
                Everything captured so far — video, audio, camera, and markers — will be permanently
                deleted. Nothing will be saved to the library. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pendingAction === "discard"}>
                Keep recording
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={pendingAction === "discard"}
                onClick={(event) => {
                  // Keep the dialog open until the discard IPC settles so the
                  // outcome (idle status or error toast) is visible.
                  event.preventDefault()
                  void discardRecording().then(() => setIsDiscardConfirmOpen(false))
                }}
                className="bg-recording text-white hover:bg-recording-hover"
              >
                {pendingAction === "discard" ? "Discarding…" : "Delete everything"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <ToastViewport />
    </TooltipProvider>
  )
}
