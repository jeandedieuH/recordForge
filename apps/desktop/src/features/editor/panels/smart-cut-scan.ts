import type {
  ProFeatureKey,
  ProjectExportSettings,
  recordForgeProject,
  RenderPlan,
  SilenceScanResult,
  TimelineState,
} from "@recordforge/contracts"
import {
  analyzeSmartCutRanges,
  createRippleDeleteRangesCommand,
  getTotalDuration,
  lockedTracksBlockingRanges,
  type CommandEngine,
  type SmartCutRange,
  type TimelineCommand,
} from "@recordforge/editor-core"
import { toErrorMessage } from "../../../lib/errors"
import { formatDuration } from "../../../lib/format"
import {
  isSmartCutResultStale,
  isSmartCutRunStale,
  selectedSmartCutRanges,
  smartCutConfigEquals,
  smartCutDetectionSettings,
  type SmartCutResult,
  type SmartCutRunContext,
  type SmartCutScanConfig,
} from "./smart-cut-model"

// The async spine of Smart Cut: save → build plan → native analysis →
// normalize. Every stale path returns `{ status: "stale" }` rather than
// throwing or leaving a half-applied state behind, so the card can always
// settle back to idle/review/error deterministically.
export type SmartCutScanOutcome =
  | {
      status: "success"
      ranges: SmartCutRange[]
      // True when cuts were discarded because they would delete the project.
      wholeTimeline: boolean
      // Calibration context reported by the native scan — the applied dB RMS
      // floor, the measured noise floor, and whether it was auto-calibrated.
      thresholdDb: number
      noiseFloorDb: number | null
      calibration: "adaptive" | "manual"
    }
  | { status: "stale" }
  | { status: "error"; message: string }

export interface SmartCutScanDeps {
  save: () => Promise<void>
  // `save()` resolves even on failure; this reads the post-save status.
  saveFailed: () => boolean
  buildPlan: () => { ok: true; value: RenderPlan } | { ok: false; error: { message: string } }
  detect: (plan: RenderPlan) => Promise<SilenceScanResult>
  // Called between every await: true when the scan's inputs are no longer
  // current (edit committed, recording switched, superseded, or cancelled).
  isStale: () => boolean
  durationMs: number
  paddingMs: number
}

export async function runSmartCutScan(deps: SmartCutScanDeps): Promise<SmartCutScanOutcome> {
  try {
    // The backend resolves real asset paths from the SAVED project — persist
    // first and refuse to scan state that isn't on disk.
    await deps.save()
    if (deps.saveFailed()) {
      return {
        status: "error",
        message: "Couldn't save the project — fix the save error, then scan again.",
      }
    }
    if (deps.isStale()) return { status: "stale" }

    const plan = deps.buildPlan()
    if (!plan.ok) return { status: "error", message: plan.error.message }

    const found = await deps.detect(plan.value)
    if (deps.isStale()) return { status: "stale" }

    const analysis = analyzeSmartCutRanges({
      ranges: found.ranges,
      durationMs: deps.durationMs,
      paddingMs: deps.paddingMs,
    })
    return {
      status: "success",
      ranges: analysis.ranges,
      wholeTimeline: analysis.wholeTimeline,
      thresholdDb: found.thresholdDb,
      noiseFloorDb: found.noiseFloorDb,
      calibration: found.calibration,
    }
  } catch (error) {
    if (deps.isStale()) return { status: "stale" }
    // Tauri rejects with a serialized AppError object — `instanceof Error`
    // misses it and would hide real messages like the no-audio case.
    return { status: "error", message: toErrorMessage(error) }
  }
}

// Single-flight admission for scan runs. `start` returns null instead of a
// promise when a scan is already running (synchronous double-click guard);
// `cancel` invalidates the in-flight run so its completion lands as stale.
export interface SmartCutScanRunner {
  isRunning: () => boolean
  start: (deps: SmartCutScanDeps) => Promise<SmartCutScanOutcome> | null
  cancel: () => void
}

export function createSmartCutScanRunner(): SmartCutScanRunner {
  let token = 0
  let running = false
  return {
    isRunning: () => running,
    start(deps) {
      if (running) return null
      running = true
      const myToken = ++token
      const outcome = runSmartCutScan({
        ...deps,
        isStale: () => token !== myToken || deps.isStale(),
      })
      return outcome
        .then((result) => (token !== myToken ? { status: "stale" as const } : result))
        .finally(() => {
          if (token === myToken) running = false
        })
    },
    cancel() {
      token += 1
      // Admit the next scan immediately — the superseded run's finally
      // skips clearing `running` because its token no longer matches.
      running = false
    },
  }
}

// Bounded pause audition: pause current playback, seek just before the pause
// boundary, play, and stop when the playhead crosses just past the pause end.
// Returns a stop handle — call it to cancel the audition early.
export const SMART_CUT_AUDITION_LEAD_MS = 250
export const SMART_CUT_AUDITION_TAIL_MS = 250

export interface SmartCutAuditionStore {
  pause: () => void
  play: () => void
  seek: (ms: number) => void
  // Fires whenever the playhead position changes (playback or seek).
  subscribePlayhead: (listener: (playheadMs: number) => void) => () => void
}

export function startPauseAudition(
  store: SmartCutAuditionStore,
  range: { startMs: number; endMs: number },
  durationMs: number,
): () => void {
  const stopAt = Math.min(Math.max(0, durationMs), range.endMs + SMART_CUT_AUDITION_TAIL_MS)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    store.pause()
  }
  const unsubscribe = store.subscribePlayhead((playheadMs) => {
    if (playheadMs >= stopAt) stop()
  })
  store.pause()
  store.seek(Math.max(0, range.startMs - SMART_CUT_AUDITION_LEAD_MS))
  store.play()
  return stop
}

// ---------------------------------------------------------------------------
// Scan session — the state-changing caller seam the card binds to React
// state. Per-run ownership: only the run still holding `activeRun` may write
// UI state after an await; setup/cleanup cycles (React StrictMode) re-arm
// `mounted` without poisoning future runs.
// ---------------------------------------------------------------------------

export type SmartCutPhase = "idle" | "scanning" | "review" | "error"

export interface SmartCutSessionState {
  engine: CommandEngine | null
  project: Pick<recordForgeProject, "id" | "assets" | "exportSettings"> | null
  recording: { id: string } | null
  projectRevision: number
}

export interface SmartCutSessionHooks {
  phase(phase: SmartCutPhase): void
  scanError(message: string | null): void
  result(result: SmartCutResult | null): void
  selected(indices: Set<number>): void
  toast(toast: {
    title: string
    description?: string
    variant?: "default" | "error" | "warning"
  }): void
}

export interface SmartCutSessionDeps {
  // Live store reads — the session never caches them across awaits.
  getState: () => SmartCutSessionState
  getTier: () => string
  saveFailed: () => boolean
  save: () => Promise<void>
  execute: (command: TimelineCommand) => boolean
  buildPlan: (input: {
    state: TimelineState
    projectId: string
    settings: ProjectExportSettings
    assets: recordForgeProject["assets"]
  }) => { ok: true; value: RenderPlan } | { ok: false; error: { message: string } }
  detect: (
    recordingId: string,
    scanId: string,
    plan: RenderPlan,
    thresholdDb: number | null,
    minDurationMs: number,
  ) => Promise<SilenceScanResult>
  cancel: (recordingId: string, scanId: string) => Promise<void>
  openUpgrade: (features: ProFeatureKey[]) => void
  audition: SmartCutAuditionStore
  hooks: SmartCutSessionHooks
  // crypto.randomUUID in production; injectable for deterministic tests.
  newScanId: () => string
}

export interface SmartCutSession {
  scan(config: SmartCutScanConfig): Promise<void>
  cancelScan(): void
  /** Called by the invalidation effect on edit/recording/config changes. */
  checkInvalidation(config: SmartCutScanConfig, result: SmartCutResult | null): void
  /** Synchronous stale + tier recheck — never trusts effect timing. The
   *  LIVE scan config is rechecked against the result's, so a threshold
   *  changed between render and click blocks the apply even when the
   *  invalidation effect hasn't run yet. */
  apply(result: SmartCutResult | null, selected: Set<number>, config: SmartCutScanConfig): void
  previewPause(range: SmartCutRange, result: SmartCutResult | null): void
  /** Effect setup: re-arms mounted; revives a phase left at "scanning" by a
   *  cancelled run (StrictMode setup→cleanup→setup). */
  mount(): void
  /** Effect cleanup: invalidates only the owned run, stops audition, and
   *  cancels the owned native scan — never another run's. */
  unmount(): void
}

export function createSmartCutSession(deps: SmartCutSessionDeps): SmartCutSession {
  const runner = createSmartCutScanRunner()
  let mounted = false
  let activeRun: SmartCutRunContext | null = null
  let stopAudition: (() => void) | null = null

  const endAudition = () => {
    stopAudition?.()
    stopAudition = null
  }

  const runStale = (run: SmartCutRunContext, config: SmartCutScanConfig) => {
    const current = deps.getState()
    return (
      isSmartCutRunStale(run, {
        present: current.engine?.history.present,
        recordingId: current.recording?.id,
        projectRevision: current.projectRevision,
      }) || !smartCutConfigEquals(run.config, config)
    )
  }

  // End the owned run only: invalidate the token so late completions can't
  // write, free the runner for the next scan, and kill THIS scan's native
  // ffmpeg — never another run's.
  const endRun = (run: SmartCutRunContext | null) => {
    if (!run || activeRun !== run) return
    activeRun = null
    runner.cancel()
    void deps.cancel(run.recordingId, run.scanId).catch(() => {})
  }

  return {
    async scan(config) {
      if (deps.getTier() !== "pro") {
        deps.openUpgrade(["smart-cut"])
        return
      }
      const { engine, project, recording } = deps.getState()
      if (!engine || !project || !recording) return

      const run: SmartCutRunContext = {
        scanId: deps.newScanId(),
        recordingId: recording.id,
        present: engine.history.present,
        projectRevision: deps.getState().projectRevision,
        config,
      }
      const outcome = runner.start({
        save: () => deps.save(),
        saveFailed: deps.saveFailed,
        buildPlan: () =>
          deps.buildPlan({
            state: run.present,
            projectId: project.id,
            settings: smartCutDetectionSettings(project.exportSettings),
            assets: project.assets,
          }),
        detect: (plan) =>
          deps.detect(
            run.recordingId,
            run.scanId,
            plan,
            run.config.thresholdDb,
            run.config.minDurationMs,
          ),
        isStale: () => runStale(run, config),
        durationMs: getTotalDuration(run.present),
        paddingMs: run.config.paddingMs,
      })
      // Already running — synchronous single-flight rejection.
      if (!outcome) return
      activeRun = run
      deps.hooks.phase("scanning")
      deps.hooks.scanError(null)

      const scan = await outcome
      // Only the still-owned run may write UI state — a superseded run's
      // completion (success OR error) must not disturb a newer scan.
      if (!mounted || activeRun !== run) return
      activeRun = null
      if (scan.status === "stale") {
        deps.hooks.phase("idle")
        deps.hooks.toast({
          title: "Scan discarded",
          description: "The timeline changed during the scan — run it again.",
          variant: "warning",
        })
        return
      }
      if (scan.status === "error") {
        deps.hooks.scanError(scan.message)
        deps.hooks.phase("error")
        return
      }
      deps.hooks.result({
        ranges: scan.ranges,
        wholeTimeline: scan.wholeTimeline,
        thresholdDb: scan.thresholdDb,
        noiseFloorDb: scan.noiseFloorDb,
        calibration: scan.calibration,
        config: run.config,
        present: run.present,
        projectRevision: deps.getState().projectRevision,
        recordingId: run.recordingId,
        durationMs: getTotalDuration(run.present),
      })
      deps.hooks.selected(new Set(scan.ranges.map((_, index) => index)))
      deps.hooks.phase("review")
    },

    cancelScan() {
      endRun(activeRun)
      if (mounted) deps.hooks.phase("idle")
    },

    checkInvalidation(config, result) {
      const run = activeRun
      if (run && runStale(run, config)) {
        endRun(run)
        if (mounted) deps.hooks.phase("idle")
      }
      const current = deps.getState()
      if (
        isSmartCutResultStale({
          result,
          present: current.engine?.history.present,
          recordingId: current.recording?.id,
          projectRevision: current.projectRevision,
          config,
        })
      ) {
        deps.hooks.result(null)
        deps.hooks.selected(new Set())
        endAudition()
      }
    },

    apply(result, selected, config) {
      if (!result || selected.size === 0) return
      const current = deps.getState()
      // Synchronous re-check at apply time — tier, timeline, revision, and
      // recording may all have changed since the results were rendered.
      if (deps.getTier() !== "pro") {
        deps.openUpgrade(["smart-cut"])
        return
      }
      // The LIVE config — comparing `result.config` with itself would never
      // catch a threshold changed one tick before the click.
      if (
        isSmartCutResultStale({
          result,
          present: current.engine?.history.present,
          recordingId: current.recording?.id,
          projectRevision: current.projectRevision,
          config,
        })
      ) {
        deps.hooks.result(null)
        deps.hooks.selected(new Set())
        deps.hooks.toast({
          title: "Scan is out of date",
          description: "The timeline changed since the scan — run it again before applying.",
          variant: "warning",
        })
        return
      }
      const cuts = selectedSmartCutRanges(result.ranges, selected)
      const locked = lockedTracksBlockingRanges(current.engine!.history.present, cuts)
      if (locked.length > 0) {
        deps.hooks.toast({
          title: "Smart Cut blocked",
          description: `Unlock ${locked.join(", ")} first — locked tracks can't be cut or shifted.`,
          variant: "error",
        })
        return
      }
      const ok = deps.execute(createRippleDeleteRangesCommand(cuts))
      if (!ok) {
        deps.hooks.toast({
          title: "Could not apply Smart Cut",
          description: "The timeline may have changed — scan again.",
          variant: "error",
        })
        return
      }
      const savedMs = cuts.reduce((total, cut) => total + (cut.endMs - cut.startMs), 0)
      deps.hooks.toast({
        title: "Smart Cut applied",
        description: `Removed ${cuts.length} pause${cuts.length === 1 ? "" : "s"} (${formatDuration(savedMs)}). Undo restores everything.`,
      })
      deps.hooks.result(null)
      deps.hooks.selected(new Set())
      deps.hooks.phase("idle")
    },

    previewPause(range, result) {
      endAudition()
      stopAudition = startPauseAudition(deps.audition, range, result?.durationMs ?? 0)
    },

    mount() {
      mounted = true
      if (!activeRun) deps.hooks.phase("idle")
    },

    unmount() {
      mounted = false
      endAudition()
      const run = activeRun
      if (run) {
        activeRun = null
        runner.cancel()
        void deps.cancel(run.recordingId, run.scanId).catch(() => {})
      }
    },
  }
}
