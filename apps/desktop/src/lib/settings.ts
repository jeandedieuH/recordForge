import { z } from "zod"
import { invokeValidated } from "./ipc"

/** True when running inside the Tauri webview (false in plain browser dev/tests). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function getSetting(key: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const val = await invokeValidated("get_setting", { key }, z.string().nullable())
      if (val !== null && typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(`recordforge:${key}`, val)
        } catch {
          // Ignore storage errors
        }
      }
      return val
    } catch {
      try {
        return typeof localStorage !== "undefined"
          ? localStorage.getItem(`recordforge:${key}`)
          : null
      } catch {
        return null
      }
    }
  }
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(`recordforge:${key}`) : null
  } catch {
    return null
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`recordforge:${key}`, value)
    }
  } catch {
    // Ignore storage quota errors in dev/tests
  }
  if (isTauri()) {
    return invokeValidated<void>("set_setting", { key, value })
  }
}

export async function setWindowTransparency(enabled: boolean): Promise<boolean> {
  return invokeValidated("set_window_transparency", { enabled }, z.boolean())
}

export async function windowTransparencyActive(): Promise<boolean> {
  return invokeValidated("window_transparency_active", undefined, z.boolean())
}
