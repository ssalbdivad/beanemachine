import react from "@vitejs/plugin-react"
import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
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
		/**
		 * The seed carries SCORING, and nothing that belongs to whoever ran the
		 * importer last.
		 *
		 * `src/cli.ts` writes the free-agent pool, the roster and the lineup into the
		 * same scoring.json — that is the whole point of the file a Yahoo user carries
		 * to the hosted site. But this file is ALSO the asset every first visit is
		 * seeded from, so copying it wholesale shipped one person's roster and their
		 * league's wire to every stranger who opened the page, presented as the demo.
		 * Measured when it happened: 150 free agents and 24 rostered players, and the
		 * masthead told visitors it had read a wire it had no business having.
		 *
		 * The three carried stores are stripped here rather than in the CLI, because
		 * the CLI is right to write them and this is the only place that knows the
		 * file is about to become public.
		 */
		const seed = JSON.parse(readFileSync("scoring.json", "utf8")) as Record<string, unknown>
		delete seed.pools
		delete seed.rosters
		delete seed.lineups
		writeFileSync("public/scoring.json", JSON.stringify(seed, null, 2) + "\n")
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
	/**
	 * Relative, so one build works wherever it is served from.
	 *
	 * This was `/beanemachine/`, the path a GitHub Pages project repo is served
	 * under — which bakes the repo name into every asset URL and means the same
	 * artifact 404s everywhere else. Pointing a custom domain at it would have
	 * served `beanemachine.com` an index.html asking for
	 * `beanemachine.com/beanemachine/assets/…`.
	 *
	 * `./` resolves against the document instead, so the identical build works at
	 * `ssalbdivad.github.io/beanemachine/` AND at the apex of a custom domain, and
	 * moving between them needs no rebuild and leaves no window where one of the
	 * two is broken. The app has no client-side router — the tabs are state, not
	 * paths — so there is no nested URL for a relative base to resolve wrongly
	 * against, which is the one thing that would rule this out.
	 */
	const base = command === "build" ? "./" : "/"
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
