import { useSyncExternalStore } from "react"
import { useTimelineStore } from "../../../stores/timeline-store"

export function subscribeToPlayhead(listener: () => void): () => void {
  return useTimelineStore.subscribe((state, previousState) => {
    if (state.view.playheadMs !== previousState.view.playheadMs) listener()
  })
}

export function getPlayheadSnapshot(): number {
  return useTimelineStore.getState().view.playheadMs
}

export function usePlayheadMs(): number {
  return useSyncExternalStore(subscribeToPlayhead, getPlayheadSnapshot, getPlayheadSnapshot)
}
