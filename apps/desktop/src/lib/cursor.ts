import { cursorTelemetryFileSchema, type CursorTelemetryFile } from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function getCursorTelemetry(recordingId: string): Promise<CursorTelemetryFile | null> {
  try {
    const raw = await invokeValidated(
      "get_cursor_telemetry",
      { recordingId },
      cursorTelemetryFileSchema.nullable(),
    )
    // eslint-disable-next-line no-console
    console.log("[getCursorTelemetry] raw result:", {
      recordingId,
      hasTelemetry: !!raw,
      eventCount: raw?.events?.length,
    })
    return raw
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[getCursorTelemetry] failed:", { recordingId, error })
    throw error
  }
}
