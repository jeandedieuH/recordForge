/**
 * Single source for pricing copy used by the marketing pages and linked from
 * the desktop app's upgrade surfaces (PRO_CHECKOUT_URL points here).
 *
 * Polar checkout: paste the generated Checkout Link from the Polar dashboard
 * (Products → RecordForge Pro → Checkout Links). Polar generates IDs like
 * `polar_cl_…` — `buy.polar.sh/<product-name>` is NOT a valid format and 404s.
 */
export const CHECKOUT_URL = "https://buy.polar.sh/polar_cl_ZrbOX8Isev0738LkzZkssAri6FHjoMGZu1Xau0hyFbF"

/** Pro Lifetime is $39; the FOUNDER discount code pre-applies $10 off for the
 * first 30 days after launch. */
export const PRO_PRICE = "$39"
export const PRO_FOUNDER_PRICE = "$29"
export const PRO_DEVICES = "3 devices"

export interface PlanFeature {
  label: string
  free: string | boolean
  pro: string | boolean
}

/** Free vs Pro comparison rows shown on /pricing. Keep in sync with LICENSING.md. */
export const FEATURE_COMPARISON: PlanFeature[] = [
  { label: "Recording length & framerate", free: "Unlimited, up to 4K60 capture", pro: true },
  { label: "Timeline editor", free: "Cuts, trims, captions, cursor smoothing", pro: true },
  { label: "MP4 / GIF / WebP export", free: "Up to 1080p output", pro: "Up to 4K output" },
  { label: "Aspect ratios", free: "16:9 widescreen", pro: "9:16, 1:1, 5:4, 4:5" },
  { label: "Export presets", free: "1080p presets", pro: "Ultra 4K & social presets" },
  { label: "Chapters & markers", free: false, pro: "MP4 chapters + YouTube timestamps" },
  { label: "Title presets", free: "Clean Text", pro: "Every title design" },
  { label: "Annotations", free: false, pro: "Shapes, arrows, callouts" },
  { label: "Devices", free: true, pro: "3 personal devices" },
  { label: "Account required", free: "Never", pro: "One-time activation only" },
  { label: "Offline use", free: true, pro: true },
]

export const PRO_FAQ: { question: string; answer: string }[] = [
  {
    question: "Is RecordForge still open source?",
    answer:
      "Yes — the app is GPL-3.0 and always will be. Pro is an open-core entitlement: it unlocks features inside the same binary. Buying Pro funds development; it doesn't change the license of the code.",
  },
  {
    question: "What does 'lifetime' mean?",
    answer:
      "One payment, every future update included — no subscription, no recurring charge. The license covers up to 3 of your personal devices and can be moved between them. There's a 14-day no-questions refund.",
  },
  {
    question: "What's the founder price?",
    answer:
      "Launch buyers pay $29 instead of $39 — a $10 founder discount for the first 30 days after launch, applied automatically at checkout. It locks in the same lifetime license.",
  },
  {
    question: "Do I need to stay online for Pro?",
    answer:
      "No. Activation is a single online check. After that the signed license lives on your device and Pro works fully offline — matching RecordForge's local-first promise.",
  },
  {
    question: "What happens to projects I edited without Pro?",
    answer:
      "Nothing is lost. Free exports automatically drop Pro-only items (annotations, premium titles, chapters) or downscale above 1080p. Activating Pro re-enables everything that's already in your project — no rework needed.",
  },
  {
    question: "What's next on the Pro roadmap?",
    answer:
      "Instant web delivery — share a link straight from the app — plus team-oriented features. Existing Pro licenses get them free when they ship.",
  },
]
