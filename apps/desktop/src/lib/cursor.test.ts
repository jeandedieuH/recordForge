import { describe, expect, it } from "vitest"
import { z } from "zod"
import { cursorTelemetryFileSchema } from "@recordforge/contracts"
import { parseCursorTelemetryFile } from "./cursor"

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    tMs: 0,
    rawX: 10,
    rawY: 20,
    sourceX: 10.5,
    sourceY: 20.5,
    buttons: { left: false, right: false, middle: false, x1: false, x2: false },
    buttonEvent: "left-down",
    visible: true,
    shapeId: "arrow",
    shapeChanged: false,
    ...overrides,
  }
}

function makeTelemetry(events: unknown[]) {
  return {
    schemaVersion: 2,
    assetId: "cursor-events:rec-1",
    recordingId: "rec-1",
    sourceWidth: 1920,
    sourceHeight: 1080,
    captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    coordinateTransform: { a00: 1, a01: 0, a10: 0, a11: 1, b0: 0, b1: 0 },
    shapes: [],
    timebase: { unit: "ms", ticksPerSecond: 1000 },
    sampleRateHz: 120,
    clickWindowMs: 350,
    health: "healthy",
    eventCount: events.length,
    index: [],
    eventFile: "cursor_events.bin",
    events,
  }
}

describe("parseCursorTelemetryFile", () => {
  it("parses a valid telemetry file and matches the full schema output", () => {
    const input = makeTelemetry([
      makeEvent(),
      makeEvent({ tMs: 8, sourceX: 30.25, buttonEvent: "none" }),
    ])

    const fast = parseCursorTelemetryFile(input)
    const full = cursorTelemetryFileSchema.parse(input)

    expect(fast.events).toHaveLength(2)
    expect(fast.events[0]).toEqual(full.events[0])
    expect(fast.events[1]).toEqual(full.events[1])
    expect(fast.sampleRateHz).toBe(120)
    expect(fast.recordingId).toBe("rec-1")
  })

  it("applies the same top-level defaults as the file schema", () => {
    const input = {
      recordingId: "rec-1",
      sourceWidth: 1920,
      sourceHeight: 1080,
      events: [],
    }

    const fast = parseCursorTelemetryFile(input)
    const full = cursorTelemetryFileSchema.parse(input)

    expect(fast.schemaVersion).toBe(full.schemaVersion)
    expect(fast.assetId).toBe(full.assetId)
    expect(fast.captureBounds).toEqual(full.captureBounds)
    expect(fast.coordinateTransform).toEqual(full.coordinateTransform)
  })

  it("rejects an event missing a required field with a ZodError", () => {
    const { sourceX: _omitted, ...missingSourceX } = makeEvent()
    const input = makeTelemetry([missingSourceX])

    expect(() => parseCursorTelemetryFile(input)).toThrow(z.ZodError)
  })

  it("rejects non-finite source coordinates", () => {
    const nanSource = makeTelemetry([makeEvent({ sourceX: Number.NaN })])
    const infiniteSource = makeTelemetry([makeEvent({ sourceY: Number.POSITIVE_INFINITY })])

    expect(() => parseCursorTelemetryFile(nanSource)).toThrow(z.ZodError)
    expect(() => parseCursorTelemetryFile(infiniteSource)).toThrow(z.ZodError)
  })

  it("rejects a non-integer tMs or raw coordinate", () => {
    expect(() => parseCursorTelemetryFile(makeTelemetry([makeEvent({ tMs: 1.5 })]))).toThrow(
      z.ZodError,
    )
    expect(() => parseCursorTelemetryFile(makeTelemetry([makeEvent({ rawX: 1.5 })]))).toThrow(
      z.ZodError,
    )
  })

  it("rejects an unknown buttonEvent string", () => {
    const input = makeTelemetry([makeEvent({ buttonEvent: "left-double-click" })])
    expect(() => parseCursorTelemetryFile(input)).toThrow(z.ZodError)
  })

  it("rejects a malformed buttons object", () => {
    const input = makeTelemetry([
      makeEvent({ buttons: { left: true, right: false, middle: false, x1: false } }),
    ])
    expect(() => parseCursorTelemetryFile(input)).toThrow(z.ZodError)
  })

  it("rejects a missing or non-array events field", () => {
    const { events: _omitted, ...withoutEvents } = makeTelemetry([])
    expect(() => parseCursorTelemetryFile(withoutEvents)).toThrow(z.ZodError)
    expect(() =>
      parseCursorTelemetryFile({ ...makeTelemetry([]), events: "not-an-array" }),
    ).toThrow(z.ZodError)
  })
})
