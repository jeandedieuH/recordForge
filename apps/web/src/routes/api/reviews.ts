import { createFileRoute } from "@tanstack/react-router"
import { ConvexHttpClient } from "convex/browser"
import { reviewSubmissionSchema } from "@recordforge/contracts"
import { api } from "../../../convex/_generated/api"

/**
 * POST /api/reviews — single ingest endpoint for star ratings + written
 * reviews from the desktop app and the website's own review form. The
 * desktop can't reach Convex directly (webview CSP), so it POSTs here and
 * we forward to the `reviews:submit` mutation server-side.
 */
export const Route = createFileRoute("/api/reviews")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const convexUrl = process.env.VITE_CONVEX_URL
        if (!convexUrl) {
          return Response.json({ error: "reviews backend is not configured" }, { status: 500 })
        }

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }

        const parsed = reviewSubmissionSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json({ error: "invalid review submission" }, { status: 400 })
        }

        try {
          const client = new ConvexHttpClient(convexUrl)
          await client.mutation(api.reviews.submit, parsed.data)
        } catch {
          return Response.json({ error: "could not submit the review" }, { status: 502 })
        }
        return Response.json({ ok: true })
      },
    },
  },
})
