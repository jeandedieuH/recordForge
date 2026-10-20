import { create } from "zustand"
import type { TimelineState } from "@recordforge/contracts"

// Transient Smart Cut review state shared between the Audio panel (analysis +
// controls) and the timeline (silence preview bands). Nothing here persists —
// a review is discarded when it's applied, dismissed, or the editor session
// resets (see timeline-store `resetSession`).

export interface SmartCutReviewRange {
  id: string
  startMs: number
  endMs: number
}

export interface SmartCutReview {
  /** Detected dead-air ranges in timeline ms, sorted by start. */
  ranges: SmartCutReviewRange[]
  /** Ranges the user excluded from the cut. */
  excludedIds: string[]
  /** Total milliseconds the included ranges would remove. */
  removedMs: number
  /** Audible coverage analyzed — basis for the "cuts almost everything" guard. */
  audibleCoverageMs: number
  /** Locked clips/tracks would desync the cut — the apply button explains this. */
  hasLockedBlockers: boolean
  /** The exact timeline state the ranges were computed against. Reference
   *  equality detects edits made mid-review so stale cuts are never applied. */
  analyzedTimeline: TimelineState
}

interface SmartCutStore {
  review: SmartCutReview | null
  /**
   * Start or update the active review. Existing per-range exclusions are kept
   * when a recompute produces a range with the same id, so tweaking the
   * detection controls mid-review never discards the user's choices.
   */
  syncReview: (review: Omit<SmartCutReview, "excludedIds">) => void
  toggleRangeExcluded: (id: string) => void
  setAllExcluded: (excluded: boolean) => void
  clearReview: () => void
}

export const useSmartCutStore = create<SmartCutStore>((set) => ({
  review: null,

  syncReview: (review) =>
    set((state) => {
      const carried = (state.review?.excludedIds ?? []).filter((id) =>
        review.ranges.some((range) => range.id === id),
      )
      return { review: { ...review, excludedIds: carried } }
    }),

  toggleRangeExcluded: (id) =>
    set((state) => {
      if (!state.review) return state
      const excluded = state.review.excludedIds.includes(id)
      return {
        review: {
          ...state.review,
          excludedIds: excluded
            ? state.review.excludedIds.filter((existing) => existing !== id)
            : [...state.review.excludedIds, id],
        },
      }
    }),

  setAllExcluded: (excluded) =>
    set((state) => {
      if (!state.review) return state
      return {
        review: {
          ...state.review,
          excludedIds: excluded ? state.review.ranges.map((range) => range.id) : [],
        },
      }
    }),

  clearReview: () => set({ review: null }),
}))
