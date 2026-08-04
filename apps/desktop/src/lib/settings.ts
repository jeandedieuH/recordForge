import { z } from "zod"
import { invokeValidated } from "./ipc"

/** True when running inside the Tauri webview (false in plain browser dev/tests). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function getSetting(key: string): Promise<string | null> {
  return invokeValidated("get_setting", { key }, z.string().nullable())
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invokeValidated<void>("set_setting", { key, value })
}

export async function setWindowTransparency(enabled: boolean): Promise<boolean> {
  return invokeValidated("set_window_transparency", { enabled }, z.boolean())
}

export async function windowTransparencyActive(): Promise<boolean> {
  return invokeValidated("window_transparency_active", undefined, z.boolean())
}
