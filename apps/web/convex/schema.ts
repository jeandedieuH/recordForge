import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  // One row per download click — keeps per-version/platform detail for analytics.
  // The public counter is served from downloadCounters (O(1) reads).
  downloads: defineTable({
    platform: v.string(),
    asset: v.string(),
    version: v.string(),
    createdAt: v.number(),
  }).index("by_platform", ["platform"]),

  // Running totals maintained transactionally inside the record mutation.
  // Keys: "total" plus one per platform ("windows" | "macos" | "linux" | "other").
  downloadCounters: defineTable({
    key: v.string(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // Star ratings + written reviews submitted from the desktop app or the
  // website. `approved` is the moderation gate — only approved rows are
  // served to the public testimonials section (flipped in the dashboard).
  reviews: defineTable({
    rating: v.number(),
    text: v.optional(v.string()),
    name: v.optional(v.string()),
    tier: v.optional(v.union(v.literal("free"), v.literal("pro"))),
    appVersion: v.optional(v.string()),
    os: v.optional(v.string()),
    source: v.union(v.literal("app"), v.literal("web")),
    createdAt: v.number(),
    approved: v.boolean(),
  }).index("by_approved", ["approved"]),
})
