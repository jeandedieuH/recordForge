import { describe, expect, it } from "vitest"
import {
  annotationClipSchema,
  type AnnotationClip,
  type AnnotationType,
} from "@recordforge/contracts"
import { createAnnotationClip, getAnnotationShapePreset } from "@recordforge/editor-core"
import {
  applyAnnotationInspectorPreset,
  changeAnnotationAnimation,
  changeAnnotationLayout,
  changeAnnotationType,
} from "./annotation-inspector-helpers"

function makeClip(update: Partial<AnnotationClip> = {}): AnnotationClip {
  return {
    ...createAnnotationClip("rectangle", { x: 100, y: 80, width: 240, height: 140 }),
    ...update,
  }
}

function convert(clip: AnnotationClip, type: AnnotationType) {
  return annotationClipSchema.parse({ ...clip, ...changeAnnotationType(clip, type) })
}

describe("annotation type conversion", () => {
  it("creates absolute endpoints and an arrow head when converting a box", () => {
    const result = convert(makeClip({ arrowEndHead: "none", endX: 999, endY: 999 }), "arrow")
    expect(result).toMatchObject({
      annotationType: "arrow",
      endX: 340,
      endY: 220,
      arrowStartHead: "none",
      arrowEndHead: "arrow",
      presetId: "",
    })
  })

  it("keeps connector endpoints while switching between arrow and line", () => {
    const arrow = makeClip({ annotationType: "arrow", endX: -40, endY: 80 })
    const line = convert(arrow, "line")
    expect(line).toMatchObject({
      endX: -40,
      endY: 80,
      arrowStartHead: "none",
      arrowEndHead: "none",
    })
    expect(convert(line, "arrow")).toMatchObject({ endX: -40, endY: 80, arrowEndHead: "arrow" })
  })

  it("falls back to width/height for legacy connectors without endpoints", () => {
    expect(
      convert(makeClip({ annotationType: "line", endX: undefined, endY: undefined }), "arrow"),
    ).toMatchObject({ endX: 340, endY: 220, arrowEndHead: "arrow" })
  })

  it("removes stale endpoints and bounds reversed connectors when converting to a shape", () => {
    const result = convert(makeClip({ annotationType: "arrow", endX: -40, endY: 80 }), "rectangle")
    expect(result).toMatchObject({ x: -40, y: 80, width: 140, height: 10, arrowEndHead: "none" })
    expect(result.endX).toBeUndefined()
    expect(result.endY).toBeUndefined()
  })

  it.each(["callout", "badge"] as const)(
    "provides useful %s text without overwriting existing text",
    (type) => {
      expect(convert(makeClip(), type).text).toBeTruthy()
      expect(convert(makeClip({ text: "Keep this note" }), type).text).toBe("Keep this note")
    },
  )

  it("does not reset an already selected type", () => {
    const clip = makeClip()
    expect(changeAnnotationType(clip, "rectangle")).toEqual({})
  })
})

describe("annotation layout", () => {
  const line = makeClip({ annotationType: "line", endX: -40, endY: 80, width: 140, height: 0 })

  it("translates both endpoints when moving a connector", () => {
    expect(changeAnnotationLayout(line, { x: 120, y: 100 })).toEqual({
      x: 120,
      y: 100,
      endX: -20,
      endY: 100,
      width: 140,
      height: 0,
    })
  })

  it("preserves direction while resizing and supports horizontal/vertical segments", () => {
    expect(changeAnnotationLayout(line, { width: 280, height: 0 })).toMatchObject({
      endX: -180,
      endY: 80,
      width: 280,
      height: 0,
    })
  })

  it("keeps bounds in sync with explicitly edited endpoints", () => {
    expect(changeAnnotationLayout(line, { endX: 100, endY: -20 })).toMatchObject({
      endX: 100,
      endY: -20,
      width: 0,
      height: 100,
    })
  })

  it("leaves box updates alone", () => {
    expect(changeAnnotationLayout(makeClip(), { x: -10, width: 300 })).toEqual({
      x: -10,
      width: 300,
    })
  })
})

describe("annotation preset restyling", () => {
  it("preserves authored geometry, timing and text while applying preset styling", () => {
    const clip = makeClip({
      annotationType: "callout",
      text: "My authored note",
      x: -25,
      y: 90,
      width: 310,
      height: 125,
      rotation: 35,
      anchorX: 0.2,
      anchorY: 0.8,
      zIndex: 7,
      startMs: 2500,
      durationMs: 4000,
      sourceInMs: 100,
      sourceOutMs: 4100,
      speed: 1,
    })
    const original = structuredClone(clip)
    const shape = {
      ...getAnnotationShapePreset("badge"),
      defaultWidth: 900,
      defaultHeight: 600,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
      zIndex: 0,
      text: "Preset text",
      defaultStrokeWidth: 12,
      defaultStrokeColor: "rebeccapurple",
      defaultStrokeStyle: "dotted" as const,
    }
    const result = applyAnnotationInspectorPreset(clip, shape)
    expect(result).toMatchObject({
      id: clip.id,
      annotationType: "badge",
      x: -25,
      y: 90,
      width: 310,
      height: 125,
      rotation: 35,
      anchorX: 0.2,
      anchorY: 0.8,
      zIndex: 7,
      text: "My authored note",
      startMs: 2500,
      durationMs: 4000,
      sourceInMs: 100,
      sourceOutMs: 4100,
      speed: 1,
      strokeWidth: 12,
      strokeColor: "rebeccapurple",
      strokeStyle: "dotted",
      fillColor: shape.defaultFillColor,
      fillOpacity: shape.defaultFillOpacity,
    })
    expect(clip).toEqual(original)
  })

  it("preserves intentionally blank text when applying a text preset", () => {
    const shape = { ...getAnnotationShapePreset("callout"), text: "Do not insert this" }
    expect(applyAnnotationInspectorPreset(makeClip({ text: "" }), shape).text).toBe("")
  })

  it("uses preset text only when no text was authored", () => {
    const shape = { ...getAnnotationShapePreset("callout"), text: "New note" }
    expect(applyAnnotationInspectorPreset(makeClip({ text: undefined }), shape).text).toBe(
      "New note",
    )
  })

  it.each([false, true])(
    "preserves backward connector placement while restyling (locked: %s)",
    (locked) => {
      const clip = makeClip({
        annotationType: "arrow",
        x: 500,
        y: 300,
        width: 300,
        height: 200,
        endX: 200,
        endY: 100,
        rotation: 15,
        anchorX: 0.1,
        anchorY: 0.9,
        zIndex: 5,
        locked,
      })
      const shape = {
        ...getAnnotationShapePreset("arrow"),
        defaultWidth: 900,
        defaultHeight: 600,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        zIndex: 0,
        defaultStrokeWidth: 10,
      }
      expect(applyAnnotationInspectorPreset(clip, shape)).toMatchObject({
        x: 500,
        y: 300,
        width: 300,
        height: 200,
        endX: 200,
        endY: 100,
        rotation: 15,
        anchorX: 0.1,
        anchorY: 0.9,
        zIndex: 5,
        locked,
        strokeWidth: 10,
      })
    },
  )

  it("blocks shape-changing presets and direct geometry updates while locked", () => {
    const clip = makeClip({ annotationType: "arrow", endX: -40, endY: 80, locked: true })
    expect(applyAnnotationInspectorPreset(clip, getAnnotationShapePreset("rectangle"))).toBe(clip)
    expect(changeAnnotationType(clip, "rectangle")).toEqual({})
    expect(changeAnnotationLayout(clip, { x: 0, width: 500 })).toEqual({})
  })

  it("preserves intentionally blank text during direct type conversion", () => {
    expect(convert(makeClip({ text: "" }), "callout").text).toBe("")
  })
})

describe("annotation engine motion", () => {
  const clip = makeClip({
    overlayAnimation: {
      inType: "draw",
      outType: "slide-down",
      inDurationMs: 600,
      outDurationMs: 250,
      easing: "ease-out",
    },
  })

  it("updates intro and canonical motion together, retaining timing and outro", () => {
    expect(changeAnnotationAnimation(clip, { inType: "none" })).toEqual({
      animationIn: "none",
      animationOut: "slide-down",
      overlayAnimation: { ...clip.overlayAnimation, inType: "none" },
    })
  })

  it("updates outro without resetting canonical intro", () => {
    expect(changeAnnotationAnimation(clip, { outType: "scale-down" })).toEqual({
      animationIn: "draw",
      animationOut: "scale-down",
      overlayAnimation: { ...clip.overlayAnimation, outType: "scale-down" },
    })
  })

  it("retains advanced canonical effects while providing schema-valid legacy values", () => {
    const result = annotationClipSchema.parse({
      ...clip,
      ...changeAnnotationAnimation(clip, { inType: "bounce", outType: "slide-left" }),
    })
    expect(result.overlayAnimation).toMatchObject({
      inType: "bounce",
      outType: "slide-left",
      inDurationMs: 600,
    })
    expect(result.animationIn).toBe("fade")
  })

  it("repairs legacy-only preset motion without losing custom timing", () => {
    const shape = {
      ...getAnnotationShapePreset("arrow"),
      overlayAnimation: undefined,
      animationIn: "scale-up" as const,
      animationOut: "draw" as const,
    }
    const result = applyAnnotationInspectorPreset(clip, shape)
    expect(result).toMatchObject({
      animationIn: "scale-up",
      animationOut: "scale-down",
      overlayAnimation: {
        inType: "scale-up",
        outType: "scale-down",
        inDurationMs: 600,
        outDurationMs: 250,
        easing: "ease-out",
      },
    })
    expect(annotationClipSchema.safeParse(result).success).toBe(true)
  })

  it("gives explicit canonical preset motion priority over legacy aliases", () => {
    const shape = {
      ...getAnnotationShapePreset("arrow"),
      animationIn: "fade" as const,
      overlayAnimation: { inType: "draw" as const, inDurationMs: 900 },
    }
    expect(applyAnnotationInspectorPreset(clip, shape)).toMatchObject({
      animationIn: "draw",
      overlayAnimation: { inType: "draw", inDurationMs: 900, outDurationMs: 250 },
    })
  })
})
