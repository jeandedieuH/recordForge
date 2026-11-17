import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

const tierValidator = v.union(v.literal("free"), v.literal("pro"))
const sourceValidator = v.union(v.literal("app"), v.literal("web"))

/** Mirrors REVIEW_MAX_* in packages/contracts/src/review.ts. */
const MAX_TEXT_LENGTH = 600
const MAX_NAME_LENGTH = 60

/**
 * Public ingest for app + website reviews. Unauthenticated like
 * `downloads.record` — abuse is contained by the honeypot arg, field caps,
 * and the `approved` moderation gate (nothing reaches the site until a row
 * is approved in the dashboard).
 */
export const submit = mutation({
  args: {
    rating: v.number(),
    text: v.optional(v.string()),
    name: v.optional(v.string()),
    tier: v.optional(tierValidator),
    appVersion: v.optional(v.string()),
    os: v.optional(v.string()),
    source: sourceValidator,
    website: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Honeypot: a filled `website` field means a bot — accept silently so
    // automated submitters get no signal.
    if (args.website) return null

    const rating = Math.round(args.rating)
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new Error("rating must be an integer between 1 and 5")
    }

    const text = args.text?.trim().slice(0, MAX_TEXT_LENGTH)
    const name = args.name?.trim().slice(0, MAX_NAME_LENGTH)

    await ctx.db.insert("reviews", {
      rating,
      text: text || undefined,
      name: name || undefined,
      tier: args.tier,
      appVersion: args.appVersion,
      os: args.os,
      source: args.source,
      createdAt: Date.now(),
      approved: false,
    })
    return null
  },
})

/** Approved testimonials for the marketing site, newest first. */
export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.id("reviews"),
      rating: v.number(),
      text: v.union(v.string(), v.null()),
      name: v.union(v.string(), v.null()),
      tier: v.union(tierValidator, v.null()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_approved", (q) => q.eq("approved", true))
      .order("desc")
      .take(Math.min(args.limit ?? 12, 50))
    return rows.map((row) => ({
      id: row._id,
      rating: row.rating,
      text: row.text ?? null,
      name: row.name ?? null,
      tier: row.tier ?? null,
      createdAt: row.createdAt,
    }))
  },
})

/** Aggregate for the testimonials heading — approved reviews only. */
export const stats = query({
  args: {},
  returns: v.object({
    count: v.number(),
    average: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("reviews")
      .withIndex("by_approved", (q) => q.eq("approved", true))
      .collect()
    if (rows.length === 0) return { count: 0, average: null }
    const average = rows.reduce((sum, row) => sum + row.rating, 0) / rows.length
    return { count: rows.length, average }
  },
})
