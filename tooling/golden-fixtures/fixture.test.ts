import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  recordingConfigSchema,
  recordingStatusSchema,
  libraryRecordingSchema,
} from "@recordforge/contracts"

describe("Golden IPC Fixture Validation", () => {
  test("recording-config.json matches recordingConfigSchema", () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, "recording-config.json"), "utf-8")
    )
    const parsed = recordingConfigSchema.parse(json)
    expect(parsed.profile).toBe("balanced")
    expect(parsed.source.kind).toBe("display")
  })

  test("recording-status.json matches recordingStatusSchema", () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, "recording-status.json"), "utf-8")
    )
    const parsed = recordingStatusSchema.parse(json)
    expect(parsed.state).toBe("recording")
    expect(parsed.durationMs).toBe(15000)
  })

  test("library-recording.json matches libraryRecordingSchema", () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, "library-recording.json"), "utf-8")
    )
    const parsed = libraryRecordingSchema.parse(json)
    expect(parsed.status).toBe("completed")
    expect(parsed.tags).toContain("demo")
  })
})
