import { describe, expect, it } from "vitest"
import { captureSourceSchema, recordingConfigSchema } from "./recording"

describe("recording contracts", () => {
  it("validates a display capture source", () => {
    const source = {
      kind: "display" as const,
      id: "display-1",
      name: "Main Display",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }

    expect(captureSourceSchema.parse(source)).toEqual(source)
  })

  it("validates a recording config", () => {
    const config = {
      source: {
        kind: "display" as const,
        id: "display-1",
        name: "Main Display",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      profile: "balanced" as const,
      captureMicrophone: true,
      captureSystemAudio: false,
      captureWebcam: false,
    }

    expect(recordingConfigSchema.parse(config)).toEqual(config)
  })
})
