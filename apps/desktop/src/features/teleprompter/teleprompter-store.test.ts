import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_TELEPROMPTER_SETTINGS,
  FONT_SIZE_LIMIT,
  WPM_LIMIT,
} from "./lib/teleprompter-settings"

const storageMap = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageMap.set(key, value)
  },
  removeItem: (key: string) => {
    storageMap.delete(key)
  },
  clear: () => {
    storageMap.clear()
  },
}
// @ts-expect-error polyfill for test environment
globalThis.localStorage = mockLocalStorage

const NOTES_KEY = "recordforge.teleprompter.notes"
const SETTINGS_KEY = "recordforge.teleprompter.settings"

type TeleprompterStore = typeof import("./teleprompter-store").useTeleprompterStore

// The store reads localStorage at creation, so each test gets a fresh module.
async function freshStore(): Promise<TeleprompterStore> {
  vi.resetModules()
  return (await import("./teleprompter-store")).useTeleprompterStore
}

describe("teleprompter-store", () => {
  beforeEach(() => {
    storageMap.clear()
  })

  it("starts in prompt mode when notes are saved, edit mode otherwise", async () => {
    storageMap.set(NOTES_KEY, "Hello world")
    let store = await freshStore()
    expect(store.getState().mode).toBe("prompt")
    expect(store.getState().playing).toBe(false)

    storageMap.clear()
    store = await freshStore()
    expect(store.getState().mode).toBe("edit")

    storageMap.set(NOTES_KEY, "   \n  ")
    store = await freshStore()
    expect(store.getState().mode).toBe("edit")
  })

  it("loads the legacy raw-string notes key and legacy settings shape", async () => {
    storageMap.set(NOTES_KEY, "line one\nline two")
    storageMap.set(SETTINGS_KEY, JSON.stringify({ speed: 170, fontSize: 34, mirror: false }))
    const store = await freshStore()
    expect(store.getState().notes).toBe("line one\nline two")
    expect(store.getState().settings.fontSize).toBe(34)
    expect(store.getState().settings.wpm).toBe(DEFAULT_TELEPROMPTER_SETTINGS.wpm)
  })

  it("persists notes and settings synchronously", async () => {
    const store = await freshStore()
    store.getState().setNotes("a fresh script")
    store.getState().updateSettings({ wpm: 200, mirror: true })

    expect(storageMap.get(NOTES_KEY)).toBe("a fresh script")
    const storedSettings = JSON.parse(storageMap.get(SETTINGS_KEY) ?? "{}")
    expect(storedSettings.wpm).toBe(200)
    expect(storedSettings.mirror).toBe(true)

    const reloaded = await freshStore()
    expect(reloaded.getState().notes).toBe("a fresh script")
    expect(reloaded.getState().settings.wpm).toBe(200)
    expect(reloaded.getState().settings.mirror).toBe(true)
  })

  it("play() is a no-op without a script", async () => {
    const store = await freshStore()
    store.getState().play()
    expect(store.getState().playing).toBe(false)
    expect(store.getState().mode).toBe("edit")

    store.getState().setNotes("   ")
    store.getState().play()
    expect(store.getState().playing).toBe(false)
  })

  it("play() from edit mode switches to prompt, plays, and restarts from top", async () => {
    const store = await freshStore()
    store.getState().setNotes("some words")
    const token = store.getState().restartToken
    store.getState().play()
    expect(store.getState().mode).toBe("prompt")
    expect(store.getState().playing).toBe(true)
    expect(store.getState().restartToken).toBe(token + 1)
  })

  it("play() while already prompting does not bump the restart token", async () => {
    storageMap.set(NOTES_KEY, "a script")
    const store = await freshStore()
    const token = store.getState().restartToken
    store.getState().play()
    expect(store.getState().playing).toBe(true)
    expect(store.getState().restartToken).toBe(token)

    store.getState().pause()
    store.getState().play()
    expect(store.getState().restartToken).toBe(token)
  })

  it("setMode() never bumps the restart token", async () => {
    storageMap.set(NOTES_KEY, "a script")
    const store = await freshStore()
    const token = store.getState().restartToken
    store.getState().setMode("edit")
    store.getState().setMode("prompt")
    store.getState().setMode("edit")
    expect(store.getState().restartToken).toBe(token)
  })

  it("togglePlay() from edit behaves like play(): prompt + restart bump", async () => {
    const store = await freshStore()
    store.getState().setNotes("some words")
    const token = store.getState().restartToken
    store.getState().togglePlay()
    expect(store.getState().mode).toBe("prompt")
    expect(store.getState().playing).toBe(true)
    expect(store.getState().restartToken).toBe(token + 1)
  })

  it("setMode('edit') pauses; setMode('prompt') refuses empty notes", async () => {
    storageMap.set(NOTES_KEY, "a script")
    let store = await freshStore()
    store.getState().play()
    store.getState().setMode("edit")
    expect(store.getState().playing).toBe(false)
    expect(store.getState().mode).toBe("edit")

    storageMap.clear()
    store = await freshStore()
    store.getState().setMode("prompt")
    expect(store.getState().mode).toBe("edit")
  })

  it("restart() pauses and bumps the restart token", async () => {
    storageMap.set(NOTES_KEY, "a script")
    const store = await freshStore()
    store.getState().play()
    const token = store.getState().restartToken
    store.getState().restart()
    expect(store.getState().playing).toBe(false)
    expect(store.getState().restartToken).toBe(token + 1)
  })

  it("updateSettings sanitizes and clamps", async () => {
    const store = await freshStore()
    store.getState().updateSettings({ wpm: 9999, fontSize: -3 })
    expect(store.getState().settings.wpm).toBe(WPM_LIMIT.max)
    expect(store.getState().settings.fontSize).toBe(FONT_SIZE_LIMIT.min)

    store.getState().updateSettings({ wpm: 175 })
    expect(store.getState().settings.wpm).toBe(175)
  })

  it("survives a corrupted settings blob", async () => {
    storageMap.set(SETTINGS_KEY, "{not json")
    const store = await freshStore()
    expect(store.getState().settings).toEqual(DEFAULT_TELEPROMPTER_SETTINGS)
  })
})
