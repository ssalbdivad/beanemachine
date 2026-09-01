import react from "@vitejs/plugin-react"
import { copyFileSync } from "node:fs"
import { defineConfig, type Plugin } from "vite"

const API = "http://127.0.0.1:8000"

/** The static build reads the committed scoring.json as an asset. */
const publishConfig = (): Plugin => ({
	name: "publish-scoring-json",
	buildStart: () => copyFileSync("scoring.json", "public/scoring.json")
})

export default defineConfig(({ command }) => ({
	// GitHub Pages serves a project repo from /<repo>/; dev stays at the root
	base: command === "build" ? "/beanemachine/" : "/",
	plugins: [react(), publishConfig()],
	server: {
		port: 5173,
		// the Hono app owns /api; Vite serves the client and proxies through
		proxy: { "/api": { target: API, changeOrigin: true } }
	},
	build: { outDir: "dist", emptyOutDir: true }
}))
