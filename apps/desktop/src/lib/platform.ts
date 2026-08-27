/**
 * Cross-platform detection and UI helper utilities for recordForge.
 */

export const isMac =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent || navigator.platform || "")

export const isLinux =
  typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent || navigator.platform || "")

export const isWindows = !isMac && !isLinux

/**
 * Standard modifier key symbol (⌘ on macOS, Ctrl on Windows/Linux).
 */
export const MODIFIER_KEY = isMac ? "⌘" : "Ctrl"

/**
 * Standard modifier key name (Cmd on macOS, Ctrl on Windows/Linux).
 */
export const MODIFIER_NAME = isMac ? "Cmd" : "Ctrl"

/**
 * Human-readable name of the native OS secure credential vault.
 */
export const VAULT_NAME = isMac
  ? "macOS Keychain"
  : isLinux
    ? "Secret Service"
    : "Windows Credential Manager"
