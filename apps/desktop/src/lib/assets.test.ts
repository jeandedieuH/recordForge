import { describe, expect, it } from "vitest"
import {
  isAbsolutePath,
  isWebUrl,
  resolveAssetPath,
  toAssetUrl,
} from "./assets"

describe("Asset Path Resolution & URL Helpers", () => {
  describe("isWebUrl", () => {
    it("identifies http and https URLs", () => {
      expect(isWebUrl("http://localhost:1420/test.png")).toBe(true)
      expect(isWebUrl("https://example.com/image.png")).toBe(true)
    })

    it("identifies blob and data URLs", () => {
      expect(isWebUrl("blob:http://localhost/uuid-123")).toBe(true)
      expect(isWebUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==")).toBe(true)
    })

    it("identifies asset protocol URLs", () => {
      expect(isWebUrl("asset://localhost/C:/path/to/file.png")).toBe(true)
    })

    it("returns false for regular paths and nullish values", () => {
      expect(isWebUrl("C:/sessions/item/file.png")).toBe(false)
      expect(isWebUrl("assets/image.png")).toBe(false)
      expect(isWebUrl("")).toBe(false)
      expect(isWebUrl(null)).toBe(false)
      expect(isWebUrl(undefined)).toBe(false)
    })
  })

  describe("isAbsolutePath", () => {
    it("identifies Windows drive letter paths with forward and backward slashes", () => {
      expect(isAbsolutePath("C:\\Users\\user\\sessions\\uuid\\assets\\file.png")).toBe(true)
      expect(isAbsolutePath("C:/Users/user/sessions/uuid/assets/file.png")).toBe(true)
      expect(isAbsolutePath("d:\\1-Projects\\app\\assets\\logo.png")).toBe(true)
      expect(isAbsolutePath("z:/media/test.mp4")).toBe(true)
    })

    it("identifies UNC network paths", () => {
      expect(isAbsolutePath("\\\\server\\share\\assets\\file.png")).toBe(true)
    })

    it("identifies POSIX absolute paths", () => {
      expect(isAbsolutePath("/home/user/sessions/uuid/file.png")).toBe(true)
      expect(isAbsolutePath("/tmp/test.png")).toBe(true)
    })

    it("returns false for relative paths", () => {
      expect(isAbsolutePath("assets/4c8966f0562843da-prestigelearning.png")).toBe(false)
      expect(isAbsolutePath("assets\\image.png")).toBe(false)
      expect(isAbsolutePath("output.mp4")).toBe(false)
      expect(isAbsolutePath("./output.mp4")).toBe(false)
      expect(isAbsolutePath("../output.mp4")).toBe(false)
    })

    it("returns false for empty and nullish inputs", () => {
      expect(isAbsolutePath("")).toBe(false)
      expect(isAbsolutePath(null)).toBe(false)
      expect(isAbsolutePath(undefined)).toBe(false)
    })
  })

  describe("resolveAssetPath", () => {
    const workDirWindows = "C:\\Users\\user\\AppData\\Roaming\\com.recordforge.app\\sessions\\sess-1"
    const workDirPosix = "/home/user/.config/com.recordforge.app/sessions/sess-1"

    it("returns absolute paths untouched", () => {
      const winPath = "C:\\temp\\image.png"
      expect(resolveAssetPath(winPath, workDirWindows)).toBe(winPath)

      const posixPath = "/tmp/image.png"
      expect(resolveAssetPath(posixPath, workDirPosix)).toBe(posixPath)
    })

    it("returns web/data/blob URLs untouched", () => {
      const url = "http://asset.localhost/image.png"
      expect(resolveAssetPath(url, workDirWindows)).toBe(url)
    })

    it("joins relative asset paths with workDir", () => {
      const relative = "assets/4c8966f0562843da-prestigelearning.png"
      const resolved = resolveAssetPath(relative, workDirWindows)
      expect(resolved).toBe(
        "C:\\Users\\user\\AppData\\Roaming\\com.recordforge.app\\sessions\\sess-1/assets/4c8966f0562843da-prestigelearning.png",
      )
    })

    it("normalizes trailing slashes on workDir during join", () => {
      const workDirWithSlash = "C:/sessions/sess-1/"
      const relative = "assets/image.png"
      expect(resolveAssetPath(relative, workDirWithSlash)).toBe("C:/sessions/sess-1/assets/image.png")
    })

    it("returns null when relative path is given without workDir", () => {
      expect(resolveAssetPath("assets/image.png", null)).toBeNull()
      expect(resolveAssetPath("assets/image.png", undefined)).toBeNull()
    })

    it("returns null for empty or nullish path", () => {
      expect(resolveAssetPath("", workDirWindows)).toBeNull()
      expect(resolveAssetPath(null, workDirWindows)).toBeNull()
      expect(resolveAssetPath(undefined, workDirWindows)).toBeNull()
    })
  })

  describe("toAssetUrl", () => {
    it("returns null for empty or nullish path", () => {
      expect(toAssetUrl(null)).toBeNull()
      expect(toAssetUrl(undefined)).toBeNull()
      expect(toAssetUrl("")).toBeNull()
    })

    it("returns web URLs as-is", () => {
      expect(toAssetUrl("http://example.com/pic.jpg")).toBe("http://example.com/pic.jpg")
      expect(toAssetUrl("data:image/png;base64,xxx")).toBe("data:image/png;base64,xxx")
    })

    it("resolves relative path with workDir outside Tauri (e.g. mock/test)", () => {
      const workDir = "C:/sessions/sess-1"
      const relative = "assets/pic.png"
      // In bun test environment, isTauri() is false, so resolved path is returned directly
      expect(toAssetUrl(relative, workDir)).toBe("C:/sessions/sess-1/assets/pic.png")
    })
  })
})
