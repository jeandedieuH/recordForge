import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { download } from "./setup.mjs"

// Regression coverage for the CI failure where ffmpeg.martin-riedl.de
// returned a transient Cloudflare 521 mid-setup and the script aborted
// instead of retrying or trying the fallback URL.
type Behavior = number | "close"

interface TestServer {
  url: string
  hits: () => number
  close: () => void
}

async function serve(behaviors: Behavior[]): Promise<TestServer> {
  const requestUrls: string[] = []
  const server: Server = createServer((req, res) => {
    const behavior = behaviors[requestUrls.length] ?? behaviors.at(-1) ?? 200
    requestUrls.push(req.url ?? "")
    if (behavior === "close") {
      req.socket.destroy()
      return
    }
    res.writeHead(behavior)
    res.end("payload")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("test server failed to bind a port")
  }
  return {
    url: `http://127.0.0.1:${address.port}/artifact`,
    hits: () => requestUrls.length,
    close: () => server.close(),
  }
}

// Near-zero backoff keeps the retry path fast; the production defaults live
// in setup.mjs and are injected through the options parameter here.
const FAST_RETRY = { maxAttempts: 4, backoffMs: [1, 1, 1] }

function tempDest(): { dir: string; dest: string } {
  const dir = mkdtempSync(join(tmpdir(), "setup-ffmpeg-test-"))
  return { dir, dest: join(dir, "download.bin") }
}

describe("download", () => {
  test("retries transient 5xx responses and succeeds", async () => {
    const server = await serve([521, 521, 200])
    const { dir, dest } = tempDest()
    try {
      const ok = await download(server.url, dest, FAST_RETRY)
      expect(ok).toBe(true)
      expect(server.hits()).toBe(3)
      expect(readFileSync(dest, "utf-8")).toBe("payload")
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("retries when the connection drops mid-download", async () => {
    const server = await serve(["close", 200])
    const { dir, dest } = tempDest()
    try {
      const ok = await download(server.url, dest, FAST_RETRY)
      expect(ok).toBe(true)
      expect(server.hits()).toBe(2)
      expect(readFileSync(dest, "utf-8")).toBe("payload")
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not retry 404 — the artifact is genuinely absent", async () => {
    const server = await serve([404])
    const { dir, dest } = tempDest()
    try {
      const ok = await download(server.url, dest, FAST_RETRY)
      expect(ok).toBe(false)
      expect(server.hits()).toBe(1)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not retry non-retryable client errors", async () => {
    const server = await serve([403])
    const { dir, dest } = tempDest()
    try {
      const ok = await download(server.url, dest, FAST_RETRY)
      expect(ok).toBe(false)
      expect(server.hits()).toBe(1)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("gives up after maxAttempts so the caller can try the fallback", async () => {
    const server = await serve([521])
    const { dir, dest } = tempDest()
    try {
      const ok = await download(server.url, dest, FAST_RETRY)
      expect(ok).toBe(false)
      expect(server.hits()).toBe(4)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
