import { fetchTeamRoster } from "../data/rosters.ts"
import {
	detect,
	ImportError,
	importableInBrowser,
	importLeague,
	readableInBrowser
} from "../import.ts"
import type { League } from "../schema.ts"

export class ApiError extends Error {}

/**
 * Leagues live in this browser (see leagues.ts), so the two modes differ in one
 * thing: whether there is a server to fall back on.
 *
 * `server` — the Hono API is reachable, so every read goes through it, exactly as
 * it always has.
 *
 * `static` — a build served from somewhere with no backend (GitHub Pages,
 * beanemachine.com). Editing, saving and deleting are unaffected, and ESPN and
 * Sleeper leagues are read by the page itself: both send CORS headers that permit
 * it, measured 2026-09-04 and written down on `readableInBrowser` in src/import.ts.
 * Yahoo sends none, so Yahoo — and Yahoo alone — is what the server is still for.
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
 * sentence names Yahoo rather than "importing", because ESPN and Sleeper import
 * here with no server at all and a blanket claim would be false for them.
 */
const yahooNeedsServer = <T,>(action: string): Promise<T> =>
	Promise.reject(
		new ApiError(
			// The command has to be one that exists: there is no `nub` binary, so the
			// instruction this toast used to give failed for anyone who followed it.
			`${action} needs the local server, because Yahoo sends no CORS headers and a ` +
				`browser can't read it. ESPN and Sleeper leagues import right here. ` +
				`For Yahoo, run \`node src/server.ts\` alongside \`npx vite\`. ` +
				`Your leagues are stored in this browser either way.`
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
 * Server first wherever there is a server: that path is the one every local run and
 * every other suite exercises, and this change is meant to ADD a route, not to
 * reroute the working one. Browser-direct is what a page with no backend does
 * instead of giving up.
 */
export const api = {
	/** Yahoo's free-agent pool, scraped from Yahoo's own pages. There is no
	 *  browser-direct version of this and there cannot be — see `yahooNeedsServer`. */
	available: (leagueId: string): Promise<AvailablePool> =>
		mode === "server" ?
			send<AvailablePool>("/api/available", { leagueId })
		:	yahooNeedsServer<AvailablePool>("Reading your league's free agents"),
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
