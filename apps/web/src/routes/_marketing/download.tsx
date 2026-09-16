import { useQuery } from "@tanstack/react-query"
import { convexQuery } from "@convex-dev/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { AppWindow, Command, ExternalLink, Terminal } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "../../../convex/_generated/api"
import { DownloadHero } from "../../components/download/download-hero"
import { PlatformCard } from "../../components/download/platform-card"
import { Reveal } from "../../components/marketing/reveal"
import {
  detectPlatform,
  getLatestRelease,
  type DetectedPlatform,
  type DownloadPlatform,
} from "../../lib/releases"

const PLATFORMS: { platform: DownloadPlatform; icon: typeof AppWindow }[] = [
  { platform: "windows", icon: AppWindow },
  { platform: "macos", icon: Command },
  { platform: "linux", icon: Terminal },
]

export const Route = createFileRoute("/_marketing/download")({
  loader: async () => ({ release: await getLatestRelease() }),
  head: () => ({
    meta: [
      { title: "Download RecordForge — Windows, macOS & Linux" },
      {
        name: "description",
        content:
          "Download the latest RecordForge release for Windows, macOS (Apple Silicon), or Linux. Free, open source, and local-first — no account required.",
      },
      { property: "og:title", content: "Download RecordForge" },
      {
        property: "og:description",
        content:
          "Get the latest signed RecordForge build for your platform — straight from the release pipeline.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: DownloadPage,
})

function DownloadPage() {
  const { release } = Route.useLoaderData()
  // Detection runs after hydration so SSR and the first client render agree.
  const [detected, setDetected] = useState<DetectedPlatform>("other")
  const { data: stats } = useQuery(convexQuery(api.downloads.stats, {}))

  useEffect(() => {
    setDetected(detectPlatform())
  }, [])

  return (
    <>
      <DownloadHero release={release} />

      <section className="mx-auto w-full max-w-6xl px-4 pb-10">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {PLATFORMS.map(({ platform, icon }, index) => (
            <Reveal key={platform} delay={index * 90} className="h-full">
              <PlatformCard
                platform={platform}
                icon={icon}
                assets={release?.assets[platform]}
                version={release?.version}
                releasesUrl={release?.releasesUrl ?? FALLBACK_RELEASES_URL}
                detected={detected === platform}
                downloadCount={stats?.[platform]}
              />
            </Reveal>
          ))}
        </div>

        <Reveal delay={200}>
          <p className="mt-10 text-center text-sm text-muted-foreground">
            Looking for another build or an older version?{" "}
            <a
              href={release?.releasesUrl ?? FALLBACK_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-forge hover:text-accent hover:underline"
            >
              Browse all releases on GitHub
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </p>
        </Reveal>
      </section>
    </>
  )
}

const FALLBACK_RELEASES_URL = "https://github.com/jeandedieuH/recordForge/releases/latest"
