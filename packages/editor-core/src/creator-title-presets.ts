import { titleDesignSchema, titleDesignV2Schema, type TitleTemplate } from "@recordforge/domain"
import type { z } from "zod"
import type { PresetCatalog } from "./presets/preset-registry"
import type { TextPresetDefinition, TextPresetRecord, TextPresetValues } from "./text-presets"
import { getTitlePresetGroup, TITLE_APPEARANCE_COLORS } from "./title-preset-helpers"

const base: TextPresetValues = {
  defaultPrimaryText: "A clear point of view",
  width: 1120,
  height: 260,
  alignment: "left",
  fontFamily: "sans",
  fontSize: 72,
  fontWeight: "600",
  ...TITLE_APPEARANCE_COLORS.dark,
  accentColor: "rgb(190, 242, 100)",
  backdropStyle: "solid",
  backdropOpacity: 0.96,
  backdropBlur: 0,
  backdropBorderRadius: 0,
  backdropPaddingX: 48,
  backdropPaddingY: 36,
  shadowEnabled: false,
  shadowColor: "rgba(0, 0, 0, 0.35)",
  shadowBlur: 0,
  // Designed title motion is evaluated by the canonical engine, not a second legacy entrance.
  animationIn: "none",
  animationOut: "none",
  overlayAnimation: {
    inType: "none",
    outType: "none",
    inDurationMs: 450,
    outDurationMs: 300,
    easing: "expo-out",
  },
  autoScaleText: true,
}

// Input is the raw v2 shape (defaults not yet applied); the versioned schema
// fills them during parse so presets stay concise.
type DesignInput = Omit<z.input<typeof titleDesignV2Schema>, "version" | "template">

function title(
  id: string,
  name: string,
  template: TitleTemplate,
  category: TextPresetDefinition["category"],
  description: string,
  values: Partial<TextPresetValues>,
  design: DesignInput = {},
): TextPresetRecord {
  const titleDesign = titleDesignSchema.parse({ version: 2, template, ...design })
  return {
    id,
    name,
    description,
    category,
    tags: [getTitlePresetGroup(template), template, name.toLowerCase()],
    definition: {
      ...base,
      ...(design.backdrop?.style === "none" ? { backdropOpacity: 0 } : {}),
      ...values,
      titleDesign,
    },
  }
}

// Geometry is authored against a 1920 x 1080 canvas; only versioned titles opt into scaling.
export const CREATOR_TITLE_PRESET_CATALOG: PresetCatalog<TextPresetValues> = {
  version: 2,
  categories: ["openers", "lower-third", "social", "tutorial", "data", "outro"],
  presets: [
    // ── Openers ─────────────────────────────────────────────────────────────
    title(
      "text-clean",
      "Clean Title",
      "clean",
      "openers",
      "Quiet, unboxed typography for a clear title or a short thought.",
      {
        defaultPrimaryText: "Make room for better ideas",
        defaultSecondaryText: "A simpler way to work",
        width: 1240,
        height: 240,
        alignment: "center",
        fontSize: 68,
        backdropStyle: "none",
      },
      {
        typography: { align: "center" },
        animation: {
          in: { preset: "rise", unit: "line", durationMs: 420, staggerMs: 90, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-hook",
      "Hook Headline",
      "hook",
      "openers",
      "Oversized display type with a quick word-by-word pop for scroll-stopping opens.",
      {
        defaultPrimaryText: "Stop doing it twice.",
        defaultSecondaryText: "One small change. Hours back.",
        defaultTagText: "WORK SMARTER",
        width: 1360,
        height: 420,
        fontFamily: "heading",
        fontSize: 116,
        fontWeight: "800",
      },
      {
        elements: { tag: { textTransform: "uppercase" } },
        animation: {
          in: { preset: "scale-pop", unit: "word", durationMs: 480, staggerMs: 70, easing: "back-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-emphasis",
      "Emphasis",
      "hook-emphasis",
      "openers",
      "A headline with one accent-highlighted phrase that pulls the eye first.",
      {
        defaultPrimaryText: "Less noise. More focus.",
        defaultSecondaryText: "Build a workflow that works for you",
        defaultTagText: "THE TAKEAWAY",
        width: 1200,
        height: 300,
        fontFamily: "heading",
        fontSize: 88,
        fontWeight: "700",
      },
      {
        emphasis: { text: "More focus.", style: "marker" },
        typography: { letterSpacing: -0.02 },
        animation: {
          in: { preset: "highlight-sweep", unit: "line", durationMs: 520, staggerMs: 100, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-editorial",
      "Editorial Opener",
      "editorial",
      "openers",
      "A serif headline, small eyebrow and fine rules for a considered opening.",
      {
        defaultPrimaryText: "The art of starting small",
        defaultSecondaryText: "Good work begins with one useful idea.",
        defaultTagText: "FIELD NOTES / 01",
        width: 1360,
        height: 440,
        fontFamily: "serif",
        fontSize: 100,
        fontWeight: "500",
        accentColor: "rgb(215, 156, 99)",
        backdropPaddingX: 64,
        backdropPaddingY: 48,
      },
      {
        typography: { letterSpacing: -0.02, lineHeight: 1.1 },
        animation: {
          in: { preset: "rise", unit: "line", durationMs: 560, staggerMs: 110, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 300, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-chapter",
      "Chapter Card",
      "chapter",
      "openers",
      "A confident chapter number and title mark the next part of your story.",
      {
        defaultPrimaryText: "Build the foundation",
        defaultSecondaryText: "Set up your workspace",
        defaultTagText: "02",
        width: 1200,
        height: 320,
        fontFamily: "heading",
        fontSize: 76,
        fontWeight: "600",
        accentColor: "rgb(147, 197, 253)",
      },
      {
        animation: {
          in: { preset: "slide-left", unit: "block", durationMs: 440, staggerMs: 90, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-kinetic",
      "Kinetic Words",
      "kinetic",
      "openers",
      "Short-form style: every word lands with its own beat.",
      {
        defaultPrimaryText: "This one habit changed everything",
        defaultSecondaryText: "Save this for later",
        width: 1360,
        height: 420,
        fontFamily: "heading",
        fontSize: 120,
        fontWeight: "800",
      },
      {
        typography: { letterSpacing: -0.02, lineHeight: 1.05 },
        animation: {
          in: { preset: "scale-pop", unit: "word", durationMs: 380, staggerMs: 120, easing: "back-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 200, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-highlight",
      "Marker Highlight",
      "highlight",
      "openers",
      "Key lines get the highlighter treatment, swept in like a marker.",
      {
        defaultPrimaryText: "The boring stuff is what actually matters",
        width: 1200,
        height: 300,
        fontSize: 84,
        fontWeight: "700",
      },
      {
        emphasis: { text: "", style: "marker", color: "rgb(250, 204, 21)" },
        animation: {
          in: { preset: "highlight-sweep", unit: "line", durationMs: 520, staggerMs: 140, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-banner",
      "Announcement Banner",
      "banner",
      "openers",
      "A full-width accent band that says the thing loudly, then gets out of the way.",
      {
        defaultPrimaryText: "New in this release",
        defaultSecondaryText: "Available today for everyone",
        width: 1500,
        height: 300,
        fontFamily: "heading",
        fontSize: 80,
        fontWeight: "700",
        accentColor: "rgb(190, 242, 100)",
      },
      {
        animation: {
          in: { preset: "mask-wipe", unit: "block", durationMs: 500, staggerMs: 0, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 240, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),

    // ── Lower thirds ────────────────────────────────────────────────────────
    title(
      "text-speaker",
      "Lower Third · Bar",
      "lower-third-bar",
      "lower-third",
      "A compact nameplate with an accent bar for names and roles.",
      {
        defaultPrimaryText: "Jordan Lee",
        defaultSecondaryText: "Product designer",
        width: 760,
        height: 200,
        fontSize: 56,
        fontWeight: "600",
        backdropStyle: "none",
        accentColor: "rgb(147, 197, 253)",
      },
      {
        placement: { anchor: "bl", marginX: 96, marginY: 96 },
        animation: {
          in: { preset: "slide-left", unit: "block", durationMs: 380, staggerMs: 80, easing: "expo-out", direction: "normal" },
          out: { preset: "slide-left", unit: "block", durationMs: 300, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-lower-third-glass",
      "Lower Third · Glass",
      "lower-third-glass",
      "lower-third",
      "A frosted panel keeps text readable over busy footage.",
      {
        defaultPrimaryText: "Amara Chen",
        defaultSecondaryText: "Staff engineer",
        width: 780,
        height: 200,
        fontSize: 56,
        fontWeight: "600",
        backdropStyle: "solid",
        backdropOpacity: 0.5,
        backdropBorderRadius: 18,
      },
      {
        backdrop: { style: "glass" },
        placement: { anchor: "bl", marginX: 96, marginY: 96 },
        animation: {
          in: { preset: "rise", unit: "block", durationMs: 400, staggerMs: 0, easing: "expo-out", direction: "normal" },
          out: { preset: "drop", unit: "block", durationMs: 300, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-lower-third-line",
      "Lower Third · Line",
      "lower-third-line",
      "lower-third",
      "The lightest option: type with a single accent rule underneath.",
      {
        defaultPrimaryText: "Sam Ortiz",
        defaultSecondaryText: "Founder, Fieldwork",
        width: 780,
        height: 200,
        fontSize: 56,
        fontWeight: "600",
        backdropStyle: "none",
        accentColor: "rgb(215, 156, 99)",
      },
      {
        backdrop: { style: "none" },
        placement: { anchor: "bl", marginX: 96, marginY: 96 },
        animation: {
          in: { preset: "slide-left", unit: "line", durationMs: 380, staggerMs: 100, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-source",
      "Source Credit",
      "source",
      "lower-third",
      "A restrained credit line keeps the source visible without taking over.",
      {
        defaultPrimaryText: "Our World in Data",
        defaultSecondaryText: "ourworldindata.org / 2025",
        defaultTagText: "SOURCE",
        width: 860,
        height: 160,
        fontSize: 36,
        fontWeight: "500",
        backdropStyle: "none",
      },
      {
        placement: { anchor: "bl", marginX: 80, marginY: 80 },
        animation: {
          in: { preset: "fade", unit: "block", durationMs: 350, staggerMs: 0, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 250, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),

    // ── Social ───────────────────────────────────────────────────────────────
    title(
      "text-social-handle",
      "Social Handle",
      "social-handle",
      "social",
      "Your handle in a neat chip so viewers know where to find you.",
      {
        defaultPrimaryText: "@jordandesigns",
        defaultSecondaryText: "New videos every week",
        defaultTagText: "FOLLOW",
        width: 720,
        height: 220,
        fontSize: 60,
        fontWeight: "600",
      },
      {
        placement: { anchor: "bl", marginX: 96, marginY: 96 },
        animation: {
          in: { preset: "scale-pop", unit: "block", durationMs: 400, staggerMs: 0, easing: "back-out", direction: "normal" },
          out: { preset: "scale-pop", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-cta-follow",
      "Subscribe / Follow CTA",
      "cta-follow",
      "social",
      "A button-style prompt that asks for the follow once, clearly.",
      {
        defaultPrimaryText: "Follow for more",
        defaultSecondaryText: "Tutorials every Tuesday",
        width: 900,
        height: 320,
        fontFamily: "heading",
        fontSize: 64,
        fontWeight: "700",
        alignment: "center",
      },
      {
        typography: { align: "center" },
        placement: { anchor: "bc", marginY: 96 },
        animation: {
          in: { preset: "scale-pop", unit: "block", durationMs: 420, staggerMs: 0, easing: "back-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-cta-link",
      "Link CTA",
      "cta-link",
      "social",
      "Point viewers at a link they can actually read and remember.",
      {
        defaultPrimaryText: "Get the template",
        defaultSecondaryText: "Free for personal projects",
        defaultTagText: "recordforge.prestigetech.dev",
        width: 980,
        height: 340,
        fontFamily: "heading",
        fontSize: 64,
        fontWeight: "700",
        alignment: "center",
      },
      {
        typography: { align: "center" },
        placement: { anchor: "bc", marginY: 96 },
        animation: {
          in: { preset: "rise", unit: "block", durationMs: 420, staggerMs: 90, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-cta",
      "Call to Action",
      "cta",
      "social",
      "A clear next step with a supporting line and a destination.",
      {
        defaultPrimaryText: "Try it on your next project",
        defaultSecondaryText: "Start small. Make something useful.",
        defaultTagText: "recordforge.prestigetech.dev",
        width: 1200,
        height: 320,
        fontFamily: "heading",
        fontSize: 68,
        fontWeight: "600",
        alignment: "center",
      },
      {
        typography: { align: "center" },
        animation: {
          in: { preset: "rise", unit: "block", durationMs: 420, staggerMs: 90, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),

    // ── Tutorial ─────────────────────────────────────────────────────────────
    title(
      "text-step",
      "Numbered Step",
      "step",
      "tutorial",
      "A numbered badge keeps a tutorial easy to follow.",
      {
        defaultPrimaryText: "Choose your capture area",
        defaultSecondaryText: "Drag to frame only what matters.",
        defaultTagText: "1",
        width: 1040,
        height: 240,
        fontSize: 56,
        accentColor: "rgb(147, 197, 253)",
      },
      {
        placement: { anchor: "tl", marginX: 96, marginY: 96 },
        animation: {
          in: { preset: "rise", unit: "block", durationMs: 400, staggerMs: 90, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-checklist",
      "Checklist",
      "checklist",
      "tutorial",
      "Two to five items tick in one after another — write one item per line in the supporting text.",
      {
        defaultPrimaryText: "Before you record",
        defaultSecondaryText: "Close notifications\nCheck your mic level\nFrame the window",
        width: 960,
        height: 380,
        fontSize: 56,
        fontWeight: "600",
      },
      {
        animation: {
          in: { preset: "rise", unit: "line", durationMs: 400, staggerMs: 130, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-shortcut",
      "Keyboard Shortcut",
      "shortcut",
      "tutorial",
      "Monospaced keycaps make a useful shortcut easy to remember.",
      {
        defaultPrimaryText: "Ctrl + Shift + S",
        defaultSecondaryText: "Save a copy",
        width: 820,
        height: 240,
        fontFamily: "mono",
        fontSize: 52,
        backdropBorderRadius: 12,
      },
      {
        animation: {
          in: { preset: "scale-pop", unit: "block", durationMs: 380, staggerMs: 0, easing: "back-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 240, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-command",
      "Terminal Command",
      "terminal",
      "tutorial",
      "A focused terminal prompt that types the command on screen.",
      {
        defaultPrimaryText: "bun run dev",
        defaultSecondaryText: "Start the development server",
        defaultTagText: "TERMINAL",
        width: 1120,
        height: 280,
        fontFamily: "mono",
        fontSize: 52,
        fontWeight: "500",
        backdropBorderRadius: 12,
      },
      {
        animation: {
          in: { preset: "typewriter", unit: "char", durationMs: 700, staggerMs: 0, easing: "linear", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-note",
      "Callout",
      "callout",
      "tutorial",
      "A tone-colored bar with a note, tip or warning, away from the main action.",
      {
        defaultPrimaryText: "Keep a little breathing room",
        defaultSecondaryText: "Leave space around the area you want to show.",
        width: 1040,
        height: 240,
        fontSize: 48,
        fontWeight: "600",
        backdropBorderRadius: 8,
      },
      {
        noteTone: "tip",
        animation: {
          in: { preset: "slide-left", unit: "block", durationMs: 380, staggerMs: 80, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-quote",
      "Quote / Testimonial",
      "quote",
      "tutorial",
      "Generous serif typography lets a memorable thought stand on its own.",
      {
        defaultPrimaryText: "Make the useful thing beautiful.",
        defaultSecondaryText: "Jordan Lee, product designer",
        width: 1240,
        height: 380,
        fontFamily: "serif",
        fontSize: 76,
        fontWeight: "500",
        accentColor: "rgb(215, 156, 99)",
        backdropPaddingX: 64,
        backdropPaddingY: 44,
      },
      {
        typography: { lineHeight: 1.2 },
        animation: {
          in: { preset: "rise", unit: "line", durationMs: 520, staggerMs: 110, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 300, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-location",
      "Location / Date Stamp",
      "location",
      "tutorial",
      "A pin, a place and a date — the vlog staple.",
      {
        defaultPrimaryText: "Lisbon, Portugal",
        defaultSecondaryText: "March 2026",
        width: 860,
        height: 180,
        fontSize: 52,
        fontWeight: "600",
        backdropStyle: "none",
      },
      {
        placement: { anchor: "tl", marginX: 96, marginY: 96 },
        animation: {
          in: { preset: "drop", unit: "block", durationMs: 420, staggerMs: 0, easing: "back-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),

    // ── Data ─────────────────────────────────────────────────────────────────
    title(
      "text-metric",
      "Stat Counter",
      "stat",
      "data",
      "A large animated number with enough context to make it meaningful.",
      {
        defaultPrimaryText: "Less time on busywork",
        defaultSecondaryText: "Compared with our previous workflow",
        defaultTagText: "THIS QUARTER",
        width: 920,
        height: 420,
        fontFamily: "heading",
        fontSize: 112,
        fontWeight: "700",
      },
      {
        metric: { from: 0, to: 42, decimals: 0, prefix: "", suffix: "%" },
        animation: {
          in: { preset: "counter", unit: "block", durationMs: 900, staggerMs: 0, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 280, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-stat-delta",
      "Before → After",
      "stat-before-after",
      "data",
      "The number climbs from where you were to where you are now, arrow included.",
      {
        defaultPrimaryText: "Rendering time per video",
        defaultSecondaryText: "After switching to the GPU pipeline",
        defaultTagText: "BEFORE → AFTER",
        width: 980,
        height: 420,
        fontFamily: "heading",
        fontSize: 112,
        fontWeight: "700",
      },
      {
        metric: { from: 12, to: 3, decimals: 0, prefix: "", suffix: " min" },
        animation: {
          in: { preset: "counter", unit: "block", durationMs: 1000, staggerMs: 0, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 280, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-countdown",
      "Countdown 3-2-1",
      "countdown",
      "data",
      "Three big numbers that tick down before the action starts.",
      {
        defaultPrimaryText: "Starting soon",
        width: 600,
        height: 480,
        fontFamily: "heading",
        fontSize: 140,
        fontWeight: "800",
        alignment: "center",
        backdropStyle: "none",
      },
      {
        typography: { align: "center" },
        metric: { from: 3, to: 1, decimals: 0, prefix: "", suffix: "" },
        animation: {
          in: { preset: "counter", unit: "block", durationMs: 2000, staggerMs: 0, easing: "linear", direction: "normal" },
          out: { preset: "scale-pop", unit: "block", durationMs: 300, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
    title(
      "text-agenda",
      "Agenda / Progress List",
      "agenda",
      "data",
      "A tidy list with progress dots — one item per line in the supporting text.",
      {
        defaultPrimaryText: "Today we will cover",
        defaultSecondaryText: "Why the old flow broke\nThe new pipeline\nWhat to try first",
        width: 980,
        height: 400,
        fontSize: 56,
        fontWeight: "600",
      },
      {
        animation: {
          in: { preset: "rise", unit: "line", durationMs: 400, staggerMs: 110, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 260, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),

    // ── Outro ────────────────────────────────────────────────────────────────
    title(
      "text-outro",
      "End Screen / Outro",
      "outro",
      "outro",
      "A headline plus your handle in a pill — the closing beat of the video.",
      {
        defaultPrimaryText: "Thanks for watching",
        defaultSecondaryText: "See you in the next one",
        defaultTagText: "@jordandesigns",
        width: 1200,
        height: 420,
        fontFamily: "heading",
        fontSize: 92,
        fontWeight: "700",
        alignment: "center",
      },
      {
        typography: { align: "center" },
        animation: {
          in: { preset: "rise", unit: "block", durationMs: 500, staggerMs: 120, easing: "expo-out", direction: "normal" },
          out: { preset: "fade", unit: "block", durationMs: 300, staggerMs: 0, easing: "expo-in", direction: "normal" },
        },
      },
    ),
  ],
}
