import { arktypeValidator } from "@hono/arktype-validator"
import { type } from "arktype"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { ImportError, importLeague } from "./import.ts"
import { fetchAvailable } from "./data/yahoo-pool.ts"
import { fetchTeamRoster } from "./data/rosters.ts"

/**
 * The API, with nothing node-specific in it, because it has to run somewhere.
 *
 * This lived inside `src/server.ts` next to `@hono/node-server` and a static-file
 * handler, which made it a thing you could only run on your own machine — and that
 * turned the one platform most of this app's users are on into a instruction to open
 * a terminal. Yahoo sends no CORS headers (measured again 2026-09-09: HTTP 200, no
 * `access-control-allow-origin`), so a browser can never read a Yahoo league and a
 * server is the only thing that can. Splitting it out is what lets that server be
 * deployed instead of merely run.
 *
 * Nothing is stored here. Leagues, rosters and seats live in the reader's own
 * browser; this process reads public league pages on his behalf and hands the result
 * straight back.
 */

const ImportBody = type({ url: "string > 0" })

/**
 * The free-agent pool changes slowly and Yahoo rate-limits, so cache it briefly
 * rather than re-scraping on every page load.
 *
 * In-memory, which on a serverless host means per-instance and cold-started away.
 * That is a weaker cache than it looks and it is deliberately not more: a shared
 * cache would mean storing other people's league contents somewhere, which this
 * project does not do for a ten-minute speedup.
 */
const POOL_TTL = 10 * 60_000
const poolCache = new Map<string, { at: number; pool: unknown }>()

/**
 * Who may call this, and how often.
 *
 * What is worth protecting is not this process — it is the OUTBOUND scraping of
 * somebody else's site. A deployed endpoint that fetches Yahoo on request is an
 * invitation to be used as a scraper, and the cost of that lands on Yahoo and then
 * on this app's own access.
 *
 * So the budget counts the requests that actually reach Yahoo, and nothing else. The
 * first version counted every request, including health probes and cache hits, and
 * the app's own ordinary navigation — board, trade, draft, back — spent it in
 * seconds: a user got 429s for using the site normally. Caught by test/journey.mjs
 * failing intermittently, which is the shape a rate limit that is too tight always
 * takes.
 *
 * The unknown-address case is the one that would have been a genuine outage. Behind
 * a platform proxy there is an `x-forwarded-for`; anywhere else there is not, and
 * bucketing everyone under one "unknown" key turns a per-user limit into a global
 * one — thirty requests a minute for the whole site, shared, and the thirty-first
 * visitor is refused because of the first thirty. Unknown addresses now get their
 * own much larger ceiling, which still stops a single script and cannot take the
 * site down for everybody.
 */
const ALLOWED_ORIGINS = [
	"https://beanemachine.com",
	"https://www.beanemachine.com",
	"https://ssalbdivad.github.io"
]
const WINDOW = 60_000
/** Per address, sized to be invisible to a person and to bite a script. Reading one
 *  league costs one; the app re-reads a pool at most every ten minutes. */
const PER_ADDRESS = 20
/** The shared bucket for requests with no usable address. Deliberately far larger:
 *  its job is to stop a runaway, not to ration real visitors who cannot be told
 *  apart. */
const PER_UNKNOWN = 400
const hits = new Map<string, { at: number; n: number }>()

/** Only called where a request is about to reach Yahoo — see the middleware. */
const overBudget = (who: string, ceiling: number): boolean => {
	const now = Date.now()
	const seen = hits.get(who)
	if (!seen || now - seen.at > WINDOW) {
		hits.set(who, { at: now, n: 1 })
		// the map is the only thing that grows here, so it is swept rather than left
		if (hits.size > 5_000)
			for (const [k, v] of hits) if (now - v.at > WINDOW) hits.delete(k)
		return false
	}
	seen.n++
	return seen.n > ceiling
}

export const app = new Hono()

/**
 * Cross-origin, because the page and this API are not on the same host: the site is
 * static on GitHub Pages at beanemachine.com and this runs wherever it is deployed.
 * A localhost origin is admitted too, which is what `npx vite` serves the client on.
 */
app.use(
	"/api/*",
	cors({
		origin: o =>
			!o || ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o) ?
				(o ?? "*")
			:	"",
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["content-type"],
		maxAge: 86_400
	})
)

/**
 * The budget, applied to the routes that actually reach Yahoo.
 *
 * `/health` is exempt: it is a probe, it touches nothing outside this process, and
 * counting it meant a page load could spend budget before the reader had asked for
 * anything. `/available` and `/roster` and `/import` are the ones that leave.
 */
app.use("/api/:route{available|roster|import}", async (c, next) => {
	if (c.req.method === "OPTIONS") return next()
	const address =
		c.req.header("cf-connecting-ip") ??
		c.req.header("x-real-ip") ??
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
		null
	const ceiling = address ? PER_ADDRESS : PER_UNKNOWN
	if (overBudget(address ?? "unknown", ceiling))
		return c.json(
			{
				error:
					`Too many league reads from here — ${ceiling} a minute is the limit. This ` +
					`endpoint reads pages off Yahoo on your behalf and the cost of going faster ` +
					`lands on them. Wait a minute and try again.`
			},
			429
		)
	return next()
})

/** Our own errors are guidance; anything else is a bug and stays a 500. */
app.onError((e, c) => {
	if (e instanceof ImportError) return c.json({ error: e.message }, 400)
	console.error(e)
	return c.json({ error: `${e.name}: ${e.message}` }, 500)
})

const api = new Hono()
	// how the client tells a served build from a local one: on a static host there
	// is no JSON here, so the client reads ESPN for itself and says that Yahoo,
	// which sends no CORS headers, is what still needs this process
	.get("/health", c => c.json({ ok: true }))

	// read from the league's own pages and handed straight back: the browser is
	// what stores it, so nothing about this league is kept here
	.post("/import", arktypeValidator("json", ImportBody), async c =>
		c.json(await importLeague(c.req.valid("json").url))
	)

	.post("/available", arktypeValidator("json", type({ leagueId: "string > 0" })), async c => {
		// Browsers can't read Yahoo directly (no CORS headers), and the pool is Yahoo
		// only, so this endpoint has no browser-direct counterpart at all.
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
	 * The Yahoo read here is the one a browser cannot do for itself. The ESPN read it
	 * CAN do (`fetchTeamRoster` is the same function either side of the wire) stays
	 * served from here for anyone running locally, because a request that already
	 * works is not worth rerouting. Nothing is stored — the browser owns the roster,
	 * exactly as it owns the league.
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
			// Yahoo and ESPN both key a league on a short alphanumeric id. The
			// per-platform exemption this used to carry existed only for Sleeper's
			// 18-digit ids, and Sleeper is gone (see SLEEPER_REFUSAL in src/import.ts).
			if (!/^[\w-]{1,32}$/.test(body.leagueId))
				throw new ImportError("That doesn't look like a league id.")
			// An unreadable roster is a state, not an error: the league may be private
			// or the platform may be throttling, and the client offers the manual path
			// either way rather than logging a failed request.
			return c.json(await fetchTeamRoster(body))
		}
	)

app.route("/api", api)

export type Api = typeof api
export default app
