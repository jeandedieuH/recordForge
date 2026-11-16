import { describe, expect, it } from "vitest"
import {
  LEGACY_TEXT_PRESET_CATALOG,
  TEXT_PRESET_CATALOG,
  TEXT_PRESETS,
  PresetRegistry,
  applyTextPresetToClip,
  createTextClipFromDefinition,
  createTextClipFromPreset,
  getTextPresetById,
  getTextPresetRecordById,
  getTitleContentLabels,
  getTitlePresetGroup,
  hasTitleFontSizeOverrides,
  migrateTextPresetDesignScale,
  resolveTitleFontSizes,
  textPresetFromClip,
  titleDesignSchema,
  textPresetToDefinition,
  textPresetValuesSchema,
  type PresetStorageData,
  type TextPresetDefinition,
  type TextPresetValues,
} from "./index"

const templates = {
  "text-clean": "clean",
  "text-hook": "hook",
  "text-emphasis": "hook-emphasis",
  "text-editorial": "editorial",
  "text-chapter": "chapter",
  "text-kinetic": "kinetic",
  "text-highlight": "highlight",
  "text-banner": "banner",
  "text-speaker": "lower-third-bar",
  "text-lower-third-glass": "lower-third-glass",
  "text-lower-third-line": "lower-third-line",
  "text-source": "source",
  "text-social-handle": "social-handle",
  "text-cta-follow": "cta-follow",
  "text-cta-link": "cta-link",
  "text-cta": "cta",
  "text-step": "step",
  "text-checklist": "checklist",
  "text-shortcut": "shortcut",
  "text-command": "terminal",
  "text-note": "callout",
  "text-quote": "quote",
  "text-location": "location",
  "text-metric": "stat",
  "text-stat-delta": "stat-before-after",
  "text-countdown": "countdown",
  "text-agenda": "agenda",
  "text-outro": "outro",
} as const

describe("creator title presets", () => {
  it("exposes the curated v2 catalog as schema-validated templates", () => {
    expect(TEXT_PRESETS.map((preset) => preset.id)).toEqual(Object.keys(templates))
    for (const [id, template] of Object.entries(templates)) {
      const clip = createTextClipFromPreset(id)
      expect(clip.titleDesign).toMatchObject({ version: 2, template, tempo: 1 })
      expect(textPresetValuesSchema.safeParse(getTextPresetRecordById(id).definition).success).toBe(
        true,
      )
      expect(clip.primaryText.length).toBeGreaterThan(0)
    }
    expect(new PresetRegistry(TEXT_PRESET_CATALOG).getAll()).toHaveLength(
      Object.keys(templates).length,
    )
    expect(getTextPresetById("missing").id).toBe("text-clean")
  })

  it("keeps every legacy preset addressable without migrating its design or placement", () => {
    expect(LEGACY_TEXT_PRESET_CATALOG.presets).toHaveLength(26)
    for (const record of LEGACY_TEXT_PRESET_CATALOG.presets) {
      expect(getTextPresetRecordById(record.id)).toEqual(record)
      expect(createTextClipFromPreset(record.id).titleDesign).toBeUndefined()
      expect(TEXT_PRESETS.some((preset) => preset.id === record.id)).toBe(false)
    }
    expect(createTextClipFromPreset("title-modern")).toMatchObject({
      width: 540,
      height: 180,
      x: 690,
      y: 450,
      fontSize: 40,
    })
    expect(
      createTextClipFromPreset("title-modern", { canvasWidth: 1080, canvasHeight: 1920 }),
    ).toMatchObject({ width: 540, height: 180, x: 270, y: 870, fontSize: 40 })
  })

  it.each([
    [1920, 1080],
    [1080, 1920],
    [360, 640],
    [640, 360],
    [2560, 1080],
  ])("places all templates safely inside a %i x %i canvas", (canvasWidth, canvasHeight) => {
    for (const preset of TEXT_PRESETS) {
      const clip = createTextClipFromDefinition(preset, { canvasWidth, canvasHeight })
      const scale = Math.min(canvasWidth / 1920, canvasHeight / 1080)
      expect(clip.x).toBeGreaterThanOrEqual(0)
      expect(clip.y).toBeGreaterThanOrEqual(0)
      expect(clip.x + clip.width).toBeLessThanOrEqual(canvasWidth)
      expect(clip.y + clip.height).toBeLessThanOrEqual(canvasHeight)
      expect(clip.fontSize).toBeCloseTo(Math.max(8, preset.fontSize * scale))
      expect(clip.backdropPaddingX).toBeCloseTo(preset.backdropPaddingX * scale)
    }
  })

  it("anchors lower thirds at the bottom and instructional titles near the top", () => {
    for (const id of [
      "text-speaker",
      "text-lower-third-glass",
      "text-lower-third-line",
      "text-source",
      "text-social-handle",
      "text-cta-follow",
      "text-cta-link",
    ]) {
      expect(createTextClipFromPreset(id).y).toBeGreaterThan(500)
    }
    for (const id of ["text-step", "text-location"]) {
      expect(createTextClipFromPreset(id).y).toBeLessThan(150)
    }
  })

  it("parses title defaults only when a versioned template is present", () => {
    const definition = getTextPresetRecordById("text-clean").definition
    expect(
      textPresetValuesSchema.parse({ ...definition, titleDesign: { version: 2, template: "callout" } })
        .titleDesign,
    ).toMatchObject({
      tempo: 1,
      typography: { lineHeight: 1.15 },
      metric: { to: 98 },
    })
    // v1 payloads migrate at parse time (backward compatibility).
    expect(
      textPresetValuesSchema.parse({
        ...definition,
        titleDesign: { version: 1, template: "note" },
      }).titleDesign,
    ).toMatchObject({ version: 2, template: "callout" })
    expect(
      textPresetValuesSchema.safeParse({ ...definition, titleDesign: { version: 2 } }).success,
    ).toBe(false)
    expect(
      textPresetValuesSchema.parse({ ...definition, titleDesign: undefined }).titleDesign,
    ).toBeUndefined()
  })

  it("applies templates without replacing content or timing, with explicit layout and style preservation", () => {
    const original = createTextClipFromPreset("text-speaker", {
      startMs: 1250,
      durationMs: 6200,
    })
    const clip = {
      ...original,
      primaryText: "Jordan Lee",
      secondaryText: "Product designer",
      tagText: "INTERVIEW",
      x: 23,
      y: 42,
      width: 580,
      height: 160,
      rotation: 12,
      fontSize: 31,
      titleDesign: { ...original.titleDesign!, tempo: 1.5 },
      autoScaleText: false,
    }
    const preset = getTextPresetById("text-editorial")
    const applied = applyTextPresetToClip(clip, preset, {
      preserveLayout: true,
      preserveStyle: true,
    })
    expect(applied).toMatchObject({
      id: clip.id,
      assetId: clip.assetId,
      primaryText: clip.primaryText,
      secondaryText: clip.secondaryText,
      tagText: clip.tagText,
      startMs: 1250,
      durationMs: 6200,
      sourceOutMs: 6200,
      x: 23,
      y: 42,
      width: 580,
      height: 160,
      rotation: 12,
      fontSize: 31,
      autoScaleText: false,
      titleDesign: { template: "editorial", tempo: 1.5 },
      overlayAnimation: clip.overlayAnimation,
    })
    const reset = applyTextPresetToClip(clip, preset)
    expect(reset.width).toBe(preset.width)
    expect(reset.fontSize).toBe(preset.fontSize)
    expect(reset.titleDesign).toEqual(preset.titleDesign)
    expect(reset.autoScaleText).toBe(preset.autoScaleText)
    expect(
      applyTextPresetToClip(clip, getTextPresetById("title-modern")).titleDesign,
    ).toBeUndefined()
  })

  it("scales a replaced design to the project canvas without touching content or timing", () => {
    const clip = createTextClipFromPreset("text-speaker", {
      startMs: 1250,
      durationMs: 6200,
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    clip.primaryText = "Custom words"
    const preset = getTextPresetById("text-editorial")
    const replaced = applyTextPresetToClip(clip, preset, {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    expect(replaced.primaryText).toBe("Custom words")
    expect(replaced.startMs).toBe(1250)
    expect(replaced.durationMs).toBe(6200)
    expect(replaced.width).toBeCloseTo(preset.width * 2)
    expect(replaced.fontSize).toBeCloseTo(Math.min(200, preset.fontSize * 2))
    // Keep-layout still preserves the box while the typography fits the canvas.
    const kept = applyTextPresetToClip(clip, preset, {
      preserveLayout: true,
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    expect(kept.width).toBe(clip.width)
    expect(kept.height).toBe(clip.height)
    expect(kept.fontSize).toBeCloseTo(Math.min(200, preset.fontSize * 2))
  })

  it("does not double-scale custom presets saved from a 4K canvas", () => {
    const clip = createTextClipFromPreset("text-editorial", {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    const record = textPresetFromClip(clip, {
      name: "4K editorial",
      description: "Saved at 4K",
      designScale: 2,
    })
    const definition = textPresetToDefinition(record)
    const at4k = createTextClipFromDefinition(definition, {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    expect(at4k.width).toBeCloseTo(clip.width)
    expect(at4k.fontSize).toBeCloseTo(clip.fontSize)
    const at1080 = createTextClipFromDefinition(definition, {
      canvasWidth: 1920,
      canvasHeight: 1080,
    })
    expect(at1080.width).toBeCloseTo(clip.width / 2)
    expect(at1080.fontSize).toBeCloseTo(clip.fontSize / 2)
  })

  it("migrates a legacy custom title preset saved before designScale", () => {
    const clip = createTextClipFromPreset("text-editorial", {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    const record = textPresetFromClip(clip, {
      name: "Legacy 4K editorial",
      description: "Saved before designScale existed",
    })
    const legacy = { ...record.definition }
    delete legacy.designScale

    const migrated = migrateTextPresetDesignScale(legacy, "custom-legacy-editorial")
    expect(migrated.designScale).toBe(2)
    const recreated = createTextClipFromDefinition(
      {
        ...migrated,
        id: record.id,
        name: record.name,
        description: record.description,
        category: record.category as TextPresetDefinition["category"],
      },
      { canvasWidth: 3840, canvasHeight: 2160 },
    )
    expect(recreated.width).toBeCloseTo(clip.width)
    expect(recreated.fontSize).toBeCloseTo(clip.fontSize)
  })

  it("persists the inferred designScale for a legacy custom preset on load", async () => {
    const clip = createTextClipFromPreset("text-editorial", {
      canvasWidth: 3840,
      canvasHeight: 2160,
    })
    const record = textPresetFromClip(clip, {
      name: "Legacy 4K editorial",
      description: "Saved before designScale existed",
    })
    const legacy = JSON.parse(JSON.stringify(record)) as typeof record
    delete legacy.definition.designScale
    let stored: PresetStorageData<TextPresetValues> | null = {
      version: 1,
      presets: [legacy],
      favorites: [],
    }
    const storage = {
      load: async () => stored,
      save: async (value: PresetStorageData<TextPresetValues>) => {
        stored = JSON.parse(JSON.stringify(value))
      },
    }
    const registry = new PresetRegistry(TEXT_PRESET_CATALOG, {
      definitionSchema: textPresetValuesSchema,
      storage,
      migrateDefinition: migrateTextPresetDesignScale,
    })
    await registry.load()
    expect(registry.getPresetById(record.id)?.definition.designScale).toBe(2)
    expect(stored?.presets[0]?.definition.designScale).toBe(2)
  })

  it("round-trips independent custom title design, animation and autoscale snapshots through the registry", async () => {
    const clip = createTextClipFromPreset("text-metric")
    clip.autoScaleText = false
    clip.titleDesign = {
      ...clip.titleDesign!,
      tempo: 1.7,
      noteTone: "warning",
      typography: { ...clip.titleDesign!.typography, letterSpacing: 0.04, lineHeight: 1.3 },
      emphasis: { text: "faster", style: "marker" },
      metric: { from: 12, to: 42.5, decimals: 1, prefix: "+", suffix: "x" },
    }
    const snapshot = textPresetFromClip(clip, { name: "My result", description: "Saved result" })
    const expectedDesign = structuredClone(clip.titleDesign)
    clip.titleDesign!.metric.to = 999
    expect(snapshot.definition.titleDesign).toEqual(expectedDesign)
    let stored: PresetStorageData<TextPresetValues> | null = null
    const storage = {
      load: async () => stored,
      save: async (value: PresetStorageData<TextPresetValues>) => {
        stored = JSON.parse(JSON.stringify(value))
      },
    }
    const registry = new PresetRegistry(TEXT_PRESET_CATALOG, {
      definitionSchema: textPresetValuesSchema,
      storage,
    })
    await registry.saveCustomPreset(snapshot)
    const reloaded = new PresetRegistry(TEXT_PRESET_CATALOG, {
      definitionSchema: textPresetValuesSchema,
      storage,
    })
    await reloaded.load()
    const definition = textPresetToDefinition(reloaded.getPresetById(snapshot.id)!)
    const created = createTextClipFromDefinition(definition)
    expect(created.titleDesign).toEqual(expectedDesign)
    expect(created.autoScaleText).toBe(false)
    expect(created.overlayAnimation).toEqual(clip.overlayAnimation)
    const reset = applyTextPresetToClip(createTextClipFromPreset("text-clean"), definition)
    expect(reset.titleDesign).toEqual(expectedDesign)
    expect(reset.autoScaleText).toBe(false)
  })

  it("resolves per-element font sizes from overrides or the template ratio", () => {
    const clip = createTextClipFromPreset("text-chapter")
    const design = clip.titleDesign!
    const resolved = resolveTitleFontSizes(design, clip.fontSize)
    expect(resolved.primary).toBeCloseTo(clip.fontSize)
    expect(resolved.tag).toBeCloseTo(clip.fontSize * 1.8)
    expect(hasTitleFontSizeOverrides(design)).toBe(false)
    const overridden = {
      ...design,
      elements: {
        ...design.elements,
        secondary: { size: 18 },
        tag: { size: 120 },
      },
    }
    const custom = resolveTitleFontSizes(overridden, clip.fontSize)
    expect(custom.secondary).toBe(18)
    expect(custom.tag).toBe(120)
    expect(custom.primary).toBe(resolved.primary)
    expect(hasTitleFontSizeOverrides(overridden)).toBe(true)
    expect(titleDesignSchema.parse({ version: 2, template: "callout" }).elements).toEqual({})
    for (const bad of [3, 1201, Number.NaN]) {
      expect(
        titleDesignSchema.safeParse({
          version: 2,
          template: "callout",
          elements: { primary: { size: bad } },
        }).success,
      ).toBe(false)
    }
  })

  it("scales font size overrides with the canvas like the base font size", () => {
    const preset = getTextPresetById("text-clean")
    const definition = {
      ...preset,
      titleDesign: {
        ...preset.titleDesign!,
        elements: {
          primary: { size: 100 },
          secondary: { size: 40 },
          tag: { size: 20 },
        },
      },
    }
    const clip = createTextClipFromDefinition(definition, {
      canvasWidth: 960,
      canvasHeight: 540,
    })
    expect(clip.fontSize).toBeCloseTo(preset.fontSize * 0.5)
    expect(clip.titleDesign?.elements?.primary?.size).toBeCloseTo(50)
    expect(clip.titleDesign?.elements?.secondary?.size).toBeCloseTo(20)
  })

  it("shares semantic content labels and groups with the title browser", () => {
    expect(getTitlePresetGroup("speaker-id")).toBe("lower-thirds")
    expect(getTitlePresetGroup("shortcut")).toBe("tutorial")
    expect(getTitleContentLabels("speaker-id")).toEqual({
      primary: "Name",
      secondary: "Role",
      tag: "Tag",
    })
    expect(getTitleContentLabels("pull-quote")).toMatchObject({
      primary: "Quote",
      secondary: "Attribution",
    })
    expect(getTitleContentLabels("stat")).toMatchObject({ primary: "Metric label" })
  })
})
