import { describe, expect, it } from "vitest"
import {
  LEGACY_TEXT_PRESET_CATALOG,
  TEXT_PRESET_CATALOG,
  TEXT_PRESETS,
  PresetRegistry,
  applyTextPresetToClip,
  applyTitleAppearance,
  createTextClipFromDefinition,
  createTextClipFromPreset,
  getTextPresetById,
  getTextPresetRecordById,
  getTitleContentLabels,
  getTitlePresetGroup,
  hasTitleFontSizeOverrides,
  resolveTitleFontSizes,
  textPresetFromClip,
  titleDesignSchema,
  textPresetToDefinition,
  textPresetValuesSchema,
  type PresetStorageData,
  type TextPresetValues,
} from "./index"

const templates = {
  "text-clean": "clean-text",
  "text-emphasis": "emphasis",
  "text-editorial": "editorial-opener",
  "text-kinetic": "kinetic-hook",
  "text-chapter": "chapter-marker",
  "text-speaker": "speaker-id",
  "text-source": "source-credit",
  "text-step": "step-guide",
  "text-shortcut": "shortcut",
  "text-command": "command-line",
  "text-note": "note",
  "text-quote": "pull-quote",
  "text-metric": "metric",
  "text-cta": "call-to-action",
}

describe("creator title presets", () => {
  it("exposes exactly fourteen distinct, schema-validated purpose templates", () => {
    expect(TEXT_PRESETS.map((preset) => preset.id)).toEqual(Object.keys(templates))
    for (const [id, template] of Object.entries(templates)) {
      const clip = createTextClipFromPreset(id)
      expect(clip.titleDesign).toMatchObject({ version: 1, template, tempo: 1 })
      expect(textPresetValuesSchema.safeParse(getTextPresetRecordById(id).definition).success).toBe(
        true,
      )
      expect(clip.primaryText.length).toBeGreaterThan(0)
    }
    expect(new PresetRegistry(TEXT_PRESET_CATALOG).getAll()).toHaveLength(14)
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
  ])("places all new templates safely inside a %i x %i canvas", (canvasWidth, canvasHeight) => {
    for (const preset of TEXT_PRESETS) {
      const clip = createTextClipFromDefinition(preset, { canvasWidth, canvasHeight })
      const scale = Math.min(canvasWidth / 1920, canvasHeight / 1080)
      expect(clip.x).toBeGreaterThan(0)
      expect(clip.y).toBeGreaterThan(0)
      expect(clip.x + clip.width).toBeLessThan(canvasWidth)
      expect(clip.y + clip.height).toBeLessThan(canvasHeight)
      expect(clip.fontSize).toBeCloseTo(Math.max(8, preset.fontSize * scale))
      expect(clip.backdropPaddingX).toBeCloseTo(preset.backdropPaddingX * scale)
    }
  })

  it("anchors identity at the bottom and instructional titles near the top", () => {
    expect(createTextClipFromPreset("text-speaker").y).toBeGreaterThan(700)
    expect(createTextClipFromPreset("text-source").y).toBeGreaterThan(700)
    expect(createTextClipFromPreset("text-step").y).toBeLessThan(150)
    expect(createTextClipFromPreset("text-note").y).toBeLessThan(150)
  })

  it("parses title defaults only when a versioned template is present", () => {
    const definition = getTextPresetRecordById("text-clean").definition
    expect(
      textPresetValuesSchema.parse({ ...definition, titleDesign: { version: 1, template: "note" } })
        .titleDesign,
    ).toMatchObject({
      appearance: "dark",
      motion: "designed",
      lineHeight: 1.15,
      metric: { to: 98 },
    })
    expect(
      textPresetValuesSchema.safeParse({ ...definition, titleDesign: { version: 1 } }).success,
    ).toBe(false)
    expect(
      textPresetValuesSchema.parse({ ...definition, titleDesign: undefined }).titleDesign,
    ).toBeUndefined()
  })

  it("applies templates without replacing content or timing, with explicit layout and style preservation", () => {
    const original = createTextClipFromPreset("text-speaker", { startMs: 1250, durationMs: 6200 })
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
      titleDesign: { ...original.titleDesign!, motion: "none" as const, tempo: 1.5 },
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
      titleDesign: { template: "editorial-opener", motion: "none", tempo: 1.5 },
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

  it("round-trips independent custom title design, animation and autoscale snapshots through the registry", async () => {
    const clip = createTextClipFromPreset("text-metric")
    clip.autoScaleText = false
    clip.titleDesign = {
      ...clip.titleDesign!,
      appearance: "light",
      motion: "subtle",
      tempo: 1.7,
      emphasisText: "faster",
      noteTone: "warning",
      letterSpacing: 0.04,
      lineHeight: 1.3,
      metric: { from: 12, to: 42.5, decimals: 1, prefix: "+", suffix: "x" },
    }
    const snapshot = textPresetFromClip(clip, { name: "My result", description: "Saved result" })
    const expectedDesign = structuredClone(clip.titleDesign)
    clip.titleDesign.metric.to = 999
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
      fontSizes: { ...design.fontSizes, secondary: 18, tag: 120 },
    }
    const custom = resolveTitleFontSizes(overridden, clip.fontSize)
    expect(custom.secondary).toBe(18)
    expect(custom.tag).toBe(120)
    expect(custom.primary).toBe(resolved.primary)
    expect(hasTitleFontSizeOverrides(overridden)).toBe(true)
    expect(titleDesignSchema.parse({ version: 1, template: "note" }).fontSizes).toEqual({})
    for (const bad of [3, 601, Number.NaN]) {
      expect(
        titleDesignSchema.safeParse({
          version: 1,
          template: "note",
          fontSizes: { primary: bad },
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
        fontSizes: { primary: 100, secondary: 40, tag: 20 },
      },
    }
    const clip = createTextClipFromDefinition(definition, {
      canvasWidth: 960,
      canvasHeight: 540,
    })
    expect(clip.fontSize).toBeCloseTo(preset.fontSize * 0.5)
    expect(clip.titleDesign?.fontSizes?.primary).toBeCloseTo(50)
    expect(clip.titleDesign?.fontSizes?.secondary).toBeCloseTo(20)
  })

  it("shares semantic content labels and groups with the title browser", () => {
    expect(getTitlePresetGroup()).toBe("legacy")
    expect(getTitlePresetGroup("speaker-id")).toBe("identity")
    expect(getTitlePresetGroup("shortcut")).toBe("tutorials")
    expect(getTitleContentLabels("speaker-id")).toEqual({
      primary: "Name",
      secondary: "Role",
      tag: "Tag",
    })
    expect(getTitleContentLabels("pull-quote")).toMatchObject({
      primary: "Quote",
      secondary: "Attribution",
    })
    expect(getTitleContentLabels("metric").primary).toBe("Metric label")
  })

  it("changes appearance neutrals without overwriting the accent or migrating legacy clips", () => {
    const clip = createTextClipFromPreset("text-note")
    const patch = applyTitleAppearance(clip, "light")
    expect(patch.titleDesign?.appearance).toBe("light")
    expect(patch.textColor).not.toBe(clip.textColor)
    expect({ ...clip, ...patch }.accentColor).toBe(clip.accentColor)
    expect(
      applyTitleAppearance(createTextClipFromPreset("title-modern"), "light").titleDesign,
    ).toBeUndefined()
  })
})
