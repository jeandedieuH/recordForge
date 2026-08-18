import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@recordforge/contracts": path.resolve(import.meta.dirname, "../../packages/contracts/src"),
      "@recordforge/cursor-core": path.resolve(
        import.meta.dirname,
        "../../packages/cursor-core/src",
      ),
      "@recordforge/domain": path.resolve(import.meta.dirname, "../../packages/domain/src"),
      "@recordforge/editor-core": path.resolve(
        import.meta.dirname,
        "../../packages/editor-core/src",
      ),
      "@recordforge/media-core": path.resolve(import.meta.dirname, "../../packages/media-core/src"),
      "@recordforge/overlay-core": path.resolve(
        import.meta.dirname,
        "../../packages/overlay-core/src",
      ),
      "@recordforge/storage-core": path.resolve(
        import.meta.dirname,
        "../../packages/storage-core/src",
      ),
      "@recordforge/ui/theme.css": path.resolve(
        import.meta.dirname,
        "../../packages/ui/src/styles/theme.css",
      ),
      "@recordforge/ui": path.resolve(import.meta.dirname, "../../packages/ui/src"),
    },
  },
  optimizeDeps: {
    exclude: [
      "@recordforge/contracts",
      "@recordforge/cursor-core",
      "@recordforge/domain",
      "@recordforge/editor-core",
      "@recordforge/media-core",
      "@recordforge/overlay-core",
      "@recordforge/storage-core",
      "@recordforge/ui",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}))
