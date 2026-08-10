import { cursorTelemetryFileSchema, type CursorTelemetryFile } from "@recordforge/contracts"
import { invokeValidated } from "./ipc"

export async function getCursorTelemetry(recordingId: string): Promise<CursorTelemetryFile | null> {
  return invokeValidated(
    "get_cursor_telemetry",
    { recordingId },
    cursorTelemetryFileSchema.nullable(),
  )
}
