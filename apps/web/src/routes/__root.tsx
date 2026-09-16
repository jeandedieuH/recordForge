import type { QueryClient } from "@tanstack/react-query"
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router"
import { NotFound } from "../components/not-found"
import appCss from "../styles/index.css?url"

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "RecordForge",
      },
      {
        name: "description",
        content:
          "RecordForge is a local-first screen recorder and lightweight timeline editor for Windows, macOS, and Linux.",
      },
      {
        name: "theme-color",
        content: "#070b14",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/icon.svg",
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground min-h-screen font-sans">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
