/**
 * RecordForge Background Presets & Studio Layout Utilities
 *
 * Provides curated solid colors, modern gradients, and image backgrounds
 * (sourced from assets/backgrounds) for the editor canvas.
 */

export type BackgroundKind = "solid" | "gradient" | "image"

export type SolidColorCategory = "studio" | "dark" | "vibrant" | "light"

export interface SolidColorPreset {
  id: string
  name: string
  color: string
  category: SolidColorCategory
}

export type GradientCategory = "vibrant" | "dark" | "mesh" | "pastel"

export interface GradientPreset {
  id: string
  name: string
  gradient: string
  category: GradientCategory
  dominantColor: string
}

export interface ImageBackgroundPreset {
  id: string
  src: string
  dominantColor: string
}

// ---------------------------------------------------------------------------
// Solid Color Presets
// ---------------------------------------------------------------------------

export const SOLID_COLOR_PRESETS: SolidColorPreset[] = [
  // Studio & Neutral
  { id: "studio-void", name: "Studio Void", color: "#070b14", category: "studio" },
  { id: "studio-slate", name: "Slate Dark", color: "#0f172a", category: "studio" },
  { id: "studio-charcoal", name: "Charcoal", color: "#18181b", category: "studio" },
  { id: "studio-neutral", name: "Neutral Gray", color: "#27272a", category: "studio" },
  { id: "studio-pure-black", name: "True Black", color: "#000000", category: "studio" },

  // Sleek Dark
  { id: "dark-midnight", name: "Midnight Blue", color: "#020617", category: "dark" },
  { id: "dark-indigo", name: "Deep Indigo", color: "#1e1b4b", category: "dark" },
  { id: "dark-emerald", name: "Forest Dark", color: "#022c22", category: "dark" },
  { id: "dark-crimson", name: "Dark Crimson", color: "#450a0a", category: "dark" },
  { id: "dark-plum", name: "Dark Plum", color: "#2e1065", category: "dark" },
  { id: "dark-teal", name: "Abyss Teal", color: "#042f2e", category: "dark" },

  // Vibrant Accents
  { id: "vibrant-sapphire", name: "Sapphire Blue", color: "#2563eb", category: "vibrant" },
  { id: "vibrant-indigo", name: "Electric Indigo", color: "#4f46e5", category: "vibrant" },
  { id: "vibrant-violet", name: "Neon Violet", color: "#7c3aed", category: "vibrant" },
  { id: "vibrant-fuchsia", name: "Cyber Fuchsia", color: "#c026d3", category: "vibrant" },
  { id: "vibrant-rose", name: "Vivid Rose", color: "#e11d48", category: "vibrant" },
  { id: "vibrant-amber", name: "Warm Amber", color: "#d97706", category: "vibrant" },
  { id: "vibrant-emerald", name: "Vivid Emerald", color: "#059669", category: "vibrant" },
  { id: "vibrant-cyan", name: "High Cyan", color: "#0891b2", category: "vibrant" },

  // Light & Clean
  { id: "light-pure-white", name: "Pure White", color: "#ffffff", category: "light" },
  { id: "light-snow", name: "Snow Mist", color: "#f8fafc", category: "light" },
  { id: "light-zinc", name: "Soft Zinc", color: "#e4e4e7", category: "light" },
  { id: "light-slate", name: "Slate White", color: "#f1f5f9", category: "light" },
]

// ---------------------------------------------------------------------------
// Gradient Presets
// ---------------------------------------------------------------------------

export const GRADIENT_PRESETS: GradientPreset[] = [
  // Vibrant & Dynamic
  {
    id: "sunset-blaze",
    name: "Sunset Blaze",
    gradient: "linear-gradient(135deg, #ff6b6b 0%, #f06595 50%, #cc5de8 100%)",
    category: "vibrant",
    dominantColor: "#f06595",
  },
  {
    id: "cosmic-purple",
    name: "Cosmic Nebula",
    gradient: "linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)",
    category: "vibrant",
    dominantColor: "#a855f7",
  },
  {
    id: "cyberpunk-blue",
    name: "Cyber Neon",
    gradient: "linear-gradient(135deg, #06b6d4 0%, #3b82f6 50%, #8b5cf6 100%)",
    category: "vibrant",
    dominantColor: "#3b82f6",
  },
  {
    id: "hyper-orange",
    name: "Solar Energy",
    gradient: "linear-gradient(135deg, #f97316 0%, #fb923c 50%, #fde047 100%)",
    category: "vibrant",
    dominantColor: "#f97316",
  },
  {
    id: "emerald-surge",
    name: "Northern Lights",
    gradient: "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)",
    category: "vibrant",
    dominantColor: "#10b981",
  },
  {
    id: "crimson-ray",
    name: "Crimson Ray",
    gradient: "linear-gradient(135deg, #e11d48 0%, #f43f5e 50%, #fb7185 100%)",
    category: "vibrant",
    dominantColor: "#e11d48",
  },
  {
    id: "electric-violet",
    name: "Electric Violet",
    gradient: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #db2777 100%)",
    category: "vibrant",
    dominantColor: "#7c3aed",
  },
  {
    id: "acid-lime",
    name: "Acid Lime",
    gradient: "linear-gradient(135deg, #15803d 0%, #84cc16 50%, #bef264 100%)",
    category: "vibrant",
    dominantColor: "#84cc16",
  },

  // Dark & Sleek
  {
    id: "midnight-nebula",
    name: "Midnight Nebula",
    gradient: "linear-gradient(135deg, #090d16 0%, #1e1b4b 50%, #0f172a 100%)",
    category: "dark",
    dominantColor: "#1e1b4b",
  },
  {
    id: "obsidian-noir",
    name: "Obsidian Noir",
    gradient: "linear-gradient(135deg, #0a0a0c 0%, #18181b 50%, #27272a 100%)",
    category: "dark",
    dominantColor: "#18181b",
  },
  {
    id: "cyber-slate",
    name: "Cyber Slate",
    gradient: "linear-gradient(135deg, #020617 0%, #0f172a 50%, #1e293b 100%)",
    category: "dark",
    dominantColor: "#0f172a",
  },
  {
    id: "deep-ocean",
    name: "Deep Ocean",
    gradient: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 50%, #0284c7 100%)",
    category: "dark",
    dominantColor: "#1e3a8a",
  },
  {
    id: "dark-plum-gradient",
    name: "Velvet Plum",
    gradient: "linear-gradient(135deg, #1e1b4b 0%, #3b0764 50%, #0f172a 100%)",
    category: "dark",
    dominantColor: "#3b0764",
  },
  {
    id: "dark-ember",
    name: "Dark Ember",
    gradient: "linear-gradient(135deg, #450a0a 0%, #7c2d12 50%, #09090b 100%)",
    category: "dark",
    dominantColor: "#7c2d12",
  },
  {
    id: "mystic-emerald",
    name: "Mystic Forest",
    gradient: "linear-gradient(135deg, #064e3b 0%, #047857 50%, #10b981 100%)",
    category: "dark",
    dominantColor: "#047857",
  },

  // Mesh & Glowing Auras
  {
    id: "dreamy-lavender",
    name: "Dreamy Lavender",
    gradient:
      "radial-gradient(at 0% 0%, #7c3aed 0px, transparent 55%), radial-gradient(at 100% 100%, #ec4899 0px, transparent 55%), #1e1b4b",
    category: "mesh",
    dominantColor: "#7c3aed",
  },
  {
    id: "bioluminescence",
    name: "Bioluminescence",
    gradient:
      "radial-gradient(at 0% 100%, #06b6d4 0px, transparent 55%), radial-gradient(at 100% 0%, #10b981 0px, transparent 55%), #022c22",
    category: "mesh",
    dominantColor: "#06b6d4",
  },
  {
    id: "solar-wind",
    name: "Solar Wind",
    gradient:
      "radial-gradient(at 0% 0%, #f97316 0px, transparent 55%), radial-gradient(at 100% 100%, #e11d48 0px, transparent 55%), #1c1917",
    category: "mesh",
    dominantColor: "#f97316",
  },
  {
    id: "neon-core",
    name: "Neon Glow",
    gradient:
      "radial-gradient(at 50% 0%, #a855f7 0px, transparent 65%), radial-gradient(at 50% 100%, #3b82f6 0px, transparent 65%), #030712",
    category: "mesh",
    dominantColor: "#a855f7",
  },
  {
    id: "hyper-mesh",
    name: "Hyper Prism",
    gradient:
      "radial-gradient(at 0% 50%, #ec4899 0px, transparent 50%), radial-gradient(at 100% 50%, #3b82f6 0px, transparent 50%), radial-gradient(at 50% 0%, #8b5cf6 0px, transparent 50%), #090d16",
    category: "mesh",
    dominantColor: "#8b5cf6",
  },

  // Pastel & Soft
  {
    id: "cotton-candy",
    name: "Cotton Candy",
    gradient: "linear-gradient(135deg, #fbcfe8 0%, #fed7aa 50%, #e9d5ff 100%)",
    category: "pastel",
    dominantColor: "#fbcfe8",
  },
  {
    id: "mint-frost",
    name: "Mint Frost",
    gradient: "linear-gradient(135deg, #a7f3d0 0%, #bae6fd 50%, #e0e7ff 100%)",
    category: "pastel",
    dominantColor: "#a7f3d0",
  },
  {
    id: "peach-sorbet",
    name: "Peach Sorbet",
    gradient: "linear-gradient(135deg, #fed7aa 0%, #fecdd3 50%, #f5d0fe 100%)",
    category: "pastel",
    dominantColor: "#fed7aa",
  },
  {
    id: "soft-sky",
    name: "Soft Sky",
    gradient: "linear-gradient(135deg, #bae6fd 0%, #c7d2fe 50%, #ddd6fe 100%)",
    category: "pastel",
    dominantColor: "#bae6fd",
  },
]

// ---------------------------------------------------------------------------
// Curated Image Background Presets (All 24 from assets/backgrounds)
// ---------------------------------------------------------------------------

export const IMAGE_BACKGROUND_PRESETS: ImageBackgroundPreset[] = [
  { id: "bg-1", src: "/backgrounds/bg-1.jpg", dominantColor: "#1e1b4b" },
  { id: "bg-2", src: "/backgrounds/bg-2.jpg", dominantColor: "#ea580c" },
  { id: "bg-3", src: "/backgrounds/bg-3.jpg", dominantColor: "#4f46e5" },
  { id: "bg-4", src: "/backgrounds/bg-4.jpg", dominantColor: "#ec4899" },
  { id: "bg-5", src: "/backgrounds/bg-5.jpg", dominantColor: "#09090b" },
  { id: "bg-6", src: "/backgrounds/bg-6.jpg", dominantColor: "#059669" },
  { id: "bg-7", src: "/backgrounds/bg-7.jpg", dominantColor: "#312e81" },
  { id: "bg-8", src: "/backgrounds/bg-8.jpg", dominantColor: "#78350f" },
  { id: "bg-9", src: "/backgrounds/bg-9.jpg", dominantColor: "#0f172a" },
  { id: "bg-10", src: "/backgrounds/bg-10.jpg", dominantColor: "#1e293b" },
  { id: "bg-11", src: "/backgrounds/bg-11.jpg", dominantColor: "#6366f1" },
  { id: "bg-12", src: "/backgrounds/bg-12.jpg", dominantColor: "#f43f5e" },
  { id: "bg-13", src: "/backgrounds/bg-13.jpg", dominantColor: "#0284c7" },
  { id: "bg-14", src: "/backgrounds/bg-14.jpg", dominantColor: "#065f46" },
  { id: "bg-15", src: "/backgrounds/bg-15.jpg", dominantColor: "#27272a" },
  { id: "bg-16", src: "/backgrounds/bg-16.jpg", dominantColor: "#d97706" },
  { id: "bg-17", src: "/backgrounds/bg-17.jpg", dominantColor: "#18181b" },
  { id: "bg-18", src: "/backgrounds/bg-18.jpg", dominantColor: "#a855f7" },
  { id: "bg-19", src: "/backgrounds/bg-19.jpg", dominantColor: "#7c3aed" },
  { id: "bg-20", src: "/backgrounds/bg-20.jpg", dominantColor: "#334155" },
  { id: "bg-21", src: "/backgrounds/bg-21.jpg", dominantColor: "#dc2626" },
  { id: "bg-22", src: "/backgrounds/bg-22.jpg", dominantColor: "#064e3b" },
  { id: "bg-23", src: "/backgrounds/bg-23.jpg", dominantColor: "#3f3f46" },
  { id: "bg-24", src: "/backgrounds/bg-24.jpg", dominantColor: "#06b6d4" },
]

// ---------------------------------------------------------------------------
// Helper Utilities
// ---------------------------------------------------------------------------

/**
 * Detect the kind of background (solid, gradient, or image).
 */
export function getBackgroundKind(background: string | undefined): BackgroundKind {
  if (!background) return "solid"
  const trimmed = background.trim()
  if (
    trimmed.startsWith("linear-gradient") ||
    trimmed.startsWith("radial-gradient") ||
    trimmed.startsWith("conic-gradient") ||
    trimmed.includes("gradient(")
  ) {
    return "gradient"
  }
  if (
    trimmed.startsWith("url(") ||
    trimmed.startsWith("data:image/") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/backgrounds/") ||
    /\.(jpg|jpeg|png|webp|svg|gif)($|\?)/i.test(trimmed)
  ) {
    return "image"
  }
  return "solid"
}

/**
 * Convert any background string into a safe, valid CSS background property value.
 */
export function normalizeBackgroundCss(background: string | undefined): string {
  if (!background || !background.trim()) {
    return "#070b14"
  }
  const trimmed = background.trim()
  const kind = getBackgroundKind(trimmed)

  if (kind === "image") {
    if (trimmed.startsWith("url(")) {
      return trimmed
    }
    return `url("${trimmed}")`
  }

  return trimmed
}

/**
 * Build a linear gradient CSS string from 2 or 3 color stops and an angle.
 */
export function buildLinearGradient(
  color1: string,
  color2: string,
  angleDeg = 135,
  color3?: string,
): string {
  if (color3) {
    return `linear-gradient(${angleDeg}deg, ${color1} 0%, ${color2} 50%, ${color3} 100%)`
  }
  return `linear-gradient(${angleDeg}deg, ${color1} 0%, ${color2} 100%)`
}

/**
 * Build a radial gradient CSS string from inner and outer color stops.
 */
export function buildRadialGradient(
  innerColor: string,
  outerColor: string,
  baseColor = "#070b14",
): string {
  return `radial-gradient(at 50% 50%, ${innerColor} 0%, ${outerColor} 70%), ${baseColor}`
}

/**
 * Extract hex colors and angle from a gradient string for the custom gradient editor.
 */
export function parseGradientColors(gradientCss: string): {
  colors: string[]
  angle: number
} {
  const hexMatches = gradientCss.match(/#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/g) || []
  const angleMatch = gradientCss.match(/(\d+)deg/)
  const angle = angleMatch ? parseInt(angleMatch[1], 10) : 135

  const colors = hexMatches.length > 0 ? hexMatches : ["#6366f1", "#a855f7"]
  return { colors, angle }
}

/**
 * Extract a dominant fallback color from any background value.
 */
export function extractDominantColor(background: string | undefined): string {
  if (!background) return "#070b14"
  const kind = getBackgroundKind(background)
  if (kind === "solid") {
    if (background.startsWith("#") || background.startsWith("rgb")) {
      return background
    }
    return "#070b14"
  }
  if (kind === "gradient") {
    const { colors } = parseGradientColors(background)
    return colors[0] || "#070b14"
  }
  // Image background lookup
  const found = IMAGE_BACKGROUND_PRESETS.find(
    (p) => background.includes(p.src) || background.includes(p.id),
  )
  return found?.dominantColor || "#070b14"
}

export const DEFAULT_BACKGROUND_BLUR = 0
export const DEFAULT_BACKGROUND_DIM = 0
export const MAX_BACKGROUND_BLUR = 64
export const MAX_BACKGROUND_DIM = 0.9

export const BACKGROUND_BLUR_PRESETS = [
  { label: "0px", value: 0 },
  { label: "8px", value: 8 },
  { label: "16px", value: 16 },
  { label: "32px", value: 32 },
]

export const BACKGROUND_DIM_PRESETS = [
  { label: "0%", value: 0 },
  { label: "20%", value: 0.2 },
  { label: "40%", value: 0.4 },
  { label: "60%", value: 0.6 },
]

export const NORTHERN_LIGHTS_GRADIENT =
  "linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%)"

export const DEFAULT_CANVAS_BACKGROUND = NORTHERN_LIGHTS_GRADIENT

/**
 * Compute CSS filter & overlay style rules for an image background layer.
 */
export function computeBackgroundImageLayerStyle(
  blur?: number,
  dim?: number,
): {
  filter?: string
  transform?: string
  overlayOpacity?: number
} {
  const safeBlur = Math.max(0, Math.min(MAX_BACKGROUND_BLUR, blur ?? DEFAULT_BACKGROUND_BLUR))
  const safeDim = Math.max(0, Math.min(MAX_BACKGROUND_DIM, dim ?? DEFAULT_BACKGROUND_DIM))

  return {
    filter: safeBlur > 0 ? `blur(${safeBlur}px)` : undefined,
    transform: undefined,
    overlayOpacity: safeDim > 0 ? safeDim : undefined,
  }
}
