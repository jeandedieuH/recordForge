import { z } from "zod"
import type { PresetDefinition, PresetStorage, PresetStorageData } from "@recordforge/editor-core"
import { getSetting, setSetting } from "../../../lib/settings"

export type EditorPresetKind = "annotation" | "text"

const presetStorageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  preview: z.string().optional(),
  definition: z.unknown(),
})

const favoriteIdsSchema = z.array(z.string())

const STORAGE_KEYS: Record<EditorPresetKind, { presets: string; favorites: string }> = {
  annotation: {
    presets: "editorAnnotationPresets",
    favorites: "editorAnnotationPresetFavorites",
  },
  text: {
    presets: "editorTextPresets",
    favorites: "editorTextPresetFavorites",
  },
}

export function createPresetStorage<T>(kind: EditorPresetKind): PresetStorage<T> {
  const keys = STORAGE_KEYS[kind]

  return {
    async load(): Promise<PresetStorageData<T> | null> {
      const [presetsRaw, favoritesRaw] = await Promise.all([
        getSetting(keys.presets),
        getSetting(keys.favorites),
      ])
      const presets = parseStoredPresets<T>(presetsRaw)
      const favorites = parseFavoriteIds(favoritesRaw)
      return { version: 1, presets, favorites }
    },

    async save(data): Promise<void> {
      await Promise.all([
        setSetting(keys.presets, JSON.stringify(data.presets)),
        setSetting(keys.favorites, JSON.stringify(data.favorites)),
      ])
    },
  }
}

function parseStoredPresets<T>(raw: string | null): PresetDefinition<T>[] {
  if (!raw) return []
  try {
    const parsed = z.array(presetStorageSchema).safeParse(JSON.parse(raw))
    if (!parsed.success) return []
    return parsed.data.map((preset) => ({
      ...preset,
      tags: [...preset.tags],
      ...(preset.preview ? { preview: preset.preview } : {}),
      definition: preset.definition as T,
    }))
  } catch {
    return []
  }
}

function parseFavoriteIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = favoriteIdsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
