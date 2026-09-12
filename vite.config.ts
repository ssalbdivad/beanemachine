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
		/**
		 * The contact file, served straight out of `data/` in dev.
		 *
		 * Same URL the build serves it at, so the client has one path for both modes —
		 * see `emitFile` below for why it is not simply copied into `public/` next to
		 * the snapshot.
		 */
		server.middlewares.use("/contact.json", (_req, res) => {
			res.setHeader("content-type", "application/json")
			res.end(readFileSync("data/contact.json"))
		})
	},
	/**
	 * EMITTED as a build asset rather than copied into `public/`, which is how the
	 * snapshot gets there — and the difference is not taste.
	 *
	 * `public/snapshot.json` needs a line in .gitignore to stop a generated copy of
	 * committed evidence being committed a second time, and it has one. The next
	 * generated file written into `public/` did not get that line and is in the repo
	 * now: `git ls-files public/` returns `public/scoring.json`, which `buildStart`
	 * above writes on every build, and `git check-ignore -v public/scoring.json`
	 * matches nothing. So the copy-into-public route has already leaked one build
	 * artifact into git history, and .gitignore still opens with a comment about a
	 * pattern that is no longer under it.
	 *
	 * Emitting skips `public/` entirely: the bytes go from `data/contact.json` into
	 * `dist/contact.json` and nothing appears in the working tree for `git add -A` to
	 * sweep up. Unhashed filename on purpose — the client asks for it by name at
	 * runtime, and the pair is kept honest by `capturedAt` inside the file rather than
	 * by the URL (see `Contact` in src/data/snapshot.ts).
	 */
	generateBundle() {
		this.emitFile({
			type: "asset",
			fileName: "contact.json",
			source: readFileSync("data/contact.json")
		})
	}
})

/**
 * Ask for the snapshot before the bundle has even downloaded.
 *
 * Nothing can be ranked until the snapshot has arrived, and the request for
 * it used to be issued from a React effect — so it queued behind the bundle's
 * download, parse and first render. Measured on the production build, the fetch
 * did not start until 310 ms in, and the first ranked row painted at 696 ms.
 *
 * This is the request the Statcast split is about. It asks for the WHOLE file before
 * a single row can paint, so every byte in the snapshot is on the cold critical path
 * whether or not a ranking needs it — and 299,764 of the 1,337,218 committed bytes
 * (22.42%, 48,743 of 180,667 gzipped at level 9) were expected-stats rows that steer
 * no ranking at all. They are `data/contact.json` now, fetched by `useContact` only
 * when a reader opens a drill-down, and deliberately NOT prefetched here: a second
 * request issued from this script would put the same bytes back on the same path.
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
			/**
			 * 5299, pinned, because 5173 on the author's machine is a DIFFERENT LIVE APP.
			 *
			 * This said `port: 5173` — Vite's default, and the one port here that must not
			 * be used. Another application of the author's listens on it and answers 200
			 * with a working site that is not this one, so the failure mode is not a
			 * connection refused anybody would notice: Vite finds 5173 taken, silently
			 * steps to 5174, and every test, script and instruction aimed at "the dev
			 * server" reaches the neighbour and reads its markup instead. That is why
			 * every browser suite in test/ hardcodes `http://127.0.0.1:5299` and why each
			 * one reads the wordmark before its first assertion — they were written around
			 * this config rather than with it, and README.md told a reader to pass
			 * `--port 5299 --strictPort` by hand for the same reason. A workaround repeated
			 * in three places is a default in the wrong place.
			 *
			 * `strictPort` is the other half and is the point. Without it Vite's fallback
			 * is exactly the behaviour being prevented — a server that comes up on some
			 * other port and lets the suites talk to whatever is on 5299. With it, a port
			 * already in use is a startup failure, which is the honest outcome: either
			 * this app owns 5299 or nothing is served. A hardcoded port is usually a smell;
			 * it is correct here because the tests address the dev server by number and an
			 * unpredictable one would make them address a stranger.
			 */
			port: 5299,
			strictPort: true,
			// the Hono app owns /api; Vite serves the client and proxies through
			proxy: { "/api": { target: API, changeOrigin: true } }
		},
		build: { outDir: "dist", emptyOutDir: true }
	}
})
