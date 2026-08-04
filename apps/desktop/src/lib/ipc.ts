import { invoke } from "@tauri-apps/api/core"
import { z } from "zod"

/**
 * Type-safe, Zod-validated Tauri IPC call wrapper.
 * Ensures data received over IPC matches the expected contract schema before returning to React.
 */
export async function invokeValidated<T>(
  command: string,
  args?: Record<string, unknown>,
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const raw = await invoke(command, args)
  if (schema) {
    return schema.parse(raw)
  }
  return raw as T
}
