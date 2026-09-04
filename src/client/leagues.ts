import { type } from "arktype"
import { Config, League } from "../schema.ts"
import { ApiError } from "./api.ts"
import { lineupStore, type StoredLineup } from "./lineup.ts"
import { pool, type StoredPool } from "./pool.ts"
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

/**
 * Validates before writing, so an invalid config can never reach storage.
 *
 * The three CARRIED keys are stripped on the way in. `Config` preserves keys it
 * does not declare — which is what lets a file hold `rosters`, `lineups` and
 * `pools` at all — but each of those has its own store, and leaving a copy in the
 * config key means two answers to the same question with no rule for which wins.
 * A pool is the one that made it matter: it is the largest of the three and the
 * fastest to go stale, so a stale duplicate riding along in the config would
 * outlive the read it came from and reappear in the next download.
 */
const write = (config: Config): Config => {
	const { rosters: _r, lineups: _l, pools: _p, ...rest } = config as LeagueFile
	const out = Config(rest)
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

/**
 * The seed path, which is also a Yahoo user's LOCAL path.
 *
 * `npx vite` serves the scoring.json that `src/cli.ts` just wrote, and a first
 * visit with nothing stored reads it here. That file now carries a roster, a
 * lineup and a free-agent pool, so this has to install them exactly as a dropped
 * file does — otherwise the two routes into the same file disagree, and the local
 * one, which is the one the reader is standing in front of when they run the
 * command, would be the one that lost the pool.
 */
const load = async (): Promise<Config> => {
	const stored = read()
	if (stored) return stored
	const res = await fetch(`${import.meta.env.BASE_URL}scoring.json`)
	if (!res.ok) throw new StoreError(`Couldn't load the starter scoring.json (HTTP ${res.status}).`)
	const text = await res.text()
	const config = write(parse(text, "The starter scoring.json"))
	carry(JSON.parse(text) as LeagueFile, config)
	return config
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
 * - `lineups`, the seat each of them is in, as your platform printed it;
 * - `pools`, the league's own free-agent list, stamped with when it was read.
 *
 * The last of those is the one that makes the hosted site able to answer the
 * question it exists for. "Which starters should I stream over the next three
 * days" is a question about players you can ADD, and until the pool travelled, the
 * hosted board's answer was headed by four pitchers on other people's rosters:
 * there was no exact availability list to be had, so the ranking simply showed the
 * best players in baseball. `fetchAvailable` in src/data/yahoo-pool.ts reads the
 * real one and a browser can never call it — so it rides here instead.
 *
 * All three live in their own stores (roster.ts, lineup.ts, pool.ts) because they
 * have different lifetimes to a scoring table. A scoring table is true until the
 * commissioner changes it; a lineup is true until you move somebody; a pool is
 * true until anybody in the league clicks Add. That last one is why every pool
 * entry carries `at`: the difference between "these are the free agents" and
 * "these were the free agents at 1:11 PM on Thursday" is the difference between a
 * fact and a claim this app has no right to make.
 *
 * Every key is OPTIONAL and omitted when empty, so a file downloaded from a
 * browser that has none of them is byte-for-byte the shape old files have, and an
 * old file still loads: `Config` preserves keys it does not declare, and the
 * loader below only looks for these three if they are there.
 */
export interface LeagueFile extends Config {
	/** `{ "yahoo:228947": ["592450:hitting", …] }` — ids only, never player data. */
	rosters?: Record<string, string[]>
	lineups?: Record<string, StoredLineup>
	/** `{ "yahoo:228947": { at, leagueId, players, positionsRead, note } }` — the
	 *  league's own wire at a named instant. */
	pools?: Record<string, StoredPool>
}

/**
 * Reads the three side stores for the leagues this config actually names. A roster
 * whose league is gone is meaningless, so it is not carried.
 *
 * The carried keys are stripped off the base config before the fresh ones are put
 * back. `write` already keeps them out of storage, but a config held in React
 * state can still have arrived from a file that had them — and spreading that
 * would republish a pool the store no longer holds, i.e. one the reader had
 * cleared, under a timestamp that made it look current.
 */
const bundle = (config: Config): LeagueFile => {
	const rosters: Record<string, string[]> = {}
	const lineups: Record<string, StoredLineup> = {}
	const pools: Record<string, StoredPool> = {}
	for (const key of Object.keys(config.leagues)) {
		const held = roster.of(key)
		if (held.length) rosters[key] = held
		const lineup = lineupStore.of(key)
		if (lineup) lineups[key] = lineup
		const wire = pool.of(key)
		if (wire) pools[key] = wire
	}
	const { rosters: _r, lineups: _l, pools: _p, ...rest } = config as LeagueFile
	return {
		...rest,
		...(Object.keys(rosters).length ? { rosters } : {}),
		...(Object.keys(lineups).length ? { lineups } : {}),
		...(Object.keys(pools).length ? { pools } : {})
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
	/** How many leagues arrived with an exact free-agent list. Counted from the
	 *  file, never assumed: a file with no pool must not be reported as bringing
	 *  one, because the whole value of the pool is that it is not a guess. */
	pools: number
}

/**
 * Installs the three side stores a file carried, and reports what was actually in
 * it.
 *
 * Shared by both doors — a dropped file and the scoring.json a local `npx vite`
 * seeds from — because two copies of this would be two chances for one door to
 * quietly drop the pool.
 *
 * The data goes back through roster.ts, lineup.ts and pool.ts's own setters, which
 * validate it against the same shapes they always have: a file with a mangled pool
 * is rejected by the store that owns it, not by a second copy of its rules living
 * here. Anything keyed to a league the file does not carry is dropped rather than
 * stored under a key nothing resolves.
 */
const carry = (file: LeagueFile, config: Config): Omit<Loaded, "config" | "leagues"> => {
	let rosters = 0
	let lineups = 0
	let pools = 0
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
	for (const [key, wire] of Object.entries(file.pools ?? {})) {
		if (!(key in config.leagues)) continue
		pool.set(key, wire)
		pools++
	}
	return { rosters, lineups, pools }
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
	// The leagues are already stored by the time this runs, so a file whose team
	// data is unusable must say that the leagues DID load — reporting it as one
	// failure would send the reader looking for leagues that are in fact there.
	// The three stores throw their own errors for a shape they refuse; a `rosters`
	// that is not even an object throws a TypeError inside `carry`, and both read
	// the same way to whoever dropped the file.
	try {
		return {
			config,
			leagues: Object.keys(config.leagues).length,
			...carry(parsed as LeagueFile, config)
		}
	} catch (e) {
		throw new StoreError(
			`The leagues in that file loaded, but the team and free agents it carried ` +
				`could not be read (${(e as Error).message}). Nothing was invented in their ` +
				`place: read them again, or add players by hand.`
		)
	}
}

export const leagues = { load, save, activate, create, suggestKey, remove, download, replace }
