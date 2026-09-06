import { mutation, query } from "./_generated/server"

const SAMPLE_TASKS = [
  { text: "Buy groceries", isCompleted: true },
  { text: "Go for a swim", isCompleted: true },
  { text: "Integrate Convex", isCompleted: false },
]

export const get = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect()
  },
})

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    for (const task of SAMPLE_TASKS) {
      await ctx.db.insert("tasks", task)
    }
  },
})
