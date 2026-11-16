import {
  cameraColorSchema,
  cameraCutoutSchema,
  cameraLayoutPipSchema,
  lookValuesSchema,
  type LookScope,
  type LookValues,
} from "@recordforge/contracts"
import type { z } from "zod"
import type { TimelineState } from "@recordforge/contracts"
import { canvasSizeForAspectRatio } from "./composition"
import type { PresetCatalog, PresetDefinition } from "./presets/preset-registry"

export type LookValuesRecord = PresetDefinition<LookValues>

// The registry stores normalized look values; parsing fills section defaults.
export { lookValuesSchema }

export interface ApplyLookOptions {
  scope?: LookScope
  /** Apply the look's aspectRatio as a canvas resize. Off by default. */
  includeAspectRatio?: boolean
}

/**
 * Merge a look into the timeline. Camera styling generalizes to every camera
 * clip transform (position/size are untouched — only the look fields), canvas
 * and cursor values merge over the existing settings. One call = one command =
 * one undo step.
 */
export function applyLookToState(
  state: TimelineState,
  look: LookValues,
  options?: ApplyLookOptions,
): TimelineState {
  const scope = options?.scope ?? "all"
  const canvas =
    scope === "all" || scope === "canvas"
      ? {
          ...state.canvas,
          ...definedFields(look.canvas),
          ...(options?.includeAspectRatio && look.aspectRatio
            ? canvasSizeForAspectRatio(look.aspectRatio, {
                width: state.canvas.width,
                height: state.canvas.height,
              })
            : {}),
          aspectRatio:
            options?.includeAspectRatio && look.aspectRatio
              ? look.aspectRatio
              : state.canvas.aspectRatio,
        }
      : state.canvas
  const cursorSettings =
    scope === "all" || scope === "cursor"
      ? { ...state.canvas.cursorSettings, ...definedFields(look.cursor) }
      : state.canvas.cursorSettings
  const cameraScope = scope === "all" || scope === "camera"
  const { layout: lookLayout, color: lookColor, cutout: lookCutout, ...lookTransform } = look.camera
  const tracks = cameraScope
    ? state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (clip.kind !== "camera") return clip
          return {
            ...clip,
            transform: { ...clip.transform, ...definedFields(lookTransform) },
            // Colour grade and cutout are clip-level fields, partial-merged so
            // a look can set just a LUT id without flattening existing grades.
            // Re-parsing through the full schema restores required defaults.
            ...(lookColor
              ? {
                  color: cameraColorSchema.parse({
                    ...(clip.color ?? {}),
                    ...definedFields(lookColor),
                  }),
                }
              : {}),
            ...(lookCutout
              ? {
                  cutout: cameraCutoutSchema.parse({
                    ...(clip.cutout ?? {}),
                    ...definedFields(lookCutout),
                  }),
                }
              : {}),
          }
        }),
      }))
    : state.tracks
  // PiP corner/size intent lands on camera-layout segments (#5), which own
  // placement whenever the lane has enabled segments.
  const cameraLayouts =
    cameraScope && lookLayout && state.cameraLayouts
      ? state.cameraLayouts.map((segment) =>
          segment.layout === "pip" && segment.enabled
            ? {
                ...segment,
                pip: cameraLayoutPipSchema.parse({
                  ...(segment.pip ?? {}),
                  ...definedFields(lookLayout),
                }),
              }
            : segment,
        )
      : state.cameraLayouts
  return {
    ...state,
    canvas: { ...canvas, cursorSettings },
    tracks,
    // Keep the key absent when the project has no layout lane — writing
    // `cameraLayouts: undefined` would change the serialized project shape.
    ...(cameraLayouts ? { cameraLayouts } : {}),
  }
}

// Strip `undefined` so a partial look never nulls out existing settings.
function definedFields<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

const dark = "rgb(13, 16, 22)"
const accent = "rgb(190, 242, 100)"

function look(
  id: string,
  name: string,
  description: string,
  values: Omit<z.input<typeof lookValuesSchema>, "version">,
): LookValuesRecord {
  return {
    id,
    name,
    description,
    category: "look",
    tags: ["look", name.toLowerCase()],
    definition: lookValuesSchema.parse({ version: 1, ...values }),
  }
}

// Ten built-ins covering the common creator looks. All Free; only saving a
// custom look is Pro (enforced in the preset-store gate, matching titles).
export const LOOK_PRESET_CATALOG: PresetCatalog<LookValues> = {
  version: 1,
  categories: ["look"],
  presets: [
    look("look-minimal-dark", "Minimal Dark", "Tight frame, dark backdrop, soft border.", {
      canvas: {
        background: dark,
        padding: 48,
        borderRadius: 24,
        shadow: true,
        shadowColor: "rgba(0, 0, 0, 0.5)",
        shadowBlur: 48,
        borderWidth: 1,
        borderColor: "rgba(255, 255, 255, 0.12)",
      },
      cursor: { scale: 1, shadowBlur: 8 },
    }),
    look("look-studio", "Studio", "Neutral studio gradient with a camera ring.", {
      canvas: {
        background: "linear-gradient(160deg, #232a36 0%, #10141c 100%)",
        padding: 72,
        borderRadius: 28,
        shadow: true,
      },
      camera: { shape: "rounded", borderWidth: 4, borderColor: "rgba(255,255,255,0.85)" },
      cursor: { fillColor: "#f8fafc", strokeColor: "#0f172a" },
    }),
    look("look-neon", "Neon Pop", "Dark stage, bright accent border, vivid cursor.", {
      canvas: {
        background: "rgb(6, 8, 14)",
        padding: 56,
        borderRadius: 20,
        borderWidth: 3,
        borderColor: accent,
        borderOpacity: 0.9,
        shadow: true,
      },
      camera: { shape: "rounded", borderWidth: 3, borderColor: accent },
      cursor: { fillColor: accent, strokeColor: "#111827", clickColor: accent },
    }),
    look("look-paper", "Paper Light", "Off-white canvas for docs and product tours.", {
      canvas: {
        background: "rgb(246, 244, 238)",
        padding: 64,
        borderRadius: 16,
        shadow: true,
        shadowColor: "rgba(30, 27, 20, 0.25)",
        borderWidth: 1,
        borderColor: "rgba(30, 27, 20, 0.15)",
      },
      camera: { shape: "rectangle", borderWidth: 1, borderColor: "rgba(30,27,20,0.4)" },
      cursor: { fillColor: "#1c1917", strokeColor: "#fafaf9", clickColor: "#f59e0b" },
    }),
    look("look-focus", "Focus", "Dimmed backdrop behind the capture — attention stays inside.", {
      canvas: { background: dark, padding: 0, borderRadius: 0, backgroundDim: 0.55 },
      cursor: { spotlightMode: true, spotlightRadius: 160, spotlightDimOpacity: 0.5 },
    }),
    look("look-streamer", "Streamer", "PiP bubble camera, roomy padding, punchy clicks.", {
      canvas: {
        background: "linear-gradient(150deg, #17122b 0%, #0b0a16 100%)",
        padding: 40,
        borderRadius: 24,
        shadow: true,
      },
      camera: { shape: "circle", borderWidth: 5, borderColor: "rgb(167, 139, 250)" },
      cursor: { clickSize: 56, clickColor: "#a78bfa" },
    }),
    look("look-editorial", "Editorial", "Warm serif-adjacent neutrals for tutorials.", {
      canvas: {
        background: "rgb(28, 25, 23)",
        padding: 88,
        borderRadius: 12,
        shadow: true,
        borderWidth: 1,
        borderColor: "rgba(215, 156, 99, 0.5)",
      },
      camera: { shape: "rectangle", borderWidth: 2, borderColor: "rgb(215, 156, 99)" },
      cursor: { fillColor: "#e7e5e4", clickColor: "#d79c63" },
    }),
    look("look-terminal", "Terminal", "Hacker-green accents on near-black.", {
      canvas: {
        background: "rgb(4, 10, 6)",
        padding: 48,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: "rgb(52, 211, 153)",
        shadow: true,
      },
      camera: { shape: "rounded", borderWidth: 2, borderColor: "rgb(52, 211, 153)" },
      cursor: { fillColor: "#34d399", strokeColor: "#022c22", clickColor: "#6ee7b7" },
    }),
    look("look-clean-vertical", "Clean Vertical", "Airy framed capture tuned for 9:16 cuts.", {
      canvas: {
        background: "rgb(15, 17, 23)",
        padding: 32,
        borderRadius: 32,
        shadow: true,
        backgroundBlur: 32,
        backgroundDim: 0.35,
      },
      aspectRatio: "9:16",
      camera: { shape: "rounded", borderWidth: 3, borderColor: "rgba(255,255,255,0.8)" },
    }),
    look("look-slide", "Slide Deck", "Bordered capture over a calm presentation field.", {
      canvas: {
        background: "linear-gradient(140deg, #1e293b 0%, #0f172a 100%)",
        padding: 120,
        borderRadius: 8,
        shadow: true,
      },
      cursor: { scale: 1.2, clickFeedback: "ripple" },
    }),
  ],
}
