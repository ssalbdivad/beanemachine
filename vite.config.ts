import react from "@vitejs/plugin-react"
import { copyFileSync } from "node:fs"
import { defineConfig, type Plugin } from "vite"

const API = "http://127.0.0.1:8000"

/** The engine is pure, so ranking runs in the browser. The build needs two assets:
 *  the observed-data snapshot, because browsers can't call MLB or Savant directly
 *  (neither sends CORS headers), and scoring.json, which seeds a browser that has
 *  no leagues stored yet so a first visit opens on a real league. */
const publishSnapshot = (): Plugin => ({
	name: "publish-snapshot",
	buildStart: () => {
		copyFileSync("data/snapshot.json", "public/snapshot.json")
		copyFileSync("scoring.json", "public/scoring.json")
	}
})

export default defineConfig(({ command }) => ({
	// GitHub Pages serves a project repo from /<repo>/; dev stays at the root
	base: command === "build" ? "/beanemachine/" : "/",
	plugins: [react(), publishSnapshot()],
	server: {
		port: 5173,
		// the Hono app owns /api; Vite serves the client and proxies through
		proxy: { "/api": { target: API, changeOrigin: true } }
	},
	build: { outDir: "dist", emptyOutDir: true }
}))
