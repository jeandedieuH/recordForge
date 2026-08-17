import { useEffect, useState, useSyncExternalStore } from "react"
import {
  ANNOTATION_PRESET_CATALOG,
  annotationPresetValuesSchema,
  TEXT_PRESET_CATALOG,
  textPresetValuesSchema,
  PresetRegistry,
  type AnnotationPresetValues,
  type PresetRegistrySnapshot,
  type TextPresetValues,
} from "@recordforge/editor-core"
import { createPresetStorage } from "./preset-storage"

const annotationPresetRegistry = new PresetRegistry<AnnotationPresetValues>(
  ANNOTATION_PRESET_CATALOG,
  {
    definitionSchema: annotationPresetValuesSchema,
    storage: createPresetStorage<AnnotationPresetValues>("annotation"),
  },
)

const textPresetRegistry = new PresetRegistry<TextPresetValues>(TEXT_PRESET_CATALOG, {
  definitionSchema: textPresetValuesSchema,
  storage: createPresetStorage<TextPresetValues>("text"),
})

export function getAnnotationPresetRegistry(): PresetRegistry<AnnotationPresetValues> {
  return annotationPresetRegistry
}

export function getTextPresetRegistry(): PresetRegistry<TextPresetValues> {
  return textPresetRegistry
}

export function useAnnotationPresetRegistry(): PresetRegistryHook<AnnotationPresetValues> {
  return usePresetRegistry(annotationPresetRegistry)
}

export function useTextPresetRegistry(): PresetRegistryHook<TextPresetValues> {
  return usePresetRegistry(textPresetRegistry)
}

interface PresetRegistryHook<T> {
  registry: PresetRegistry<T>
  snapshot: PresetRegistrySnapshot<T>
  isLoading: boolean
  error: string | null
}

function usePresetRegistry<T>(registry: PresetRegistry<T>): PresetRegistryHook<T> {
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isActive = true
    void registry.load().catch((reason: unknown) => {
      if (!isActive) return
      setError(reason instanceof Error ? reason.message : "Could not load saved presets")
    })
    return () => {
      isActive = false
    }
  }, [registry])

  return {
    registry,
    snapshot,
    isLoading: !snapshot.isLoaded && error === null,
    error,
  }
}
