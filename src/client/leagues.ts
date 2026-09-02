import { type } from "arktype"
import { Config, League } from "../schema.ts"
import { ApiError } from "./api.ts"

/**
 * Where a league actually lives: this browser.
 *
 * The committed scoring.json is only a seed. It is read once, on a first visit
 * with nothing stored, so the demo opens on a real league rather than an empty
 * screen — after that it is never read again and never written. Every edit,
 * import and deletion is a write to localStorage, which is what collapses the
 * server/static split: the static build and the local dev server keep league
 * config in exactly the same place, and the only thing still needing a server is
 * scraping a league the browser can't read itself.
 */
export const STORE_KEY = "beanemachine:config"

/** A stored config is as much a source as the API, so its failures surface the same way. */
export class StoreError extends ApiError {}

const parse = (raw: string, source: string): Config => {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new StoreError(`${source} isn't valid JSON: ${(e as Error).message}`)
	}
	const out = Config(parsed)
	if (out instanceof type.errors) throw new StoreError(`${source} isn't a valid config:\n${out}`)
	return out
}

/** Validates before writing, so an invalid config can never reach storage. */
const write = (config: Config): Config => {
	const out = Config(config)
	if (out instanceof type.errors)
		throw new StoreError(`Refusing to store an invalid config:\n${out}`)
	localStorage.setItem(STORE_KEY, JSON.stringify(out))
	return out
}

const read = (): Config | null => {
	const raw = localStorage.getItem(STORE_KEY)
	if (raw === null) return null
	try {
		return parse(raw, `The league config in this browser ("${STORE_KEY}")`)
	} catch (e) {
		// Reseeding would throw away whatever is in there, and no part of it can be
		// repaired by guessing — so say what's wrong and how to replace it.
		throw new StoreError(`${(e as Error).message}\nLoad a scoring.json file to replace it.`)
	}
}

const current = (): Config => {
	const config = read()
	if (!config) throw new StoreError("No league config is stored in this browser yet.")
	return config
}

const load = async (): Promise<Config> => {
	const stored = read()
	if (stored) return stored
	const res = await fetch(`${import.meta.env.BASE_URL}scoring.json`)
	if (!res.ok) throw new StoreError(`Couldn't load the starter scoring.json (HTTP ${res.status}).`)
	return write(parse(await res.text(), "The starter scoring.json"))
}

const save = (key: string, league: League): Config => {
	const config = current()
	return write({ ...config, leagues: { ...config.leagues, [key]: league }, active_league: key })
}

const activate = (key: string): Config => {
	const config = current()
	if (!(key in config.leagues)) throw new StoreError(`No league "${key}".`)
	return write({ ...config, active_league: key })
}

const create = (key: string, template: string): Config => {
	if (!/^[A-Za-z0-9_:.-]+$/.test(key))
		throw new StoreError(`A league key uses only letters, digits, and : _ - .`)
	const config = current()
	if (key in config.leagues) throw new StoreError(`"${key}" already exists.`)
	const draft = structuredClone(
		config.platform_templates[template] ?? config.platform_templates.custom
	) as Record<string, unknown>
	// the template's own prose describes the template, not the league
	delete draft.description
	const league = League(draft)
	if (league instanceof type.errors)
		throw new StoreError(`Template "${template}" is not a valid league:\n${league}`)
	return save(key, league)
}

const remove = (key: string): Config => {
	const config = current()
	if (!(key in config.leagues)) throw new StoreError(`No league "${key}".`)
	const { [key]: _, ...leagues } = config.leagues
	return write({
		...config,
		leagues,
		active_league:
			config.active_league === key ?
				Object.keys(leagues)[0] ?? null
			:	config.active_league
	})
}

/** The download is the stored config verbatim, so a file taken out loads straight back in. */
const download = (config: Config): void => {
	const url = URL.createObjectURL(
		new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" })
	)
	const a = document.createElement("a")
	a.href = url
	a.download = "scoring.json"
	// Firefox only honours a click on an anchor that is actually in the document
	document.body.append(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}

/**
 * Replaces the store outright rather than merging: a file is a whole config, so
 * replacing is the exact inverse of the download and never has to silently pick a
 * winner for a key both sides claim. It is also the way back from a store too
 * broken to read.
 */
const replace = (text: string): Config => write(parse(text, "That file"))

export const leagues = { load, save, activate, create, remove, download, replace }
