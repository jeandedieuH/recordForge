import { describe, expect, it } from "vitest"
import { PresetRegistry, type PresetCatalog, type PresetStorageData } from "./preset-registry"
import {
  ANNOTATION_PRESET_CATALOG,
  ANNOTATION_SHAPES,
  annotationPresetFromClip,
  createAnnotationClip,
} from "../annotation-presets"
import {
  TEXT_PRESET_CATALOG,
  TEXT_PRESETS,
  createTextClipFromPreset,
  textPresetFromClip,
} from "../text-presets"

interface TestPresetValues {
  color: string
}

function catalog(): PresetCatalog<TestPresetValues> {
  return {
    version: 1,
    categories: ["frame", "title"],
    presets: [
      {
        id: "frame-basic",
        name: "Basic Frame",
        description: "A searchable frame",
        category: "frame",
        tags: ["highlight", "outline"],
        definition: { color: "blue" },
      },
      {
        id: "title-basic",
        name: "Basic Title",
        description: "A title card",
        category: "title",
        tags: ["heading"],
        definition: { color: "white" },
      },
    ],
  }
}

function storage(initial: PresetStorageData<TestPresetValues> | null = null) {
  let value = initial
  return {
    storage: {
      async load() {
        return value
      },
      async save(next: PresetStorageData<TestPresetValues>) {
        value = next
      },
    },
    read: () => value,
  }
}

describe("PresetRegistry", () => {
  it("externalizes the built-in annotation and text catalogs", () => {
    expect(ANNOTATION_PRESET_CATALOG.version).toBe(1)
    expect(ANNOTATION_PRESET_CATALOG.presets).toHaveLength(ANNOTATION_SHAPES.length)
    expect(TEXT_PRESET_CATALOG.version).toBe(1)
    expect(TEXT_PRESET_CATALOG.presets).toHaveLength(TEXT_PRESETS.length)
    expect(ANNOTATION_PRESET_CATALOG.categories).toContain("pointer")
    expect(TEXT_PRESET_CATALOG.categories).toContain("lower-third")
  })

  it("searches categories, descriptions, tags, and favorites", async () => {
    const registry = new PresetRegistry(catalog())
    expect(registry.search("highlight").map((preset) => preset.id)).toEqual(["frame-basic"])
    expect(registry.list({ category: "title" }).map((preset) => preset.id)).toEqual(["title-basic"])

    await registry.setFavorite("title-basic", true)
    expect(registry.list({ favoritesOnly: true }).map((preset) => preset.id)).toEqual([
      "title-basic",
    ])
    expect(registry.getSnapshot().favoriteIds).toEqual(["title-basic"])
  })

  it("saves, loads, updates, and deletes custom presets through storage", async () => {
    const persisted = storage()
    const first = new PresetRegistry(catalog(), { storage: persisted.storage })
    const saved = await first.saveCustomPreset({
      id: "custom-blue",
      name: "Custom Blue",
      description: "A user style",
      category: "frame",
      tags: ["custom", "blue"],
      definition: { color: "indigo" },
    })
    await first.setFavorite(saved.id, true)

    const second = new PresetRegistry(catalog(), { storage: persisted.storage })
    await second.load()
    expect(second.getPresetById("custom-blue")?.definition).toEqual({ color: "indigo" })
    expect(second.isCustomPreset("custom-blue")).toBe(true)
    expect(second.isFavorite("custom-blue")).toBe(true)

    await second.renameCustomPreset("custom-blue", "Renamed Blue")
    expect(second.getPresetById("custom-blue")?.name).toBe("Renamed Blue")
    await second.deleteCustomPreset("custom-blue")
    expect(second.getPresetById("custom-blue")).toBeUndefined()
    expect(persisted.read()?.presets).toHaveLength(0)
  })

  it("captures clip settings without timeline placement for custom presets", () => {
    const annotation = createAnnotationClip("callout", { x: 120, y: 80, startMs: 900 })
    const annotationPreset = annotationPresetFromClip(annotation, {
      name: "Saved Callout",
      description: "Current callout styling",
    })
    expect(annotationPreset.definition).not.toHaveProperty("x")
    expect(annotationPreset.definition).not.toHaveProperty("startMs")
    expect(annotationPreset.definition.defaultFillColor).toBe(annotation.fillColor)

    const text = createTextClipFromPreset("title-modern", { startMs: 1_000 })
    const textPreset = textPresetFromClip(text, {
      name: "Saved Title",
      description: "Current title styling",
    })
    expect(textPreset.definition).not.toHaveProperty("x")
    expect(textPreset.definition).not.toHaveProperty("startMs")
    expect(textPreset.definition.defaultPrimaryText).toBe(text.primaryText)
  })
})
