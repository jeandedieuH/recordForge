import { invoke } from "@tauri-apps/api/core"

/** True when running inside the Tauri webview (false in plain browser dev/tests). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key })
}

export async function setSetting(key: string, value: string): Promise<void> {
  await invoke("set_setting", { key, value })
}

export async function setWindowTransparency(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_window_transparency", { enabled })
}

export async function windowTransparencyActive(): Promise<boolean> {
  return invoke<boolean>("window_transparency_active")
}
