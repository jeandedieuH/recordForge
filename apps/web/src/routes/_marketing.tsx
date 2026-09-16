import { createFileRoute, Outlet } from "@tanstack/react-router"
import { SiteFooter } from "../components/marketing/site-footer"
import { SiteHeader } from "../components/marketing/site-header"

export const Route = createFileRoute("/_marketing")({
  component: MarketingLayout,
})

/** Pathless layout: shared floating nav + footer for all marketing pages. */
function MarketingLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  )
}
