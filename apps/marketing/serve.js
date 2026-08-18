import { serve } from "bun"
import { join } from "path"
import { existsSync, statSync } from "fs"

const distDir = join(import.meta.dir, "dist")

serve({
  port: 4321,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    let filePath = join(distDir, url.pathname === "/" ? "index.html" : url.pathname)

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, "index.html")
    }

    if (existsSync(filePath)) {
      return new Response(Bun.file(filePath))
    }

    return new Response(Bun.file(join(distDir, "index.html")))
  },
})

console.log("Serving marketing site at http://127.0.0.1:4321")
