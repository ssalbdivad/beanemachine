import { type } from "arktype"
import { Config, League } from "../schema.ts"
import { ApiError } from "./api.ts"
import { lineupStore, type StoredLineup } from "./lineup.ts"
import { roster } from "./roster.ts"

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
const STORE_KEY = "beanemachine:config"

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

/** Every write starts from what is in storage right now: another tab, or a file
 *  loaded since this page rendered, may have moved it out from under us. */
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

/**
 * A key nobody has to be asked for.
 *
 * The key is internal — it names the league in this browser's store and nowhere
 * else — and it used to be collected with a `prompt()`, which is a modal dialog
 * standing between a first-time visitor and a ranked board, and which Chrome
 * suppresses outright in a cross-origin iframe. So one is derived instead, and
 * the league is renamed the way everything else about it is: by editing it.
 */
const suggestKey = (config: Config, template: string): string => {
	const platform =
		(config.platform_templates[template] as { meta?: { platform?: string } } | undefined)?.meta
			?.platform ?? template
	const base = `${platform}:my-league`
	if (!(base in config.leagues)) return base
	// 2 rather than 1, so the second one reads as the second one
	for (let n = 2; ; n++) if (!(`${base}-${n}` in config.leagues)) return `${base}-${n}`
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
	const { [key]: _, ...kept } = config.leagues
	return write({
		...config,
		leagues: kept,
		active_league:
			config.active_league === key ?
				Object.keys(kept)[0] ?? null
			:	config.active_league
	})
}

/**
 * Everything about your leagues that this browser holds, as one file.
 *
 * This is the route in for a Yahoo user, not a backup feature. Yahoo sends no
 * CORS headers, so beanemachine.com cannot read a Yahoo league however hard it
 * tries; a local run can, and the only thing missing was a way to carry what it
 * read to the hosted page. So the file is exactly that carrier, and it has to
 * hold the same things the local run learned:
 *
 * - the leagues themselves, which is what it always held;
 * - `rosters`, which players are yours per league (id:group keys, no player data);
 * - `lineups`, the seat each of them is in, as your platform printed it.
 *
 * The last two live in their own stores (roster.ts, lineup.ts) because they have
 * different lifetimes to a scoring table, and neither can be read from a Yahoo
 * league in a browser at all — so before this, a Yahoo user who ran the importer
 * locally could carry the scoring across and still had no team on the hosted site.
 *
 * Both keys are OPTIONAL and are omitted when empty, so a file downloaded from a
 * browser that has no roster stored is byte-for-byte the shape old files have,
 * and an old file still loads: `Config` ignores keys it does not declare, and the
 * loader below only looks for these two if they are there.
 */
export interface LeagueFile extends Config {
	/** `{ "yahoo:228947": ["592450:hitting", …] }` — ids only, never player data. */
	rosters?: Record<string, string[]>
	lineups?: Record<string, StoredLineup>
}

/** Reads the two team stores for the leagues this config actually names. A roster
 *  whose league is gone is meaningless, so it is not carried. */
const bundle = (config: Config): LeagueFile => {
	const rosters: Record<string, string[]> = {}
	const lineups: Record<string, StoredLineup> = {}
	for (const key of Object.keys(config.leagues)) {
		const held = roster.of(key)
		if (held.length) rosters[key] = held
		const lineup = lineupStore.of(key)
		if (lineup) lineups[key] = lineup
	}
	return {
		...config,
		...(Object.keys(rosters).length ? { rosters } : {}),
		...(Object.keys(lineups).length ? { lineups } : {})
	}
}

/** The download is the stored config verbatim plus the team data above, so a file
 *  taken out loads straight back in. */
const download = (config: Config): LeagueFile => {
	const file = bundle(config)
	const url = URL.createObjectURL(
		new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" })
	)
	const a = document.createElement("a")
	a.href = url
	a.download = "scoring.json"
	// Firefox only honours a click on an anchor that is actually in the document
	document.body.append(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
	return file
}

/** What a loaded file turned out to carry, so the page can say so rather than
 *  claiming a roster arrived when the file held none. */
export interface Loaded {
	config: Config
	leagues: number
	rosters: number
	lineups: number
}

/**
 * Replaces the store outright rather than merging: a file is a whole config, so
 * replacing is the exact inverse of the download and never has to silently pick a
 * winner for a key both sides claim. It is also the way back from a store too
 * broken to read.
 *
 * The team data goes back through roster.ts and lineup.ts's own setters, which
 * validate it against the same shapes they always have — a file with a mangled
 * roster is rejected by the store that owns it, not by a second copy of its rules
 * living here.
 */
const replace = (text: string): Loaded => {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (e) {
		throw new StoreError(`That file isn't valid JSON: ${(e as Error).message}`)
	}
	const config = Config(parsed)
	if (config instanceof type.errors) throw new StoreError(`That file isn't a valid config:\n${config}`)
	// The leagues land first, because they are the payload; the team data is only
	// meaningful once its league exists, and a roster for a league the file does
	// not carry is dropped rather than stored under a key nothing resolves.
	write(config)
	const file = parsed as LeagueFile
	let rosters = 0
	let lineups = 0
	// The leagues are already stored by the time this runs, so a file whose team
	// data is unusable must say that the leagues DID load — reporting it as one
	// failure would send the reader looking for leagues that are in fact there.
	// roster.ts and lineup.ts throw their own errors for a shape they refuse; a
	// `rosters` that is not even an object throws a TypeError here, and both read
	// the same way to whoever dropped the file.
	try {
		for (const [key, held] of Object.entries(file.rosters ?? {})) {
			if (!(key in config.leagues)) continue
			roster.set(key, held)
			rosters++
		}
		for (const [key, lineup] of Object.entries(file.lineups ?? {})) {
			if (!(key in config.leagues)) continue
			lineupStore.set(key, lineup.spots, lineup.at)
			lineups++
		}
	} catch (e) {
		throw new StoreError(
			`The leagues in that file loaded, but its saved team could not be read ` +
				`(${(e as Error).message}). Nothing was invented in its place: read your ` +
				`roster again, or add players by hand.`
		)
	}
	return { config, leagues: Object.keys(config.leagues).length, rosters, lineups }
}

export const leagues = { load, save, activate, create, suggestKey, remove, download, replace }
