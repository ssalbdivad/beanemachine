import type { Config, League } from "../schema.ts"

export class ApiError extends Error {}

/**
 * The app runs in two modes.
 *
 * `server` — the Hono API is reachable, so imports scrape live leagues and saves
 * write scoring.json on disk.
 *
 * `static` — a build served from somewhere with no backend (GitHub Pages). The
 * committed scoring.json is loaded as an asset, edits stay in the browser, and
 * saving downloads the file. Importing is impossible here regardless of hosting:
 * Yahoo and ESPN send no CORS headers, so a browser cannot read them.
 */
export type Mode = "server" | "static"

let mode: Mode = "server"
export const getMode = (): Mode => mode

const send = async <T,>(path: string, body?: unknown): Promise<T> => {
	const res = await fetch(path, {
		method: body ? "POST" : "GET",
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined
	})
	if (!res.headers.get("content-type")?.includes("application/json"))
		throw new ApiError(`No API at ${path}.`)
	const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
	if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`)
	return data as T
}

const staticOnly = (action: string): never => {
	throw new ApiError(
		`${action} needs the local server — this is the static build. ` +
			`Run it with \`nub run dev\` to import leagues and write scoring.json.`
	)
}

type ConfigReply = { key?: string; config: Config }

/** Falls back to the committed scoring.json when no API answers. */
export const loadConfig = async (): Promise<Config> => {
	try {
		const config = await send<Config>("/api/config")
		mode = "server"
		return config
	} catch {
		mode = "static"
		const res = await fetch(`${import.meta.env.BASE_URL}scoring.json`)
		if (!res.ok) throw new ApiError("Couldn't load scoring.json.")
		return (await res.json()) as Config
	}
}

export const downloadConfig = (config: Config): void => {
	const url = URL.createObjectURL(
		new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" })
	)
	const a = document.createElement("a")
	a.href = url
	a.download = "scoring.json"
	a.click()
	URL.revokeObjectURL(url)
}

export interface AvailablePool {
	players: { yahooId: string; name: string; team: string | null; positions: string[] }[]
	positionsRead: string[]
	note: string
}

export const api = {
	available: (leagueId: string) =>
		mode === "static" ?
			staticOnly("Reading your league's free agents")
		:	send<AvailablePool>("/api/available", { leagueId }),
	config: loadConfig,
	import: (url: string) =>
		mode === "static" ? staticOnly("Importing a league") : send<ConfigReply>("/api/import", { url }),
	save: (key: string, league: League) => send<ConfigReply>("/api/save", { key, league }),
	activate: (key: string) => send<ConfigReply>("/api/activate", { key }),
	create: (key: string, template: string) =>
		mode === "static" ? staticOnly("Creating a league") : send<ConfigReply>("/api/new", { key, template }),
	remove: (key: string) =>
		mode === "static" ? staticOnly("Removing a league") : send<ConfigReply>("/api/delete", { key })
}
