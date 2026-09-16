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
})
