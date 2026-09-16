import { createFileRoute } from "@tanstack/react-router"
import { CtaSection } from "../../components/marketing/cta-section"
import { FeatureGrid } from "../../components/marketing/feature-grid"
import { HeroSection } from "../../components/marketing/hero-section"
import { LocalFirstSection } from "../../components/marketing/local-first-section"
import { StatsStrip } from "../../components/marketing/stats-strip"
import { StepsStrip } from "../../components/marketing/steps-strip"
import { getLatestRelease } from "../../lib/releases"

export const Route = createFileRoute("/_marketing/")({
  loader: async () => ({ release: await getLatestRelease() }),
  head: () => ({
    meta: [
      { title: "RecordForge — Local-first screen recorder & lightweight editor" },
      {
        name: "description",
        content:
          "RecordForge is a local-first screen recorder and lightweight timeline editor for Windows, macOS, and Linux. Subpixel cursor telemetry, zero-drift audio, hardware-encoded exports — no accounts, no telemetry.",
      },
      {
        property: "og:title",
        content: "RecordForge — Local-first screen recorder & lightweight editor",
      },
      {
        property: "og:description",
        content:
          "Native screen recording with buttery cursor motion, zero-drift audio, and a proxy timeline that never waits on renders. 100% local-first.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: LandingPage,
})

function LandingPage() {
  const { release } = Route.useLoaderData()

  return (
    <>
      <HeroSection version={release?.version} />
      <StatsStrip />
      <FeatureGrid />
      <StepsStrip />
      <LocalFirstSection />
      <CtaSection />
    </>
  )
}
