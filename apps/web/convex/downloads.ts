import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

const platformValidator = v.union(
  v.literal("windows"),
  v.literal("macos"),
  v.literal("linux"),
  v.literal("other"),
)

export const record = mutation({
  args: {
    platform: platformValidator,
    asset: v.string(),
    version: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("downloads", {
      platform: args.platform,
      asset: args.asset,
      version: args.version,
      createdAt: Date.now(),
    })

    // Bump the aggregate + per-platform counters in the same transaction so
    // the public stats query always reads a consistent total.
    for (const key of ["total", args.platform]) {
      const existing = await ctx.db
        .query("downloadCounters")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique()
      if (existing) {
        await ctx.db.patch(existing._id, { count: existing.count + 1 })
      } else {
        await ctx.db.insert("downloadCounters", { key, count: 1 })
      }
    }

    return null
  },
})

export const stats = query({
  args: {},
  returns: v.object({
    total: v.number(),
    windows: v.number(),
    macos: v.number(),
    linux: v.number(),
    other: v.number(),
  }),
  handler: async (ctx) => {
    const counters = await ctx.db.query("downloadCounters").withIndex("by_key").collect()

    const byKey = new Map(counters.map((c) => [c.key, c.count]))
    return {
      total: byKey.get("total") ?? 0,
      windows: byKey.get("windows") ?? 0,
      macos: byKey.get("macos") ?? 0,
      linux: byKey.get("linux") ?? 0,
      other: byKey.get("other") ?? 0,
    }
  },
})
