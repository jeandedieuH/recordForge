import { z } from "zod"
import {
  applyCursorTelemetryFileDefaults,
  cursorButtonEventV2Schema,
  cursorTelemetryEventSchema,
  cursorTelemetryMetadataSchema,
  type CursorTelemetryEvent,
  type CursorTelemetryFile,
} from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

const KNOWN_BUTTON_EVENTS = new Set<string>(cursorButtonEventV2Schema.options)
const unknownArraySchema = z.array(z.unknown())

/**
 * Structural check mirroring cursorTelemetryEventSchema. Every condition maps
 * one-to-one to a schema rule, so a false return always means the event would
 * also fail schema validation; the caller delegates to the schema to surface
 * the canonical ZodError.
 */
function isCursorTelemetryEvent(event: unknown): event is CursorTelemetryEvent {
  if (typeof event !== "object" || event === null) return false
  const candidate = event as Record<string, unknown>
  if (typeof candidate.tMs !== "number" || !Number.isInteger(candidate.tMs) || candidate.tMs < 0) {
    return false
  }
  if (!Number.isInteger(candidate.rawX) || !Number.isInteger(candidate.rawY)) return false
  if (typeof candidate.sourceX !== "number" || !Number.isFinite(candidate.sourceX)) return false
  if (typeof candidate.sourceY !== "number" || !Number.isFinite(candidate.sourceY)) return false
  if (
    typeof candidate.buttonEvent !== "string" ||
    !KNOWN_BUTTON_EVENTS.has(candidate.buttonEvent)
  ) {
    return false
  }
  if (typeof candidate.visible !== "boolean" || typeof candidate.shapeChanged !== "boolean") {
    return false
  }
  if (typeof candidate.shapeId !== "string") return false

  const buttons = candidate.buttons
  if (typeof buttons !== "object" || buttons === null) return false
  const state = buttons as Record<string, unknown>
  return (
    typeof state.left === "boolean" &&
    typeof state.right === "boolean" &&
    typeof state.middle === "boolean" &&
    typeof state.x1 === "boolean" &&
    typeof state.x2 === "boolean"
  )
}

/**
 * Parse a cursor telemetry file without running per-event Zod validation.
 * Metadata goes through cursorTelemetryMetadataSchema (with the same V2
 * defaults the file schema applies) and each event is checked by the
 * structural guard. On long captures this is an order of magnitude faster
 * than cursorTelemetryFileSchema.parse while rejecting the same inputs.
 */
export function parseCursorTelemetryFile(input: unknown): CursorTelemetryFile {
  const withDefaults = applyCursorTelemetryFileDefaults(input)
  const metadata = cursorTelemetryMetadataSchema.parse(withDefaults)
  const events = unknownArraySchema.parse(
    (withDefaults as { events?: unknown }).events,
  ) as unknown[]
  for (let index = 0; index < events.length; index++) {
    if (isCursorTelemetryEvent(events[index])) continue
    // The guard only fails on genuine schema violations, so this parse always
    // throws — producing the same ZodError the file schema would have.
    cursorTelemetryEventSchema.parse(events[index])
    throw new Error(`cursor telemetry event at index ${index} failed validation`)
  }
  return { ...metadata, events: events as CursorTelemetryEvent[] }
}

export async function getCursorTelemetry(recordingId: string): Promise<CursorTelemetryFile | null> {
  try {
    const raw = await invokeValidated<unknown>("get_cursor_telemetry", { recordingId })
    const parsed = raw === null ? null : parseCursorTelemetryFile(raw)
    console.log("[getCursorTelemetry] raw result:", {
      recordingId,
      hasTelemetry: !!parsed,
      eventCount: parsed?.events?.length,
    })
    return parsed
  } catch (error) {
    console.error("[getCursorTelemetry] failed:", { recordingId, error })
    throw error
  }
}
