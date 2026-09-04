import { fetchEspnPool, fetchTeamRoster } from "../data/rosters.ts"
import {
	detect,
	ImportError,
	importableInBrowser,
	importLeague,
	readableInBrowser
} from "../import.ts"
import type { League } from "../schema.ts"
import { pool as poolStore, since, type StoredPool } from "./pool.ts"

export class ApiError extends Error {}

/**
 * Leagues live in this browser (see leagues.ts), so the two modes differ in one
 * thing: whether there is a server to fall back on.
 *
 * `server` — the Hono API is reachable, so every read goes through it, exactly as
 * it always has.
 *
 * `static` — a build served from somewhere with no backend (GitHub Pages,
 * beanemachine.com). Editing, saving and deleting are unaffected, and an ESPN
 * league is read by the page itself: ESPN sends CORS headers that permit it,
 * measured 2026-09-04 and written down on `readableInBrowser` in src/import.ts.
 * Sleeper does too and the code still reads it, but Sleeper runs no fantasy
 * baseball, so this app no longer offers it as a way in — see the template list in
 * scoring.json. Yahoo sends no such headers at all, so a Yahoo league arrives here
 * either as the preset or as a file read on your own machine.
 */
export type Mode = "server" | "static"

let mode: Mode = "server"
export const getMode = (): Mode => mode

/** Whether the page can read this platform for itself, which is the only question
 *  the UI needs to answer before offering to import or to read a roster. In
 *  `server` mode everything is readable because the server reads it. */
export const canRead = (platform: string): boolean =>
	mode === "server" || readableInBrowser(platform)

/** The same question for a URL the user has pasted but not yet submitted. An
 *  unrecognized URL is not readable here either; `importLeague` names why. */
export const canImport = (url: string): boolean =>
	mode === "server" || importableInBrowser(url)

/**
 * Every API path is resolved against the deployed base, not against the origin
 * root.
 *
 * On GitHub Pages the app is served from /beanemachine/, and a bare "/api/health"
 * probed ssalbdivad.github.io/api/health — a different path entirely, which
 * 404ed and made the app fall back to static mode for the wrong reason. It
 * happened to reach the right answer here because there is no API either way,
 * which is exactly why nothing noticed.
 */
const resolve = (path: string): string =>
	`${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`

const send = async <T,>(path: string, body?: unknown): Promise<T> => {
	const res = await fetch(resolve(path), {
		method: body ? "POST" : "GET",
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined
	})
	if (!res.headers.get("content-type")?.includes("application/json"))
		throw new ApiError(`No API at ${resolve(path)}.`)
	const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
	if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`)
	return data as T
}

/** Asked once at startup, because nothing else reveals the mode any more: config
 *  no longer comes from the API, so a page can now go its whole life without
 *  calling one. */
export const detectMode = async (): Promise<Mode> => {
	mode = await send<{ ok: true }>("/api/health").then(
		() => "server" as const,
		() => "static" as const
	)
	return mode
}

/**
 * Rejects rather than throwing. Throwing synchronously means a caller's `.catch()`
 * never gets attached, so the error escapes as an unhandled exception — which took
 * the whole static build's render down until this was fixed.
 *
 * Reached only for Yahoo now, and for the free-agent pool, which is Yahoo-only. The
 * sentence names Yahoo rather than "importing", because ESPN imports here with no
 * server at all and a blanket claim would be false for it.
 *
 * It also has to end somewhere other than a dead end, which is what it was: a
 * Yahoo user was told to go and run a server, on a page they had opened precisely
 * because they were not going to run anything. So the FILE route leads — read the
 * league once on your own machine, carry the file back — and the server is named
 * second, as the live version of the same thing. Sleeper is not offered at all any
 * more: it runs no fantasy baseball, so naming it here was padding a refusal with
 * a platform that cannot help.
 */
const yahooNeedsServer = <T,>(action: string): Promise<T> =>
	Promise.reject(
		new ApiError(
			// Every command named here has to be one that exists. `nub` is not installed
			// on a machine that just cloned this repo, and this toast used to name it.
			`${action} can't be done from this page: Yahoo sends no CORS headers, so a ` +
				`browser is never handed the response. ESPN leagues do import right here. ` +
				`For Yahoo, read it once on your own machine — ` +
				`\`node --experimental-strip-types src/cli.ts <your league URL>\` — then press ` +
				`Download and drop that file onto this page. Running the local server does ` +
				`the same job live. Your leagues are stored in this browser either way.`
		)
	)

/**
 * A read the page does for itself, with the two failures a user can act on kept
 * apart. `ImportError` is guidance the importer wrote (a private league, a URL with
 * no leagueId) and is passed through verbatim, exactly as the server relays it. A
 * `TypeError` from fetch is the browser refusing to hand over a cross-origin
 * response, or the network being down, and reads as neither on its own.
 */
const direct = async <T,>(what: string, read: () => Promise<T>): Promise<T> => {
	try {
		return await read()
	} catch (e) {
		if (e instanceof ImportError) throw new ApiError(e.message)
		throw new ApiError(
			`${what} failed in your browser (${(e as Error).message}). The league may be ` +
				`private, or something on this network — an extension, a proxy — may be ` +
				`blocking the request.`
		)
	}
}

export interface AvailablePool {
	players: { yahooId: string; name: string; team: string | null; positions: string[] }[]
	positionsRead: string[]
	note: string
	/**
	 * ISO instant this list was read off the league, when it is known.
	 *
	 * Present only on a pool CARRIED IN from a local run, because that is the only
	 * one whose age can differ from now: a server read happens while you wait.
	 * Absent means "read just now by the server", never "age unknown" — the two
	 * would be opposite claims and the UI treats them as such.
	 */
	readAt?: string
}

export interface YahooRoster {
	players: {
		yahooId: string
		name: string
		/** The seat the platform has him in — what the add/drop planner reasons over. */
		slot: string | null
		/** Eligibility as YOUR league prints it, the one place the real
		 *  multi-position line is readable. */
		positions: string[]
		team: string | null
	}[]
	note: string
}

/**
 * A pool that arrived in a file, presented as what it is.
 *
 * The note is what the board hangs on its "Free agents only" control, so it is the
 * one sentence that has to be exactly true: this list is EXACT — it is the league's
 * own wire, not an inference from ownership percentages — and it is OLD, by a
 * stated amount. Both halves matter. Dropping the first would waste the only
 * unambiguous availability signal this app can get; dropping the second would let a
 * pool read last Tuesday pass for today's.
 *
 * The reader's own note travels underneath, unedited, because it is the thing that
 * knows what was actually swept.
 */
const fromCarried = (carried: StoredPool, why?: string): AvailablePool => ({
	players: carried.players,
	positionsRead: carried.positionsRead,
	readAt: carried.at,
	note:
		`${why ? `${why} ` : ""}Using the exact free-agent list carried in from a local ` +
		`read of your league, taken ${since(carried.at, Date.now()).label} ` +
		`(${carried.at}). ${carried.players.length} players. Anyone added or dropped in ` +
		`your league since then is not in it — read it again to refresh. ${carried.note}`
})

/**
 * Server first wherever there is a server: that path is the one every local run and
 * every other suite exercises, and this change is meant to ADD a route, not to
 * reroute the working one. Browser-direct is what a page with no backend does
 * instead of giving up.
 */
export const api = {
	/**
	 * Yahoo's free-agent pool. No browser can read it — see `yahooNeedsServer` —
	 * so there are exactly two places it can come from, and both are tried.
	 *
	 * Server first, because a server read is happening NOW and a carried one
	 * happened whenever the reader last ran the command. Where there is no server,
	 * or where the server's own read failed (a private league, Yahoo throttling),
	 * the file a local run carried over is served instead, stamped with the time it
	 * was read so nothing downstream can present it as live.
	 *
	 * This is what makes "which starters can I stream this week" answerable at
	 * beanemachine.com. The board has always preferred an exact pool to the
	 * ownership estimate; on the hosted build there was simply never one to prefer,
	 * so the list it opened on was headed by four pitchers already on rosters.
	 */
	/**
	 * `leagueId` alone was enough while Yahoo was the only platform this could read.
	 * ESPN needs its season too, and knowing the platform is what lets an ESPN league
	 * skip the server entirely.
	 */
	available: async (
		leagueId: string,
		league?: { platform?: string | null; season?: string | number | null; sport?: string | null }
	): Promise<AvailablePool> => {
		/**
		 * ESPN's own free-agent list, read straight from the page.
		 *
		 * Measured: ESPN answers the preflight for `x-fantasy-filter` and reflects our
		 * origin, so the one read Yahoo can never do without a local run — who is
		 * actually available in YOUR league — an ESPN user gets on the hosted site with
		 * no server at all. Tried before the server precisely because it needs no
		 * server: a live read beats a proxied one, and it is the same read either way.
		 */
		const season = Number(league?.season)
		if (league?.platform === "espn" && Number.isFinite(season)) {
			const pool = await fetchEspnPool(leagueId, season, league.sport ?? "flb")
			if (pool.players.length)
				return {
					players: pool.players.map((x: { yahooId: string; name: string; team: string | null; positions: string[] }) => ({
						yahooId: x.yahooId, name: x.name, team: x.team, positions: x.positions
					})),
					positionsRead: pool.positionsRead,
					note: pool.note
				}
			// an empty read is a state, not an answer: fall through to whatever else
			// this build can offer rather than reporting a league with no free agents
		}
		if (mode === "server")
			try {
				return await send<AvailablePool>("/api/available", { leagueId })
			} catch (e) {
				const carried = poolStore.byLeagueId(leagueId)
				// the server's own message is the better one when there is no fallback
				if (!carried) throw e
				return fromCarried(carried, `The local server could not read it (${(e as Error).message}).`)
			}
		const carried = poolStore.byLeagueId(leagueId)
		return carried ? fromCarried(carried)
			:	yahooNeedsServer<AvailablePool>("Reading your league's free agents")
	},
	/** The team's roster read off its own league. Empty is a state — a private league
	 *  or a throttled read — and the caller offers the manual path. */
	roster: (body: {
		platform: string
		leagueId: string
		teamId: string
		sport?: string
		season?: number
	}): Promise<YahooRoster> =>
		mode === "server" ? send<YahooRoster>("/api/roster", body)
		: readableInBrowser(body.platform) ?
			// fetchTeamRoster reports an unreadable roster as `{ players: [], note }`
			// rather than throwing, so there is nothing here for `direct` to translate.
			fetchTeamRoster(body)
		:	yahooNeedsServer<YahooRoster>("Reading your roster"),
	/** Returns the scraped league for the browser to store; the server keeps nothing,
	 *  and on the static build there is no server to keep it. */
	import: (url: string): Promise<{ key: string; league: League }> => {
		if (mode === "server") return send<{ key: string; league: League }>("/api/import", { url })
		// `detect` names an unrecognized URL better than anything here could, and it is
		// the same sentence the server relays. Naming Yahoo below would be a lie about a
		// URL that is not a league URL at all, which is how this used to read.
		let platform: string
		try {
			platform = detect(url).platform
		} catch (e) {
			return Promise.reject(new ApiError((e as Error).message))
		}
		return readableInBrowser(platform) ?
				direct("Importing that league", () => importLeague(url))
			:	yahooNeedsServer<{ key: string; league: League }>("Importing a Yahoo league")
	}
}
