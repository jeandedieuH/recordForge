import type { AppError, CaptionCue, CaptionFormat } from "@recordforge/contracts"
import { captionCueSchema, captionFormatSchema } from "@recordforge/contracts"

export interface CaptionParseResult {
  format: CaptionFormat
  cues: CaptionCue[]
}

export type CaptionParseResponse =
  { ok: true; value: CaptionParseResult } | { ok: false; error: AppError }

interface ParsedCue {
  id?: string
  startMs: number
  endMs: number
  text: string
}

function captionError(message: string, details?: Record<string, unknown>): CaptionParseResponse {
  return {
    ok: false,
    error: {
      category: "editor",
      code: "invalid_caption_file",
      message,
      ...(details ? { details } : {}),
    },
  }
}

function parseTimestamp(value: string): number | null {
  const normalized = value.trim().replace(",", ".")
  const parts = normalized.split(":")
  if (parts.length < 2 || parts.length > 3) return null

  const secondsPart = Number(parts[parts.length - 1])
  const minutesPart = Number(parts[parts.length - 2])
  const hoursPart = parts.length === 3 ? Number(parts[0]) : 0
  if (![hoursPart, minutesPart, secondsPart].every(Number.isFinite)) return null
  if (
    hoursPart < 0 ||
    minutesPart < 0 ||
    minutesPart >= 60 ||
    secondsPart < 0 ||
    secondsPart >= 60
  ) {
    return null
  }

  return Math.round((hoursPart * 3_600 + minutesPart * 60 + secondsPart) * 1_000)
}

function parseTimingLine(line: string): { startMs: number; endMs: number } | null {
  const [start, end] = line.split("-->", 2)
  if (!start || !end) return null
  const endToken = end.trim().split(/\s+/, 1)[0]
  if (!endToken) return null
  const startMs = parseTimestamp(start)
  const endMs = parseTimestamp(endToken)
  if (startMs === null || endMs === null) return null
  return { startMs, endMs }
}

function normalizeText(lines: string[]): string {
  return lines.join("\n").trim()
}

function parseBlock(block: string, format: CaptionFormat): ParsedCue | AppError | null {
  const lines = block.split("\n").map((line) => line.trimEnd())
  while (lines[0]?.trim() === "") lines.shift()
  if (lines.length === 0) return null
  if (format === "vtt" && /^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0].trim())) return null

  const timingIndex = lines.findIndex((line) => line.includes("-->"))
  if (timingIndex < 0) {
    return {
      category: "editor",
      code: "invalid_caption_file",
      message: "Caption cue is missing timing",
    }
  }

  const timing = parseTimingLine(lines[timingIndex])
  if (!timing) {
    return {
      category: "editor",
      code: "invalid_caption_file",
      message: "Caption cue has invalid timing",
    }
  }
  if (timing.endMs <= timing.startMs) {
    return {
      category: "editor",
      code: "invalid_caption_file",
      message: "Caption cue timing must end after it starts",
    }
  }

  const possibleId = lines.slice(0, timingIndex).join(" ").trim()
  const cueId = format === "srt" && /^\d+$/.test(possibleId) ? undefined : possibleId || undefined
  const text = normalizeText(lines.slice(timingIndex + 1))
  if (!text) {
    return {
      category: "editor",
      code: "invalid_caption_file",
      message: "Caption cue text cannot be empty",
    }
  }

  return {
    ...(cueId ? { id: cueId } : {}),
    ...timing,
    text,
  }
}

function parseBlocks(text: string, format: CaptionFormat): ParsedCue[] | AppError {
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
  if (!normalized) {
    return {
      category: "editor",
      code: "invalid_caption_file",
      message: "Caption file is empty",
    }
  }

  const blocks = normalized.split(/\n\s*\n/)
  const cues: ParsedCue[] = []
  for (const [index, block] of blocks.entries()) {
    if (format === "vtt" && index === 0 && /^WEBVTT(?:\s|$)/i.test(block.trim())) {
      const headerLines = block.split("\n")
      const remainder = headerLines.slice(1).join("\n").trim()
      if (!remainder) continue
      const parsedHeaderBlock = parseBlock(remainder, format)
      if (parsedHeaderBlock && "category" in parsedHeaderBlock) return parsedHeaderBlock
      if (parsedHeaderBlock) cues.push(parsedHeaderBlock)
      continue
    }

    const parsed = parseBlock(block, format)
    if (!parsed) continue
    if ("category" in parsed) return parsed
    cues.push(parsed)
  }
  return cues
}

export function parseCaptionText(text: string, format: CaptionFormat): CaptionParseResponse {
  if (text.length > 2_000_000) return captionError("Caption file is too large")
  const parsedFormat = captionFormatSchema.safeParse(format)
  if (!parsedFormat.success) return captionError("Caption format is unsupported")

  const parsed = parseBlocks(text, parsedFormat.data)
  if ("category" in parsed) return { ok: false, error: parsed }
  if (parsed.length === 0) return captionError("Caption file contains no cues")

  let cues: CaptionCue[]
  try {
    cues = parsed
      .map((cue, index) => captionCueSchema.parse({ ...cue, id: cue.id || `cue-${index + 1}` }))
      .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  } catch {
    return captionError("Caption cue text or timing is invalid")
  }

  for (let index = 1; index < cues.length; index++) {
    const previous = cues[index - 1]
    const current = cues[index]
    if (current.startMs < previous.endMs) {
      return captionError("Caption cues overlap and cannot share one captions track")
    }
  }

  return { ok: true, value: { format: parsedFormat.data, cues } }
}

export function captionFormatFromFileName(fileName: string): CaptionFormat | null {
  const extension = fileName.toLowerCase().split(".").pop()
  return extension === "srt" || extension === "vtt" ? extension : null
}
