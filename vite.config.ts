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

/**
 * Ask for the snapshot before the bundle has even downloaded.
 *
 * Nothing can be ranked until a 2.1 MB snapshot has arrived, and the request for
 * it used to be issued from a React effect — so it queued behind the bundle's
 * download, parse and first render. Measured on the production build, the fetch
 * did not start until 310 ms in, and the first ranked row painted at 696 ms.
 *
 * This is a CLASSIC script, not a module one: a module is deferred until after
 * the document is parsed, which is exactly the wait being removed. Injected at
 * the top of <head>, it runs on the first byte of markup and the snapshot
 * downloads in parallel with the JS instead of after it. `useSnapshot` picks the
 * promise up; if this script is missing it fetches for itself.
 */
const prefetchSnapshot = (base: string): Plugin => ({
	name: "prefetch-snapshot",
	transformIndexHtml: () => [
		{
			tag: "script",
			injectTo: "head-prepend",
			children:
				`window.__snapshot=fetch(${JSON.stringify(`${base}snapshot.json`)})` +
				`.then(function(r){return r.ok?r.json():Promise.reject(new Error("HTTP "+r.status))});` +
				// The app attaches the handler that reports a failed load when it mounts,
				// which is later than this. This second branch exists only so a failure
				// before then isn't logged as an unhandled rejection — it swallows the
				// report, not the error: the promise the app awaits still rejects.
				`window.__snapshot.catch(function(){})`
		}
	]
})

export default defineConfig(({ command }) => {
	// GitHub Pages serves a project repo from /<repo>/; dev stays at the root
	const base = command === "build" ? "/beanemachine/" : "/"
	return {
		base,
		plugins: [react(), publishSnapshot(), prefetchSnapshot(base)],
		server: {
			port: 5173,
			// the Hono app owns /api; Vite serves the client and proxies through
			proxy: { "/api": { target: API, changeOrigin: true } }
		},
		build: { outDir: "dist", emptyOutDir: true }
	}
})
