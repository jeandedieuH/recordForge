import { describe, expect, it } from "vitest"
import {
  captionClipSchema,
  renderPlanCaptionLayoutSchema,
  renderPlanCaptionSchema,
  timelineTrackSchema,
} from "./timeline"

const baseTrack = {
  id: "t1",
  kind: "captions",
  name: "Captions",
  clips: [],
}

const validLayout = {
  lookId: "pop",
  fontPx: 60,
  lineHeightPx: 75,
  fontWeight: 800,
  letterSpacingPx: 0,
  textColor: "#FFFFFF",
  chip: null,
  outline: { color: "#000000", opacity: 1, widthPx: 6.6 },
  shadow: { color: "#000000", opacity: 0.6, blurPx: 8.4, offsetYPx: 4.2 },
  highlight: { mode: "word", activeColor: "#FACC15", inactiveOpacity: 1 },
  animation: { inMs: 100, outMs: 80, fromScale: 0.9 },
  pages: [
    {
      startMs: 0,
      endMs: 2400,
      animateIn: true,
      animateOut: false,
      lines: [
        {
          text: "HELLO WORLD",
          words: [
            { text: "HELLO", startMs: 0, endMs: 900 },
            { text: "WORLD", startMs: 900, endMs: 2400 },
          ],
        },
      ],
      block: { centerX: 540, centerY: 1700, height: 75 },
    },
  ],
}

describe("timeline track captionDesign", () => {
  it("parses a captions track without a design (legacy projects)", () => {
    const track = timelineTrackSchema.parse(baseTrack)
    expect(track.captionDesign).toBeUndefined()
  })

  it("parses a track-level caption design", () => {
    const track = timelineTrackSchema.parse({
      ...baseTrack,
      captionDesign: { preset: "boxed", offsetY: 0.05 },
    })
    expect(track.captionDesign?.preset).toBe("boxed")
    expect(track.captionDesign?.offsetY).toBe(0.05)
    // Schema defaults fill the rest.
    expect(track.captionDesign?.sizeScale).toBe(1)
    expect(track.captionDesign?.placement).toBe("bottom")
  })

  it("rejects an invalid design", () => {
    expect(() =>
      timelineTrackSchema.parse({ ...baseTrack, captionDesign: { sizeScale: 5 } }),
    ).toThrow()
  })
})

describe("caption clip word timings", () => {
  const clip = {
    id: "cap1",
    kind: "caption" as const,
    assetId: "track:captions",
    startMs: 1_000,
    durationMs: 2_000,
    sourceInMs: 1_000,
    sourceOutMs: 3_000,
    speed: 1,
    text: "one two",
  }

  it("keeps optional words on a caption clip and round-trips them", () => {
    const words = [
      { text: "one", startMs: 0, endMs: 900 },
      { text: "two", startMs: 1_000, endMs: 2_000 },
    ]
    const parsed = captionClipSchema.parse({ ...clip, words })
    expect(parsed.words).toEqual(words)
    expect(JSON.parse(JSON.stringify(parsed)).words).toEqual(words)
  })

  it("leaves words absent on a plain clip", () => {
    expect(captionClipSchema.parse(clip).words).toBeUndefined()
  })

  it("rejects bad stored times", () => {
    expect(() =>
      captionClipSchema.parse({ ...clip, words: [{ text: "one", startMs: -1, endMs: 9 }] }),
    ).toThrow()
    expect(() =>
      captionClipSchema.parse({
        ...clip,
        words: [{ text: "one", startMs: 0, endMs: 1.5 }],
      }),
    ).toThrow()
  })

  it("keeps container-time provenance fields and round-trips them", () => {
    const sourceWords = [
      { text: "one", startMs: 12_000, endMs: 12_400 },
      { text: "two", startMs: 12_600, endMs: 12_900 },
    ]
    const parsed = captionClipSchema.parse({ ...clip, sourceWords, sourceStreamIndex: 3 })
    expect(parsed.sourceWords).toEqual(sourceWords)
    expect(parsed.sourceStreamIndex).toBe(3)
    const roundTripped = captionClipSchema.parse(JSON.parse(JSON.stringify(parsed)))
    expect(roundTripped.sourceWords).toEqual(sourceWords)
    expect(roundTripped.sourceStreamIndex).toBe(3)
    expect(
      captionClipSchema.parse({ ...clip, sourceStreamIndex: null }).sourceStreamIndex,
    ).toBeNull()
    expect(captionClipSchema.parse(clip).sourceWords).toBeUndefined()
  })

  it("rejects bad provenance values", () => {
    expect(() => captionClipSchema.parse({ ...clip, sourceStreamIndex: -2 })).toThrow()
    expect(() => captionClipSchema.parse({ ...clip, sourceStreamIndex: 0.5 })).toThrow()
    expect(() =>
      captionClipSchema.parse({
        ...clip,
        sourceWords: [{ text: "one", startMs: 0, endMs: -1 }],
      }),
    ).toThrow()
    expect(() =>
      captionClipSchema.parse({
        ...clip,
        sourceWords: [{ text: "one", startMs: 1.25, endMs: 2 }],
      }),
    ).toThrow()
  })
})

describe("render plan caption layout", () => {
  const baseCaption = { id: "c1", text: "Hello world", startMs: 0, endMs: 2400 }

  it("parses a plan caption without a layout (legacy path)", () => {
    const caption = renderPlanCaptionSchema.parse(baseCaption)
    expect(caption.layout).toBeUndefined()
    expect(caption.style).toBe("default")
    expect(caption.placement).toBe("bottom")
  })

  it("parses a plan caption with a px-resolved layout", () => {
    const caption = renderPlanCaptionSchema.parse({ ...baseCaption, layout: validLayout })
    expect(caption.layout?.lookId).toBe("pop")
    expect(caption.layout?.pages).toHaveLength(1)
    expect(caption.layout?.pages[0].lines[0].words).toHaveLength(2)
  })

  it("rejects invalid layout values", () => {
    expect(() =>
      renderPlanCaptionLayoutSchema.parse({ ...validLayout, textColor: "white" }),
    ).toThrow()
    expect(() => renderPlanCaptionLayoutSchema.parse({ ...validLayout, fontPx: 900 })).toThrow()
    expect(() => renderPlanCaptionLayoutSchema.parse({ ...validLayout, fontWeight: 500 })).toThrow()
    expect(() => renderPlanCaptionLayoutSchema.parse({ ...validLayout, pages: [] })).toThrow()
    expect(() =>
      renderPlanCaptionLayoutSchema.parse({
        ...validLayout,
        highlight: { mode: "line", activeColor: "#FF0000", inactiveOpacity: 1 },
      }),
    ).toThrow()
  })
})
