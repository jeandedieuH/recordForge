#!/usr/bin/env node

/**
 * Synthetic Media Fixture Generator for recordForge.
 *
 * Usage:
 *   bun run tooling/fixtures/generate.ts
 *   bun run tooling/fixtures/generate.ts --include-long
 *   bun run tooling/fixtures/generate.ts --output-dir <dir>
 *
 * Prerequisites:
 *   - FFmpeg and FFprobe must be available in PATH.
 *   - FFMPEG_PATH and FFPROBE_PATH may override executable discovery.
 */

import { execFileSync } from "child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs"
import { join, resolve } from "path"

const FIXTURE_RECIPE_VERSION = 2
const FIXTURE_DURATION_TOLERANCE_MS = 100
const AUDIO_DURATION_SECONDS = 10
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const EDITOR_METADATA_FILES = [
  "project.json",
  "project-long.json",
  "project-no-cursor.json",
  "cursor-telemetry.json",
  "captions.srt",
] as const

type FixtureAssetRole = "screen" | "webcam" | "microphone" | "system_audio"
type FixtureExtension = "mp4" | "wav"

interface FixtureMetadata {
  name: string
  description: string
  outputExtension?: FixtureExtension
  assetRole?: FixtureAssetRole
  expectedDurationMs: number
  expectedWidth?: number
  expectedHeight?: number
  expectedFps?: number
  expectedSampleRate?: number
  expectedChannels?: number
  hasAudio: boolean
}

interface FixtureSpec extends FixtureMetadata {
  ffmpegArgs: string[]
}

interface GeneratedFixture extends FixtureMetadata {
  path: string
  sizeBytes: number
  verified: true
}

interface FixtureManifest {
  recipeVersion: number
  includeLong: boolean
  metadataFiles: readonly string[]
  fixtures: GeneratedFixture[]
}

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  sample_rate?: string
  channels?: number
}

interface ProbeResult {
  format?: { duration?: string }
  streams?: ProbeStream[]
}

class FixtureValidationError extends Error {}

interface VideoFixtureOptions {
  name: string
  description: string
  width: number
  height: number
  durationSeconds: number
  assetRole: "screen" | "webcam"
  audioFrequency?: number
  audioSampleRate?: number
  audioBitrate?: string
}

function videoArguments(options: VideoFixtureOptions): string[] {
  const args = [
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${options.width}x${options.height}:rate=30:duration=${options.durationSeconds}`,
  ]

  if (options.audioFrequency !== undefined) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${options.audioFrequency}:sample_rate=${options.audioSampleRate ?? 44100}:duration=${options.durationSeconds}`,
    )
  }

  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p")

  if (options.audioFrequency !== undefined) {
    args.push("-c:a", "aac", "-b:a", options.audioBitrate ?? "128k")
  } else {
    args.push("-an")
  }

  return args
}

function audioArguments(frequency: number, durationSeconds: number): string[] {
  return [
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${durationSeconds}`,
    "-c:a",
    "pcm_s16le",
    "-ar",
    `${AUDIO_SAMPLE_RATE}`,
    "-ac",
    `${AUDIO_CHANNELS}`,
  ]
}

function createVideoFixture(options: VideoFixtureOptions): FixtureSpec {
  return {
    name: options.name,
    description: options.description,
    assetRole: options.assetRole,
    ffmpegArgs: videoArguments(options),
    expectedDurationMs: options.durationSeconds * 1000,
    expectedWidth: options.width,
    expectedHeight: options.height,
    expectedFps: 30,
    hasAudio: options.audioFrequency !== undefined,
  }
}

function createAudioFixture(
  name: string,
  description: string,
  frequency: number,
  assetRole: "microphone" | "system_audio",
): FixtureSpec {
  return {
    name,
    description,
    outputExtension: "wav",
    assetRole,
    ffmpegArgs: audioArguments(frequency, AUDIO_DURATION_SECONDS),
    expectedDurationMs: AUDIO_DURATION_SECONDS * 1000,
    expectedSampleRate: AUDIO_SAMPLE_RATE,
    expectedChannels: AUDIO_CHANNELS,
    hasAudio: true,
  }
}

const FIXTURE_SPECS: FixtureSpec[] = [
  createVideoFixture({
    name: "1080p30_10s",
    description: "10-second 1080p 30fps test video with 440Hz sine audio",
    width: 1920,
    height: 1080,
    durationSeconds: 10,
    assetRole: "screen",
    audioFrequency: 440,
  }),
  createVideoFixture({
    name: "720p30_30s",
    description: "30-second 720p 30fps test video with audio for proxy/waveform tests",
    width: 1280,
    height: 720,
    durationSeconds: 30,
    assetRole: "screen",
    audioFrequency: 880,
  }),
  createVideoFixture({
    name: "1080p30_video_only_5s",
    description: "5-second 1080p 30fps video without audio for edge-case tests",
    width: 1920,
    height: 1080,
    durationSeconds: 5,
    assetRole: "screen",
  }),
  createVideoFixture({
    name: "4_3_aspect_10s",
    description: "10-second 4:3 aspect ratio video for non-standard aspect tests (P0.5)",
    width: 1024,
    height: 768,
    durationSeconds: 10,
    assetRole: "screen",
    audioFrequency: 440,
  }),
  createVideoFixture({
    name: "ultrawide_10s",
    description: "10-second 21:9 ultrawide video for non-standard aspect tests",
    width: 2560,
    height: 1080,
    durationSeconds: 10,
    assetRole: "screen",
    audioFrequency: 440,
  }),
  createVideoFixture({
    name: "camera_10s",
    description: "10-second 640x360 webcam source without audio",
    width: 640,
    height: 360,
    durationSeconds: 10,
    assetRole: "webcam",
  }),
  createAudioFixture(
    "microphone_10s",
    "10-second 48kHz stereo microphone fixture at 220Hz",
    220,
    "microphone",
  ),
  createAudioFixture(
    "system_audio_10s",
    "10-second 48kHz stereo system-audio fixture at 880Hz",
    880,
    "system_audio",
  ),
  createVideoFixture({
    name: "segment_a_5s",
    description: "First 5-second segment for concatenation / recovery tests",
    width: 1920,
    height: 1080,
    durationSeconds: 5,
    assetRole: "screen",
    audioFrequency: 440,
  }),
  createVideoFixture({
    name: "segment_b_5s",
    description: "Second 5-second segment for concatenation / recovery tests",
    width: 1920,
    height: 1080,
    durationSeconds: 5,
    assetRole: "screen",
    audioFrequency: 880,
  }),
  {
    ...createVideoFixture({
      name: "tiny_1s",
      description: "1-second tiny file for fast unit tests",
      width: 320,
      height: 240,
      durationSeconds: 1,
      assetRole: "screen",
      audioFrequency: 440,
      audioBitrate: "64k",
    }),
  },
]

const LONG_FIXTURE_SPECS: FixtureSpec[] = [
  createVideoFixture({
    name: "720p30_5m",
    description: "Five-minute 720p30 editor performance fixture",
    width: 1280,
    height: 720,
    durationSeconds: 300,
    assetRole: "screen",
    audioFrequency: 440,
  }),
]

function findExecutable(name: string, environmentName: string, candidates: string[]): string {
  const environmentPath = process.env[environmentName]
  const candidatesToTry = environmentPath ? [environmentPath, ...candidates] : candidates

  for (const candidate of candidatesToTry) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" })
      return candidate
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    `${name} not found. Install ${name} and ensure it is in PATH, or set ${environmentName}.`,
  )
}

function findFfmpeg(): string {
  return findExecutable("FFmpeg", "FFMPEG_PATH", [
    "ffmpeg",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  ])
}

function findFfprobe(): string {
  return findExecutable("FFprobe", "FFPROBE_PATH", [
    "ffprobe",
    "C:\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe",
  ])
}

function outputFilename(spec: FixtureSpec): string {
  return `${spec.name}.${spec.outputExtension ?? "mp4"}`
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) return "unknown command error"

  const stderr = (error as { stderr?: Buffer | string }).stderr
  return typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "unknown command error")
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [numerator, denominator] = value.split("/").map(Number)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined
  }
  return numerator / denominator
}

function probeFixture(ffprobe: string, filePath: string): ProbeResult {
  const output = execFileSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,r_frame_rate,sample_rate,channels",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", stdio: "pipe" },
  )
  return JSON.parse(output)
}

function validateFixture(spec: FixtureSpec, probe: ProbeResult): void {
  const durationMs = Number(probe.format?.duration) * 1000
  if (
    !Number.isFinite(durationMs) ||
    Math.abs(durationMs - spec.expectedDurationMs) > FIXTURE_DURATION_TOLERANCE_MS
  ) {
    throw new FixtureValidationError(
      `${spec.name} duration mismatch: expected ${spec.expectedDurationMs}ms, got ${durationMs}ms`,
    )
  }

  const streams = probe.streams ?? []
  const video = streams.find((stream) => stream.codec_type === "video")
  const audio = streams.find((stream) => stream.codec_type === "audio")

  if (spec.hasAudio !== Boolean(audio)) {
    throw new FixtureValidationError(
      `${spec.name} audio mismatch: expected hasAudio=${spec.hasAudio}`,
    )
  }

  if (spec.expectedWidth !== undefined && video?.width !== spec.expectedWidth) {
    throw new FixtureValidationError(
      `${spec.name} width mismatch: expected ${spec.expectedWidth}, got ${video?.width}`,
    )
  }

  if (spec.expectedHeight !== undefined && video?.height !== spec.expectedHeight) {
    throw new FixtureValidationError(
      `${spec.name} height mismatch: expected ${spec.expectedHeight}, got ${video?.height}`,
    )
  }

  if (spec.expectedFps !== undefined) {
    const fps = parseFrameRate(video?.r_frame_rate)
    if (fps === undefined || Math.abs(fps - spec.expectedFps) > 0.01) {
      throw new FixtureValidationError(
        `${spec.name} FPS mismatch: expected ${spec.expectedFps}, got ${fps}`,
      )
    }
  }

  if (spec.expectedSampleRate !== undefined) {
    const sampleRate = Number(audio?.sample_rate)
    if (sampleRate !== spec.expectedSampleRate) {
      throw new FixtureValidationError(
        `${spec.name} sample-rate mismatch: expected ${spec.expectedSampleRate}, got ${sampleRate}`,
      )
    }
  }

  if (spec.expectedChannels !== undefined && audio?.channels !== spec.expectedChannels) {
    throw new FixtureValidationError(
      `${spec.name} channel mismatch: expected ${spec.expectedChannels}, got ${audio?.channels}`,
    )
  }
}

function readExistingManifest(outputDir: string): FixtureManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8")) as FixtureManifest
  } catch {
    return undefined
  }
}

function canReuseExistingFixtures(outputDir: string): boolean {
  const manifest = readExistingManifest(outputDir)
  return manifest?.recipeVersion === FIXTURE_RECIPE_VERSION
}

function toGeneratedFixture(
  spec: FixtureSpec,
  filename: string,
  sizeBytes: number,
): GeneratedFixture {
  const { ffmpegArgs: ignoredArgs, ...metadata } = spec
  void ignoredArgs
  return {
    ...metadata,
    path: filename,
    sizeBytes,
    verified: true,
  }
}

function generateFixture(
  ffmpeg: string,
  ffprobe: string,
  spec: FixtureSpec,
  outputDir: string,
  reuseExisting: boolean,
): GeneratedFixture {
  const filename = outputFilename(spec)
  const outputPath = join(outputDir, filename)

  if (reuseExisting && existsSync(outputPath)) {
    try {
      validateFixture(spec, probeFixture(ffprobe, outputPath))
      const sizeBytes = statSync(outputPath).size
      console.log(
        `  ${spec.name} - verified existing fixture (${(sizeBytes / 1024).toFixed(1)} KB)`,
      )
      return toGeneratedFixture(spec, filename, sizeBytes)
    } catch (error) {
      if (!(error instanceof FixtureValidationError)) throw error
      rmSync(outputPath, { force: true })
    }
  }

  console.log(`  ${spec.name} - generating: ${spec.description}`)
  rmSync(outputPath, { force: true })

  try {
    execFileSync(ffmpeg, [...spec.ffmpegArgs, "-y", outputPath], {
      encoding: "utf8",
      stdio: "pipe",
    })
  } catch (error) {
    rmSync(outputPath, { force: true })
    throw new Error(`${spec.name} generation failed: ${commandErrorMessage(error)}`)
  }

  const sizeBytes = statSync(outputPath).size
  if (sizeBytes <= 0) throw new Error(`${spec.name} generation produced an empty file`)

  try {
    validateFixture(spec, probeFixture(ffprobe, outputPath))
  } catch (error) {
    rmSync(outputPath, { force: true })
    throw error
  }

  console.log(`  ${spec.name} - verified (${(sizeBytes / 1024).toFixed(1)} KB)`)
  return toGeneratedFixture(spec, filename, sizeBytes)
}

function copyEditorMetadata(outputDir: string, includeLong: boolean): readonly string[] {
  const sourceDir = join(__dirname, "editor-fixtures")
  const metadataFiles = includeLong
    ? EDITOR_METADATA_FILES
    : EDITOR_METADATA_FILES.filter((filename) => filename !== "project-long.json")
  if (!includeLong) rmSync(join(outputDir, "project-long.json"), { force: true })
  for (const filename of metadataFiles) {
    copyFileSync(join(sourceDir, filename), join(outputDir, filename))
  }
  return metadataFiles
}

function removeKnownOutputs(outputDir: string): void {
  for (const spec of [...FIXTURE_SPECS, ...LONG_FIXTURE_SPECS]) {
    rmSync(join(outputDir, outputFilename(spec)), { force: true })
  }
  for (const filename of EDITOR_METADATA_FILES) {
    rmSync(join(outputDir, filename), { force: true })
  }
  rmSync(join(outputDir, "manifest.json"), { force: true })
}

function writeManifest(
  fixtures: GeneratedFixture[],
  outputDir: string,
  includeLong: boolean,
  metadataFiles: readonly string[],
): void {
  const manifest: FixtureManifest = {
    recipeVersion: FIXTURE_RECIPE_VERSION,
    includeLong,
    metadataFiles,
    fixtures,
  }
  const manifestPath = join(outputDir, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`Manifest written to ${manifestPath}`)
}

function main(): void {
  const args = process.argv.slice(2)
  const outputDirIndex = args.indexOf("--output-dir")
  const outputDirArgument = outputDirIndex >= 0 ? args[outputDirIndex + 1] : undefined
  if (outputDirIndex >= 0 && !outputDirArgument) {
    throw new Error("--output-dir requires a directory")
  }

  const outputDir = resolve(outputDirArgument ?? join(__dirname, "output"))
  const includeLong = args.includes("--include-long")
  const force = args.includes("--force")
  const specs = includeLong ? [...FIXTURE_SPECS, ...LONG_FIXTURE_SPECS] : FIXTURE_SPECS

  const ffmpeg = findFfmpeg()
  const ffprobe = findFfprobe()

  mkdirSync(outputDir, { recursive: true })
  if (force) removeKnownOutputs(outputDir)
  if (!includeLong) {
    rmSync(join(outputDir, outputFilename(LONG_FIXTURE_SPECS[0])), { force: true })
  }

  const reuseExisting = !force && canReuseExistingFixtures(outputDir)
  console.log(`Output directory: ${outputDir}`)
  console.log(`FFmpeg: ${ffmpeg}`)
  console.log(`FFprobe: ${ffprobe}`)
  console.log(
    `Fixture recipe: ${FIXTURE_RECIPE_VERSION}${includeLong ? " (including long fixture)" : ""}`,
  )

  const generated = specs.map((spec) =>
    generateFixture(ffmpeg, ffprobe, spec, outputDir, reuseExisting),
  )
  const metadataFiles = copyEditorMetadata(outputDir, includeLong)
  writeManifest(generated, outputDir, includeLong, metadataFiles)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
