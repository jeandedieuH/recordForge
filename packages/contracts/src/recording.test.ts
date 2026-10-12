import { describe, expect, it } from "vitest"
import cameraTiersFixture from "../../../tooling/fixtures/camera-tiers.json"
import {
  audioDeviceSchema,
  benchmarkReportSchema,
  cameraCapturePlanSchema,
  cameraTierBudget,
  cameraTiers,
  recordingStorageInfoSchema,
  captureDiagnosticsSchema,
  captureProgressSchema,
  captureSourceSchema,
  defaultRecordingPreferences,
  diagnosticsReportSchema,
  encoderInfoSchema,
  exportOptionsSchema,
  libraryRecordingSchema,
  reconcileCameraDevice,
  reconcileCaptureSource,
  reconcileMicrophone,
  reconcileProfile,
  reconcileSystemAudio,
  reconcileWebcam,
  recordingConfigSchema,
  recordingManifestSchema,
  recordingMarkerSchema,
  recordingPreferencesSchema,
  recordingProfileSchema,
  recordingStatsSchema,
  recordingStatusSchema,
  recoveryScanResultSchema,
  sessionCaptureDiagnosticsSchema,
  trimOptionsSchema,
  videoDeviceSchema,
  webcamPreviewModeSchema,
} from "./recording"
import type { CameraProfileId } from "./recording"
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

  it("validates a camera capture source", () => {
    const source = {
      kind: "camera" as const,
      id: "USB Video Device",
      name: "Integrated Webcam",
      // Camera bounds carry the tier's output budget, not a screen rect.
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }

    expect(captureSourceSchema.parse(source)).toEqual(source)
  })

  it("validates a camera source in manifest and library payloads", () => {
    const cameraSource = {
      kind: "camera" as const,
      id: "cam-1",
      name: "Studio Camera",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }

    const manifest = recordingManifestSchema.parse({
      version: 1,
      sessionId: "session-camera",
      state: "completed",
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:01.000Z",
      source: cameraSource,
      profileName: "camera-balanced",
      workDir: "C:/temp/session-camera",
      fragments: [],
    })
    expect(manifest.source.kind).toBe("camera")

    const recording = libraryRecordingSchema.parse({
      id: "rec-cam",
      sessionId: "session-camera",
      name: "Talking head",
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:01.000Z",
      durationMs: 5000,
      sizeBytes: 2048,
      width: 1920,
      height: 1080,
      fps: 30,
      status: "completed",
      source: cameraSource,
      profileName: "camera-balanced",
      workDir: "C:/temp/session-camera",
    })
    expect(recording.source.kind).toBe("camera")
  })

  it("accepts each camera profile with a camera source", () => {
    const source = {
      kind: "camera" as const,
      id: "cam-1",
      name: "Studio Camera",
      bounds: { x: 0, y: 0, width: 3840, height: 2160 },
    }
    for (const profile of [
      "camera-low",
      "camera-balanced",
      "camera-high",
      "camera-ultra",
    ] as const) {
      const parsed = recordingConfigSchema.parse({
        source,
        profile,
        captureMicrophone: true,
        captureSystemAudio: false,
        captureWebcam: false,
      })
      expect(parsed.profile).toBe(profile)
      expect(parsed.source.kind).toBe("camera")
    }
  })

  it("still accepts the legacy camera-only id and screen profiles", () => {
    const source = {
      kind: "display" as const,
      id: "display-1",
      name: "Main Display",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    }
    for (const profile of ["camera-only", "balanced"] as const) {
      const parsed = recordingConfigSchema.parse({
        source,
        profile,
        captureMicrophone: false,
        captureSystemAudio: false,
        captureWebcam: false,
      })
      expect(parsed.profile).toBe(profile)
    }
  })

  it("validates a camera capture plan", () => {
    const plan = {
      profileId: "camera-balanced" as const,
      input: {
        width: 1920,
        height: 1080,
        fps: 30,
        pixelFormat: "nv12",
        codec: null,
      },
      outputWidth: 1920,
      outputHeight: 1080,
      outputFps: 30,
      videoBitrateKbps: 6842,
      maxBitrateKbps: 10263,
      bufferKbps: 10263,
      crf: 21,
      limitedByCamera: false,
    }
    expect(cameraCapturePlanSchema.parse(plan)).toEqual(plan)

    // The device-defaults attempt has no negotiated input mode.
    const defaults = { ...plan, input: null }
    expect(cameraCapturePlanSchema.parse(defaults).input).toBeNull()

    // Camera plans must reference a camera tier, not a screen profile.
    expect(() => cameraCapturePlanSchema.parse({ ...plan, profileId: "balanced" })).toThrow()
  })

  it("cameraTiers matches the shared camera-tiers fixture", () => {
    // The fixture is the single source of truth for BOTH languages — the
    // Rust parity test in `capture/config.rs` asserts the same fields
    // against `camera_profiles()`/`camera_tier_spec()`.
    expect(cameraTiers).toHaveLength(cameraTiersFixture.length)
    for (const [index, tier] of cameraTiers.entries()) {
      const fixture = cameraTiersFixture[index]
      expect(tier.id).toBe(fixture.id)
      expect(tier.label).toBe(fixture.label)
      expect(tier.width).toBe(fixture.width)
      expect(tier.height).toBe(fixture.height)
      expect(tier.fps).toBe(fixture.fps)
    }
    expect(cameraTierBudget("camera-balanced")).toEqual(cameraTiers[1])
    expect(cameraTierBudget("low-impact" as CameraProfileId)).toBeUndefined()
  })

  it("validates recording storage info", () => {
    expect(recordingStorageInfoSchema.parse({ freeBytes: 12_884_901_888 })).toEqual({
      freeBytes: 12_884_901_888,
    })
    // An unreadable stat degrades to null, not a parse failure.
    expect(recordingStorageInfoSchema.parse({ freeBytes: null }).freeBytes).toBeNull()
    expect(recordingStorageInfoSchema.parse({}).freeBytes).toBeUndefined()
    expect(() => recordingStorageInfoSchema.parse({ freeBytes: -1 })).toThrow()
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

    expect(recordingConfigSchema.parse(config)).toMatchObject({
      ...config,
      smartZoomEnabled: false,
      smartZoomPreset: "product-demo",
    })

    const config60fps = {
      ...config,
      profile: "smooth-60fps" as const,
    }
    expect(recordingConfigSchema.parse(config60fps)).toMatchObject(config60fps)

    const config4k = {
      ...config,
      profile: "ultra-4k" as const,
    }
    expect(recordingConfigSchema.parse(config4k)).toMatchObject(config4k)

    const config4k60 = {
      ...config,
      profile: "ultra-4k-60" as const,
    }
    expect(recordingConfigSchema.parse(config4k60)).toMatchObject(config4k60)
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

  it("round-trips the smart zoom preference used for a recording", () => {
    const parsed = recordingManifestSchema.parse({
      version: 1,
      sessionId: "session-smart-zoom",
      state: "completed",
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:01.000Z",
      source: {
        kind: "display",
        id: "display-1",
        name: "Main Display",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      profileName: "balanced",
      workDir: "C:/temp/session-smart-zoom",
      fragments: [],
      smartZoom: { enabled: true, preset: "cinematic" },
    })

    expect(parsed.smartZoom).toEqual({ enabled: true, preset: "cinematic" })
  })

  it("defaults new recording configs to smart zoom off", () => {
    const parsed = recordingConfigSchema.parse({
      source: {
        kind: "display",
        id: "display-1",
        name: "Main Display",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
      profile: "balanced",
      captureMicrophone: false,
      captureSystemAudio: false,
      captureWebcam: false,
    })

    expect(parsed.smartZoomEnabled).toBe(false)
    expect(parsed.smartZoomPreset).toBe("product-demo")
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

    // Reports predating devicesEnumerated parse with the enumerated default.
    const parsed = diagnosticsReportSchema.parse(report)
    expect(parsed).toMatchObject(report)
    expect(parsed.devicesEnumerated).toBe(true)

    // A deferred report explicitly says enumeration was skipped; empty
    // device arrays then mean "not measured", not "no devices".
    const deferred = { ...report, devicesEnumerated: false }
    const parsedDeferred = diagnosticsReportSchema.parse(deferred)
    expect(parsedDeferred.devicesEnumerated).toBe(false)
    expect(parsedDeferred.audioDevices).toEqual([])
    expect(parsedDeferred.videoDevices).toEqual([])
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

  describe("recording preferences & reconciliation", () => {
    it("validates default preferences", () => {
      const parsed = recordingPreferencesSchema.parse(defaultRecordingPreferences)
      expect(parsed).toEqual(defaultRecordingPreferences)
      expect(parsed.sourceType).toBe("screen")
      expect(parsed.microphoneEnabled).toBe(false)
      expect(parsed.profile).toBe("low-impact")
    })

    it("parses partial stored preferences with defaults", () => {
      const parsed = recordingPreferencesSchema.parse({
        profile: "balanced",
        microphoneEnabled: true,
        microphoneId: "mic-custom",
      })
      expect(parsed.profile).toBe("balanced")
      expect(parsed.microphoneEnabled).toBe(true)
      expect(parsed.microphoneId).toBe("mic-custom")
      expect(parsed.sourceType).toBe("screen")
      expect(parsed.systemAudioEnabled).toBe(false)
      expect(parsed.cameraSyncOffsetMs).toBe(0)
    })

    it("parses and validates custom cameraSyncOffsetMs", () => {
      const parsed = recordingPreferencesSchema.parse({
        cameraSyncOffsetMs: 250,
      })
      expect(parsed.cameraSyncOffsetMs).toBe(250)

      expect(() =>
        recordingPreferencesSchema.parse({
          cameraSyncOffsetMs: 10000,
        }),
      ).toThrow()
    })

    it("reconciles microphone by ID when available", () => {
      const mics = [
        { id: "mic-1", name: "Internal Mic", kind: "microphone" as const, isDefault: true },
        { id: "mic-2", name: "USB Yeti", kind: "microphone" as const, isDefault: false },
      ]
      const result = reconcileMicrophone(mics, {
        ...defaultRecordingPreferences,
        microphoneEnabled: true,
        microphoneId: "mic-2",
        microphoneName: "USB Yeti",
      })
      expect(result).toEqual({ id: "mic-2", enabled: true })
    })

    it("reconciles microphone by Name when ID changed", () => {
      const mics = [
        {
          id: "mic-new-endpoint-id",
          name: "USB Yeti",
          kind: "microphone" as const,
          isDefault: false,
        },
        { id: "mic-1", name: "Internal Mic", kind: "microphone" as const, isDefault: true },
      ]
      const result = reconcileMicrophone(mics, {
        ...defaultRecordingPreferences,
        microphoneEnabled: true,
        microphoneId: "mic-old-id",
        microphoneName: "USB Yeti",
      })
      expect(result).toEqual({ id: "mic-new-endpoint-id", enabled: true })
    })

    it("falls back immediately to first available/default mic when previously selected mic is disconnected", () => {
      const mics = [
        { id: "mic-internal", name: "Realtek Audio", kind: "microphone" as const, isDefault: true },
      ]
      const result = reconcileMicrophone(mics, {
        ...defaultRecordingPreferences,
        microphoneEnabled: true,
        microphoneId: "mic-unplugged-usb",
        microphoneName: "Disconnected Headset",
      })
      expect(result).toEqual({ id: "mic-internal", enabled: true })
    })

    it("handles disabled microphone without selecting device ID", () => {
      const mics = [
        { id: "mic-internal", name: "Realtek Audio", kind: "microphone" as const, isDefault: true },
      ]
      const result = reconcileMicrophone(mics, {
        ...defaultRecordingPreferences,
        microphoneEnabled: false,
        microphoneId: "mic-internal",
      })
      expect(result).toEqual({ id: "", enabled: false })
    })

    it("reconciles system audio with fallback if missing", () => {
      const audios = [
        { id: "sys-default", name: "Speakers", kind: "system" as const, isDefault: true },
      ]
      const result = reconcileSystemAudio(audios, {
        ...defaultRecordingPreferences,
        systemAudioEnabled: true,
        systemAudioId: "sys-headphones-disconnected",
      })
      expect(result).toEqual({ id: "sys-default", enabled: true })
    })

    it("reconciles webcam with fallback if missing", () => {
      const webcams = [
        { id: "cam-built-in", name: "HD Web Camera", kind: "webcam" as const, isDefault: true },
      ]
      const result = reconcileWebcam(webcams, {
        ...defaultRecordingPreferences,
        webcamEnabled: true,
        webcamId: "cam-external-4k",
      })
      expect(result).toEqual({ id: "cam-built-in", enabled: true })
    })

    it("parses stored preferences from before camera mode existed", () => {
      // Old JSON has no camera keys and may carry the legacy "camera-only"
      // screen profile id — it must parse with the new defaults filled in.
      const parsed = recordingPreferencesSchema.parse({
        sourceType: "screen",
        profile: "camera-only",
        microphoneEnabled: true,
      })
      expect(parsed.sourceType).toBe("screen")
      expect(parsed.profile).toBe("camera-only")
      expect(parsed.cameraProfile).toBe("camera-balanced")
      expect(parsed.cameraPreviewMode).toBe("standard")
      expect(parsed.cameraMirrorPreview).toBe(true)
      expect(parsed.cameraFramingGuide).toBe(false)
    })

    it("round-trips camera-mode preferences", () => {
      const parsed = recordingPreferencesSchema.parse({
        ...defaultRecordingPreferences,
        sourceType: "camera",
        cameraProfile: "camera-ultra",
        cameraPreviewMode: "off",
        cameraMirrorPreview: false,
        cameraFramingGuide: true,
      })
      expect(parsed.sourceType).toBe("camera")
      expect(parsed.cameraProfile).toBe("camera-ultra")
      expect(parsed.cameraPreviewMode).toBe("off")
      expect(parsed.cameraMirrorPreview).toBe(false)
      expect(parsed.cameraFramingGuide).toBe(true)
      // The screen profile is untouched by camera tier selection.
      expect(parsed.profile).toBe("low-impact")
    })

    it("falls back to a screen source for stored camera-mode preferences", () => {
      const sources = [
        {
          kind: "display" as const,
          id: "disp-1",
          name: "Main Monitor",
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
      ]
      const result = reconcileCaptureSource(sources, {
        ...defaultRecordingPreferences,
        sourceType: "camera",
      })
      expect(result.sourceType).toBe("screen")
      expect(result.source?.kind).toBe("display")
    })

    describe("reconcileCameraDevice", () => {
      const cams = [
        { id: "cam-built-in", name: "HD Web Camera", kind: "webcam" as const, isDefault: true },
        { id: "cam-usb", name: "USB Studio Cam", kind: "webcam" as const, isDefault: false },
      ]

      it("matches the stored device id", () => {
        expect(
          reconcileCameraDevice(cams, { ...defaultRecordingPreferences, webcamId: "cam-usb" }),
        ).toEqual({ id: "cam-usb" })
      })

      it("matches the stored name when the id changed", () => {
        const rekeyed = [
          { ...cams[0], id: "cam-new-1" },
          { ...cams[1], id: "cam-new-2" },
        ]
        expect(
          reconcileCameraDevice(rekeyed, {
            ...defaultRecordingPreferences,
            webcamId: "cam-usb",
            webcamName: "USB Studio Cam",
          }),
        ).toEqual({ id: "cam-new-2" })
      })

      it("prefers the default-flagged camera over list order", () => {
        const reordered = [cams[1], cams[0]]
        expect(reconcileCameraDevice(reordered, { ...defaultRecordingPreferences })).toEqual({
          id: "cam-built-in",
        })
      })

      it("falls back to the first camera when none is default", () => {
        const noDefault = cams.map((cam) => ({ ...cam, isDefault: false }))
        expect(reconcileCameraDevice(noDefault, { ...defaultRecordingPreferences })).toEqual({
          id: "cam-built-in",
        })
      })

      it("returns an empty id when no camera exists", () => {
        expect(reconcileCameraDevice([], defaultRecordingPreferences)).toEqual({ id: "" })
      })

      it("ignores webcamEnabled=false — the camera is the source", () => {
        expect(
          reconcileCameraDevice(cams, {
            ...defaultRecordingPreferences,
            webcamEnabled: false,
            webcamId: "cam-usb",
          }),
        ).toEqual({ id: "cam-usb" })
      })
    })

    it("reconciles capture source for screen, window fallback, and custom region", () => {
      const sources = [
        {
          kind: "display" as const,
          id: "disp-1",
          name: "Main Monitor",
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        {
          kind: "window" as const,
          id: "win-1",
          name: "VS Code",
          bounds: { x: 100, y: 100, width: 1200, height: 800 },
        },
      ]

      // Screen match
      const screenResult = reconcileCaptureSource(sources, {
        ...defaultRecordingPreferences,
        sourceType: "screen",
        sourceId: "disp-1",
      })
      expect(screenResult.source?.id).toBe("disp-1")
      expect(screenResult.sourceType).toBe("screen")

      // Window match
      const windowResult = reconcileCaptureSource(sources, {
        ...defaultRecordingPreferences,
        sourceType: "window",
        sourceId: "win-1",
      })
      expect(windowResult.source?.id).toBe("win-1")
      expect(windowResult.sourceType).toBe("window")

      // Window disconnected -> falls back to available window or display
      const windowClosedResult = reconcileCaptureSource(sources, {
        ...defaultRecordingPreferences,
        sourceType: "window",
        sourceId: "win-closed-id",
        sourceName: "Closed App",
      })
      expect(windowClosedResult.source?.id).toBe("win-1")

      // Region restoration
      const regionResult = reconcileCaptureSource(sources, {
        ...defaultRecordingPreferences,
        sourceType: "region",
        regionBounds: { x: 50, y: 50, width: 800, height: 600 },
      })
      expect(regionResult.source?.kind).toBe("region")
      expect(regionResult.source?.bounds).toEqual({ x: 50, y: 50, width: 800, height: 600 })
      expect(regionResult.sourceType).toBe("region")
    })

    it("reconciles profile with fallback", () => {
      const profiles = [
        {
          id: "balanced",
          label: "Balanced",
          width: 1920,
          height: 1080,
          fps: 30,
          encoderPriority: ["libx264"],
          audioCodec: "aac",
          audioBitrateKbps: 128,
        },
      ]
      expect(
        reconcileProfile(profiles, {
          ...defaultRecordingPreferences,
          profile: "balanced",
        }),
      ).toBe("balanced")

      expect(
        reconcileProfile(profiles, {
          ...defaultRecordingPreferences,
          profile: "camera-only",
        }),
      ).toBe("balanced")
    })

    it("validates recording status payload with webcam metadata", () => {
      const status = {
        sessionId: "session-123",
        state: "recording" as const,
        startedAt: "2026-09-07T00:00:00.000Z",
        durationMs: 12000,
        recordedMs: 12000,
        sourceKind: "display",
        sourceName: "Display 1",
        webcamActive: true,
        webcamDeviceId: "Integrated Webcam",
        webcamDeviceName: "Integrated Webcam",
      }
      const parsed = recordingStatusSchema.parse(status)
      expect(parsed.webcamActive).toBe(true)
      expect(parsed.webcamDeviceId).toBe("Integrated Webcam")
      expect(parsed.webcamDeviceName).toBe("Integrated Webcam")
    })

    it("defaults webcam preview mode and GPU flag on old preferences", () => {
      const parsed = recordingPreferencesSchema.parse({
        profile: "balanced",
        microphoneEnabled: true,
        microphoneId: "mic-custom",
      })
      expect(parsed.webcamPreviewMode).toBe("low")
      expect(parsed.gpuScreenCapture).toBe(true)
      expect(defaultRecordingPreferences.webcamPreviewMode).toBe("low")
      expect(defaultRecordingPreferences.gpuScreenCapture).toBe(true)
    })

    it("parses old status payloads without capture diagnostics", () => {
      const status = {
        sessionId: "session-old",
        state: "recording" as const,
        startedAt: "2026-09-07T00:00:00.000Z",
        durationMs: 12000,
        recordedMs: 12000,
        webcamActive: false,
      }
      const parsed = recordingStatusSchema.parse(status)
      expect(parsed.screenDiagnostics).toBeUndefined()
      expect(parsed.cameraDiagnostics).toBeUndefined()
    })

    it("rejects arbitrary webcam preview modes", () => {
      expect(() => webcamPreviewModeSchema.parse("ultra")).toThrow()
      expect(() => webcamPreviewModeSchema.parse(15)).toThrow()
    })

    it("parses capture diagnostics with nullable counters", () => {
      const sample = {
        sessionId: "session-diag",
        segments: [
          {
            index: 0,
            screen: {
              processId: 1234,
              encoder: "h264_mf",
              backend: "ddagrab-cpu",
              requestedFps: 30,
              requestedCameraMode: null,
              fallbackReason: null,
              progress: {
                outputFrames: 120,
                outputFps: 29.97,
                speed: 1.0,
                duplicatedFrames: null,
                droppedFrames: null,
                outputTimeUs: 4_004_000,
              },
              progressAgeMs: 120,
              exited: false,
              startupReadyMs: 940,
              previewFps: null,
            },
            camera: {
              processId: 5678,
              encoder: "libx264",
              backend: "dshow-camera",
              requestedFps: 25,
              requestedCameraMode: {
                width: 1280,
                height: 720,
                fps: 25,
                pixelFormat: "nv12",
                codec: null,
              },
              fallbackReason: "device-default-mode+encoder-fallback",
              progress: {
                outputFrames: null,
                outputFps: null,
                speed: null,
                duplicatedFrames: null,
                droppedFrames: null,
                outputTimeUs: null,
              },
              progressAgeMs: null,
              exited: false,
              startupReadyMs: null,
              previewFps: 5,
            },
          },
        ],
      }
      const parsed = sessionCaptureDiagnosticsSchema.parse(sample)
      const camera = parsed.segments[0].camera
      expect(camera?.requestedCameraMode?.fps).toBe(25)
      // Counters may be entirely absent — they must round-trip as null, never
      // be coerced to zero.
      expect(camera?.progress.outputFrames).toBeNull()
      expect(camera?.progress.outputFps).toBeNull()
      expect(camera?.startupReadyMs).toBeNull()
      expect(parsed.segments[0].screen?.previewFps).toBeNull()
    })

    it("parses diagnostics that lack a measured camera origin", () => {
      // Payloads written before the camera clock correlation existed (and
      // non-Windows captures) simply omit the field — it must stay optional.
      const parsed = captureDiagnosticsSchema.parse({
        processId: 1234,
        encoder: "libx264",
        backend: "dshow-camera",
        requestedFps: 30,
        progress: {},
        exited: false,
      })
      expect(parsed.cameraFirstFrameOffsetMs).toBeUndefined()
    })

    it("round-trips a measured camera origin and rejects negatives", () => {
      const parsed = captureDiagnosticsSchema.parse({
        processId: 1234,
        encoder: "libx264",
        backend: "dshow-camera",
        requestedFps: 30,
        cameraFirstFrameOffsetMs: 201,
        progress: {},
        exited: false,
      })
      expect(parsed.cameraFirstFrameOffsetMs).toBe(201)

      expect(() =>
        captureDiagnosticsSchema.parse({
          processId: 1234,
          encoder: "libx264",
          backend: "dshow-camera",
          requestedFps: 30,
          cameraFirstFrameOffsetMs: -1,
          progress: {},
          exited: false,
        }),
      ).toThrow()
    })

    it("round-trips a camera timing rejection reason", () => {
      // When the measured origin is absent the rejection code explains why
      // (e.g. a virtual camera's sample clock leading the graph clock).
      const parsed = captureDiagnosticsSchema.parse({
        processId: 1234,
        encoder: "h264_nvenc",
        backend: "dshow-camera",
        requestedFps: 30,
        cameraTimingRejection: "sample-clock-skew",
        progress: {},
        exited: false,
      })
      expect(parsed.cameraTimingRejection).toBe("sample-clock-skew")
    })

    it("rejects negative and non-finite capture counters", () => {
      expect(() => captureProgressSchema.parse({ outputFrames: -1 })).toThrow()
      expect(() => captureProgressSchema.parse({ outputFps: Number.NaN })).toThrow()
      expect(() => captureProgressSchema.parse({ speed: Number.POSITIVE_INFINITY })).toThrow()
      expect(() => captureProgressSchema.parse({ outputTimeUs: -5 })).toThrow()
      expect(() =>
        captureDiagnosticsSchema.parse({
          processId: 0,
          encoder: "libx264",
          backend: "gdigrab",
          requestedFps: 30,
          progress: {},
          exited: false,
        }),
      ).toThrow()
    })
  })
})
