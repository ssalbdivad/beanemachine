import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { arktypeValidator } from "@hono/arktype-validator"
import { type } from "arktype"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import { ImportError, importLeague } from "./import.ts"
import { fetchAvailable } from "./data/yahoo-pool.ts"
import { fetchTeamRoster } from "./data/rosters.ts"

/**
 * The API is now only what a browser genuinely cannot do for itself: read a
 * league's own pages. Leagues live in the browser's storage, so nothing here
 * reads or writes scoring.json and the static build behaves identically.
 *
 * Request bodies are still validated at the edge, so a malformed call is
 * rejected with a real error message rather than reaching a scraper.
 */
const ImportBody = type({ url: "string > 0" })

/** The free-agent pool changes slowly and Yahoo rate-limits, so cache it briefly
 *  rather than re-scraping on every page load. */
const POOL_TTL = 10 * 60_000
const poolCache = new Map<string, { at: number; pool: unknown }>()

const app = new Hono()

/** Our own errors are guidance; anything else is a bug and stays a 500. */
app.onError((e, c) => {
	if (e instanceof ImportError) return c.json({ error: e.message }, 400)
	console.error(e)
	return c.json({ error: `${e.name}: ${e.message}` }, 500)
})

const api = new Hono()
	// how the client tells a served build from a local one: on a static host there
	// is no JSON here, so importing is off and the banner says why
	.get("/health", c => c.json({ ok: true }))

	// read from the league's own pages and handed straight back: the browser is
	// what stores it, so nothing about this league is kept here
	.post("/import", arktypeValidator("json", ImportBody), async c =>
		c.json(await importLeague(c.req.valid("json").url))
	)

	.post("/available", arktypeValidator("json", type({ leagueId: "string > 0" })), async c => {
		// Browsers can't read Yahoo directly (no CORS headers), so the pool is
		// fetched here and handed to the client.
		const { leagueId } = c.req.valid("json")
		if (!/^\d+$/.test(leagueId)) throw new ImportError("A numeric Yahoo league id is required.")
		// An empty pool is a STATE, not an error: the league may be private, or Yahoo
		// may be rate-limiting. Returning 400 made the browser log a failed request on
		// every load. The client shows the filter disabled with this note instead.
		const cached = poolCache.get(leagueId)
		if (cached && Date.now() - cached.at < POOL_TTL) return c.json(cached.pool)
		const pool = await fetchAvailable(leagueId)
		if (!pool.players.length)
			return c.json({
				players: [],
				positionsRead: [],
				note:
					"Couldn't read this league's free agents. Only publicly-viewable Yahoo " +
					"leagues can be read without signing in, and Yahoo rate-limits repeated " +
					"requests — try again in a few minutes."
			})
		poolCache.set(leagueId, { at: Date.now(), pool })
		return c.json(pool)
	})

	/**
	 * A team's own roster, off its own Yahoo page.
	 *
	 * Same footing as /available: browsers cannot read Yahoo directly, so the fetch
	 * happens here and the names are handed back. Nothing is stored — the browser
	 * owns the roster, exactly as it owns the league.
	 */
	.post(
		"/roster",
		arktypeValidator(
			"json",
			type({
				platform: "string > 0",
				leagueId: "string > 0",
				teamId: "string > 0",
				"sport?": "string",
				"season?": "number"
			})
		),
		async c => {
			const body = c.req.valid("json")
			// Sleeper's roster and owner ids are not always numeric, so the shape is
			// checked per platform rather than globally.
			if (body.platform !== "sleeper" && !/^[\w-]{1,32}$/.test(body.leagueId))
				throw new ImportError("That doesn't look like a league id.")
			// An unreadable roster is a state, not an error: the league may be private
			// or the platform may be throttling, and the client offers the manual path
			// either way rather than logging a failed request.
			return c.json(await fetchTeamRoster(body))
		}
	)

app.route("/api", api)

/** In dev Vite serves the client and proxies here; in prod we serve its build. */
const DIST = "./dist"
if (existsSync(DIST)) {
	app.use("/*", serveStatic({ root: DIST }))
	app.get("*", serveStatic({ path: `${DIST}/index.html` }))
}

export type Api = typeof api
export default app

const port = Number(process.argv.find(a => a.startsWith("--port="))?.slice(7) ?? 8000)
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, info => {
	console.log(`beanemachine api → http://localhost:${info.port}`)
	console.log(`leagues           kept in your browser; this only reads them from their URL`)
	if (!existsSync(DIST)) console.log(`client            run \`nub run dev\` (Vite serves it)`)
})
