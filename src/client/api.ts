import type { League } from "../schema.ts"

export class ApiError extends Error {}

/**
 * Leagues live in this browser (see leagues.ts), so the two modes now differ in
 * exactly one thing: whether there is a server to read a real league with.
 *
 * `server` — the Hono API is reachable, so a league can be imported from its URL
 * and its free-agent pool read.
 *
 * `static` — a build served from somewhere with no backend (GitHub Pages).
 * Editing, saving and deleting are unaffected. Reading a league is impossible
 * here regardless of hosting: Yahoo and ESPN send no CORS headers, so a browser
 * cannot fetch them.
 */
export type Mode = "server" | "static"

let mode: Mode = "server"
export const getMode = (): Mode => mode

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
 */
const staticOnly = <T,>(action: string): Promise<T> =>
	Promise.reject(
		new ApiError(
			`${action} needs the local server — this is the static build. ` +
				`Run it with \`nub run dev\`. Your leagues are stored in this browser either way.`
		)
	)

export interface AvailablePool {
	players: { yahooId: string; name: string; team: string | null; positions: string[] }[]
	positionsRead: string[]
	note: string
}

export const api = {
	available: (leagueId: string): Promise<AvailablePool> =>
		mode === "static" ?
			staticOnly<AvailablePool>("Reading your league's free agents")
		:	send<AvailablePool>("/api/available", { leagueId }),
	/** Returns the scraped league for the browser to store; the server keeps nothing. */
	import: (url: string): Promise<{ key: string; league: League }> =>
		mode === "static" ?
			staticOnly<{ key: string; league: League }>("Importing a league")
		:	send<{ key: string; league: League }>("/api/import", { url })
}
