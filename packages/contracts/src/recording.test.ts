import { describe, expect, it } from "vitest"
import {
  audioDeviceSchema,
  benchmarkReportSchema,
  captureSourceSchema,
  diagnosticsReportSchema,
  encoderInfoSchema,
  exportOptionsSchema,
  libraryRecordingSchema,
  recordingConfigSchema,
  recordingManifestSchema,
  recordingMarkerSchema,
  recordingProfileSchema,
  recordingStatsSchema,
  recordingStatusSchema,
  recoveryScanResultSchema,
  trimOptionsSchema,
  videoDeviceSchema,
} from "./recording"
import { mediaMetadataSchema } from "./media"

describe("recording contracts", () => {
  it("accepts null optional media fields emitted by Rust for existing recordings", () => {
    const metadata = {
      recordingId: "recording-1",
      path: "C:/recordforge/recording-1/output.mp4",
      durationMs: 10_000,
      width: 1920,
      height: 1080,
      fps: 60,
      hasAudio: true,
      videoCodec: "h264",
      audioCodec: null,
      bitrateKbps: null,
      streams: [
        {
          index: 0,
          kind: "video" as const,
          codec: "h264",
          title: null,
          startMs: null,
          durationMs: null,
          codecLongName: null,
          width: 1920,
          height: 1080,
          fps: 60,
          bitrateKbps: null,
          sampleRate: null,
          channels: null,
          channelLayout: null,
          language: null,
        },
        {
          index: 1,
          kind: "audio" as const,
          codec: "aac",
          title: null,
          startMs: null,
          durationMs: null,
          codecLongName: null,
          width: null,
          height: null,
          fps: null,
          bitrateKbps: null,
          sampleRate: 48_000,
          channels: 2,
          channelLayout: null,
          language: null,
        },
      ],
      format: {
        name: "mov,mp4,m4a,3gp,3g2,mj2",
        durationMs: null,
        sizeBytes: null,
        bitrateKbps: null,
      },
      updatedAt: "2026-08-04T12:00:00.000Z",
    }

    expect(mediaMetadataSchema.parse(metadata)).toMatchObject(metadata)
  })

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

    const config60fps = {
      ...config,
      profile: "smooth-60fps" as const,
    }
    expect(recordingConfigSchema.parse(config60fps)).toEqual(config60fps)

    const config4k = {
      ...config,
      profile: "ultra-4k" as const,
    }
    expect(recordingConfigSchema.parse(config4k)).toEqual(config4k)

    const config4k60 = {
      ...config,
      profile: "ultra-4k-60" as const,
    }
    expect(recordingConfigSchema.parse(config4k60)).toEqual(config4k60)
  })

  it("validates a recording profile", () => {
    const profile = {
      id: "low-impact",
      label: "Low Impact",
      width: 1280,
      height: 720,
      fps: 30,
      crf: 28,
      encoderPriority: ["libx264"],
    }

    expect(recordingProfileSchema.parse(profile)).toMatchObject(profile)
  })

  it("accepts nullable optional encoder settings emitted by Rust", () => {
    const profile = {
      id: "low-impact",
      label: "Low Impact",
      width: 1280,
      height: 720,
      fps: 30,
      videoBitrateKbps: null,
      crf: null,
      encoderPriority: ["libx264"],
      audioCodec: "aac",
      audioBitrateKbps: 128,
    }

    expect(recordingProfileSchema.parse(profile)).toEqual(profile)
  })

  it("validates a recording status", () => {
    const status = {
      sessionId: "session-1",
      state: "recording" as const,
      startedAt: "2026-08-02T12:00:00.000Z",
      durationMs: 1000,
      recordedMs: 0,
    }

    expect(recordingStatusSchema.parse(status)).toMatchObject(status)
  })

  it("accepts RFC3339 offsets emitted by Rust", () => {
    const status = {
      sessionId: "session-1",
      state: "recording" as const,
      startedAt: "2026-08-02T12:00:00+00:00",
      durationMs: 1000,
      recordedMs: 1000,
    }

    expect(recordingStatusSchema.parse(status).startedAt).toBe(status.startedAt)
  })

  it("validates a recording manifest with fragments and markers", () => {
    const manifest = {
      version: 1 as const,
      sessionId: "session-1",
      state: "recording" as const,
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:01.000Z",
      source: {
        kind: "display" as const,
        id: "display-1",
        name: "Main Display",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      profileName: "balanced",
      workDir: "C:/temp/session-1",
      fragments: [
        {
          index: 0,
          fileName: "seg_000.mp4",
          startedAt: "2026-08-02T12:00:00.000Z",
          durationMs: 10000,
          sizeBytes: 1024,
          validated: true,
        },
      ],
      markers: [
        {
          id: "marker-1",
          label: "Intro",
          timestampMs: 2500,
          createdAt: "2026-08-02T12:00:02.500Z",
        },
      ],
      totalRecordedMs: 10000,
    }

    expect(recordingManifestSchema.parse(manifest)).toMatchObject(manifest)
  })

  it("validates a recording marker", () => {
    const marker = {
      id: "marker-1",
      label: "Key moment",
      timestampMs: 1500,
      createdAt: "2026-08-02T12:00:01.500Z",
    }

    expect(recordingMarkerSchema.parse(marker)).toEqual(marker)
  })

  it("validates an encoder info", () => {
    const encoder = {
      id: "libx264",
      name: "x264",
      codec: "h264",
      vendor: null,
      available: true,
      reason: null,
      supportsCrf: true,
    }

    expect(encoderInfoSchema.parse(encoder)).toMatchObject(encoder)
  })

  it("validates recording stats", () => {
    const stats = {
      framesProcessed: 300,
      fps: 30.5,
      speed: 1.05,
      exitCode: 0,
      durationMs: 10000,
      outputSizeBytes: 1024000,
    }

    expect(recordingStatsSchema.parse(stats)).toMatchObject(stats)
  })

  it("validates a recovery scan result", () => {
    const result = {
      sessionId: "session-1",
      state: "failed" as const,
      manifestPath: "C:/temp/session-1/session.json",
      outputPath: "C:/temp/session-1/output.mp4",
      outputSizeBytes: 1024000,
      isRecoverable: true,
      validationError: undefined,
    }

    expect(recoveryScanResultSchema.parse(result)).toMatchObject(result)
  })

  it("validates a benchmark report", () => {
    const report = {
      id: "bench-1",
      createdAt: "2026-08-02T12:00:00.000Z",
      platform: {
        os: "windows",
        ffmpegVersion: "6.0",
        cpu: null,
        memoryMb: null,
      },
      results: [
        {
          encoderId: "libx264",
          profileId: "low-impact",
          width: 1280,
          height: 720,
          fps: 30,
          durationSec: 10,
          framesProcessed: 300,
          avgFps: 30,
          speed: 1.0,
          bitrateKbps: null,
          cpuPercent: null,
          memoryMb: null,
          error: null,
        },
      ],
      recommendation: {
        profileId: "low-impact",
        encoderId: "libx264",
        reason: "Reliable on low-end CPUs.",
      },
    }

    expect(benchmarkReportSchema.parse(report)).toMatchObject(report)
  })

  it("accepts nullable diagnostics fields emitted by Rust", () => {
    const report = {
      platform: {
        os: "windows",
        ffmpegVersion: "6.0",
        cpu: null,
        memoryMb: null,
      },
      encoders: [
        {
          id: "libx264",
          name: "x264",
          codec: "h264",
          vendor: null,
          available: true,
          reason: null,
        },
      ],
      audioDevices: [],
      videoDevices: [],
    }

    expect(diagnosticsReportSchema.parse(report)).toMatchObject(report)
  })

  it("validates audio and video devices", () => {
    const audio = {
      id: "audio-1",
      name: "Microphone (Realtek)",
      kind: "microphone" as const,
      isDefault: true,
    }

    const video = {
      id: "video-1",
      name: "Integrated Webcam",
      kind: "webcam" as const,
      isDefault: true,
    }

    expect(audioDeviceSchema.parse(audio)).toEqual(audio)
    expect(videoDeviceSchema.parse(video)).toEqual(video)
  })

  it("validates a library recording", () => {
    const recording = {
      id: "rec-1",
      sessionId: "session-1",
      name: "Tutorial",
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:01.000Z",
      durationMs: 10000,
      sizeBytes: 1024000,
      width: 1920,
      height: 1080,
      fps: 30,
      status: "completed" as const,
      tags: ["tutorial"],
      source: {
        kind: "display" as const,
        id: "display-1",
        name: "Main Display",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      profileName: "balanced",
      outputPath: "C:/temp/session-1/output.mp4",
      workDir: "C:/temp/session-1",
      markers: [],
    }

    expect(libraryRecordingSchema.parse(recording)).toMatchObject(recording)
  })

  it("validates trim and export options", () => {
    const trim = {
      recordingId: "rec-1",
      startMs: 1000,
      endMs: 5000,
    }

    const exportOptions = {
      recordingId: "rec-1",
      outputPath: "C:/users/hagen/videos/export.mp4",
    }

    expect(trimOptionsSchema.parse(trim)).toEqual(trim)
    expect(exportOptionsSchema.parse(exportOptions)).toEqual(exportOptions)
  })
})
