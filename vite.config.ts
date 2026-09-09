import react from "@vitejs/plugin-react"
import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
import { defineConfig, type Plugin } from "vite"

const API = "http://127.0.0.1:8000"

/**
 * The two assets a browser cannot get for itself.
 *
 * The snapshot, because browsers can't call MLB or Savant directly — neither sends
 * CORS headers — so the observed data has to ship with the site. And scoring.json,
 * which is what a browser with nothing stored reads on its first visit.
 *
 * That second one carries NO LEAGUES in the deployed build, and that is the change
 * this comment exists for. It used to ship one: a real Yahoo league belonging to a
 * real person, with his scoring, his slots and his team count. Every stranger's
 * first visit was therefore a fully-ranked board denominated in somebody else's
 * points, under a notice explaining that it was — which is the tell. A first visit
 * now opens on `src/client/Onboard.tsx`, which asks for the league instead of
 * lending one.
 *
 * What still ships is `platform_templates`, `stat_keys` and the schema version:
 * the preset a reader can deliberately choose, the canonical stat list, and the
 * shape. None of those is anybody's league.
 */
const publishSnapshot = (): Plugin => ({
	name: "publish-snapshot",
	buildStart: () => {
		copyFileSync("data/snapshot.json", "public/snapshot.json")
		/**
		 * Everything that belongs to whoever ran the importer last is stripped here,
		 * because this is the only place that knows the file is about to become
		 * public.
		 *
		 * `src/cli.ts` writes the free-agent pool, the roster, the lineup AND the
		 * league itself into scoring.json — that is the whole point of the file a
		 * Yahoo user carries to the hosted site. Shipping it wholesale published one
		 * person's team to every stranger who opened the page: measured when it
		 * happened, 150 free agents and 24 rostered players, with the masthead
		 * claiming a wire it had no business having.
		 *
		 * `leagues` goes for the same reason the other three do, and it is the one
		 * that was left in for months — a seeded league is somebody's league however
		 * carefully the page labels it.
		 */
		const seed = JSON.parse(readFileSync("scoring.json", "utf8")) as Record<string, unknown>
		delete seed.pools
		delete seed.rosters
		delete seed.lineups
		seed.leagues = {}
		seed.active_league = null
		writeFileSync("public/scoring.json", JSON.stringify(seed, null, 2) + "\n")
	},
	/**
	 * Running this repo IS the local route, so the dev server serves the real file.
	 *
	 * `src/cli.ts` reads a Yahoo league — settings, free agents, roster and seats —
	 * and writes all of it to `scoring.json` at the repo root. `npx vite` then serves
	 * that, and this middleware is what makes it reachable: `public/scoring.json` is
	 * the league-less asset the deployed site ships, and without this it would shadow
	 * the reader's own file at the same URL.
	 *
	 * Registered inside `configureServer`, which runs before Vite installs its own
	 * static handler, so this wins. It is a dev-only path by construction: there is
	 * no server in the build.
	 */
	configureServer(server) {
		server.middlewares.use("/scoring.json", (_req, res) => {
			res.setHeader("content-type", "application/json")
			res.end(readFileSync("scoring.json"))
		})
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
