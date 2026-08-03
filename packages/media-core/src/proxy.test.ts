import { describe, expect, test } from "vitest"
import { buildProxyJob, buildWaveformJob } from "./proxy"

describe("Media Core Proxy & Waveform", () => {
  test("builds 360p proxy job spec", () => {
    const job = buildProxyJob({
      inputPath: "/media/raw.mp4",
      outputPath: "/media/proxy.mp4",
    })
    expect(job.kind).toBe("export")
    expect(job.args).toContain("scale=-2:360")
    expect(job.args).toContain("ultrafast")
  })

  test("builds waveform job spec", () => {
    const job = buildWaveformJob({
      inputPath: "/media/raw.mp4",
      outputPath: "/media/waveform.json",
    })
    expect(job.kind).toBe("waveform")
    expect(job.args).toContain("s16le")
  })
})
