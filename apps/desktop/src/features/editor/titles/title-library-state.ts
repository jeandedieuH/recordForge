import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { create } from "zustand"
import { getTitlePresetGroup, type TextPresetRecord } from "@recordforge/editor-core"
import { getTextPresetRegistry } from "../presets/preset-store"

export const TITLE_RECENTS_KEY = "recordforge:title-recents:v1"
export const MAX_TITLE_RECENTS = 20
export const TITLE_GROUPS = [
  "essentials",
  "openers",
  "identity",
  "tutorials",
  "highlights",
  "legacy",
] as const
export type TitleCollection = "all" | "favorites" | "recent" | "custom"

interface LibraryState {
  query: string
  group: string
  collection: TitleCollection
  recentIds: string[]
  setFilters: (update: Partial<Pick<LibraryState, "query" | "group" | "collection">>) => void
  remember: (id: string) => void
  forget: (id: string) => void
}

/** Validate and bound the IDs-only record. Never retain search queries, media or title text. */
export function parseTitleRecents(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(parsed)) return []
    return [
      ...new Set(
        parsed.filter(
          (id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id),
        ),
      ),
    ].slice(0, MAX_TITLE_RECENTS)
  } catch {
    return []
  }
}

export function rememberTitleId(ids: string[], id: string): string[] {
  return parseTitleRecents(JSON.stringify([id, ...ids.filter((value) => value !== id)]))
}

function loadRecentIds() {
  try {
    return parseTitleRecents(localStorage.getItem(TITLE_RECENTS_KEY))
  } catch {
    return []
  }
}
function saveRecentIds(ids: string[]) {
  try {
    localStorage.setItem(TITLE_RECENTS_KEY, JSON.stringify(ids))
  } catch {
    /* Optional local history must not prevent editing. */
  }
}

// Filter state lasts for this app session only, including panel/inspector remounts.
export const useTitleLibraryState = create<LibraryState>((set) => ({
  query: "",
  group: "all",
  collection: "all",
  recentIds: loadRecentIds(),
  setFilters: (update) => set(update),
  remember: (id) =>
    set((state) => {
      const recentIds = rememberTitleId(state.recentIds, id)
      saveRecentIds(recentIds)
      return { recentIds }
    }),
  forget: (id) =>
    set((state) => {
      const recentIds = state.recentIds.filter((value) => value !== id)
      saveRecentIds(recentIds)
      return { recentIds }
    }),
}))

export function filterTitlePresets({
  presets,
  query,
  group,
  collection,
  favoriteIds,
  customPresetIds,
  recentIds,
}: {
  presets: TextPresetRecord[]
  query: string
  group: string
  collection: TitleCollection
  favoriteIds: string[]
  customPresetIds: string[]
  recentIds: string[]
}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const filtered = presets.filter((preset) => {
    if (group !== "all" && getTitlePresetGroup(preset.definition.titleDesign?.template) !== group)
      return false
    if (collection === "favorites" && !favoriteIds.includes(preset.id)) return false
    if (collection === "custom" && !customPresetIds.includes(preset.id)) return false
    if (collection === "recent" && !recentIds.includes(preset.id)) return false
    const haystack = [
      preset.name,
      preset.description,
      preset.category,
      ...preset.tags,
      getTitlePresetGroup(preset.definition.titleDesign?.template),
    ]
      .join(" ")
      .toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
  return collection === "recent"
    ? filtered.sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id))
    : filtered
}

export function useTitleRegistry() {
  const registry = getTextPresetRegistry()
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setError(null)
    void registry.load().catch(() => {
      if (active) setError("Your saved titles could not be loaded. Try again.")
    })
    return () => {
      active = false
    }
  }, [registry, attempt])
  const retry = useCallback(() => {
    setError(null)
    setAttempt((value) => value + 1)
  }, [])
  return { registry, snapshot, error, retry, isLoading: !snapshot.isLoaded && !error }
}
