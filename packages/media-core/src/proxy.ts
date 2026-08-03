import type { FFmpegJobSpec } from "@recordforge/contracts"

export interface ProxyOptions {
  inputPath: string
  outputPath: string
  height?: number
}

export interface WaveformOptions {
  inputPath: string
  outputPath: string
  samplesPerSecond?: number
}

/// Construct FFmpeg job specification for low-res 360p video proxy creation.
export function buildProxyJob(options: ProxyOptions): FFmpegJobSpec {
  const height = options.height ?? 360
  return {
    kind: "export",
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    args: [
      "-i",
      options.inputPath,
      "-vf",
      `scale=-2:${height}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-y",
      options.outputPath,
    ],
  }
}

/// Construct FFmpeg job specification for waveform JSON data extraction.
export function buildWaveformJob(options: WaveformOptions): FFmpegJobSpec {
  return {
    kind: "waveform",
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    args: [
      "-i",
      options.inputPath,
      "-ac",
      "1",
      "-filter:a",
      `aresample=8000,asetnsamples=n=80`,
      "-f",
      "s16le",
      "-y",
      options.outputPath,
    ],
  }
}
