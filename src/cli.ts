import { readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, saveConfig } from "./config.ts"
import { fetchAvailable, fetchRoster, normalizeName } from "./data/yahoo-pool.ts"
import { ImportError, importLeague } from "./import.ts"
import type { League } from "./schema.ts"

/**
 * Read one league — its settings, its free agents and your team — and write the
 * lot into scoring.json.
 *
 * This is the ONLY route to a Yahoo league, and Yahoo is the platform most of this
 * app's users are on. Measured 2026-09-04: Yahoo sends no `access-control-allow-*`
 * headers on any of the pages this reads, so a browser is never handed the
 * response body — the hosted build at beanemachine.com cannot import a Yahoo
 * league, cannot read your roster and cannot list your free agents, and never will
 * be able to. Running this once is what a Yahoo user does instead, and the file it
 * writes is portable: drop it on beanemachine.com and `leagues.replace` loads it.
 *
 * It used to write the league SETTINGS and nothing else, which is why the hosted
 * site could rank all of baseball for your scoring and still not answer the
 * question people actually open it with — "which starters can I stream this week"
 * is a question about the players you can ADD, and the answer lived on a machine
 * that never sent it anywhere. So the three reads happen together now, in one
 * command, because they come off the same league and the reader should not have to
 * learn that they are three things.
 *
 * The usage line used to read `usage: nub src/cli.ts <league-url>`. `nub` is the
 * author's own TypeScript runner and is not installed on a machine that just cloned
 * this repo, so the one instruction printed by the one tool a Yahoo user has to run
 * was a command that does not exist. It names node's own type-stripping flag now,
 * which is what every other script here already runs under.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SELF = relative(process.cwd(), join(ROOT, "src/cli.ts")) || "src/cli.ts"
const RUN = `node --experimental-strip-types ${SELF}`
const CONFIG = join(ROOT, "scoring.json")
const SNAPSHOT = join(ROOT, "data/snapshot.json")

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const url = args.find(a => !a.startsWith("-"))

if (flag("--help") || flag("-h") || !url) {
	const missing = !url && !flag("--help")
	console[missing ? "error" : "log"](
		`${missing ? "No league URL given.\n\n" : ""}usage: ${RUN} <league-url> [--settings-only]\n` +
			`\n` +
			`Reads a league and writes it into scoring.json, then makes it the active\n` +
			`league. Nothing is invented: whatever the source does not state is left blank\n` +
			`and listed under "needs review".\n` +
			`\n` +
			`Three reads, one command. For a Yahoo league it also reads:\n` +
			`  · the FREE AGENTS in your league, which is the list "who should I stream"\n` +
			`    is actually a question about. No browser can read it, so carrying this\n` +
			`    file is the only way beanemachine.com ever sees it.\n` +
			`  · your ROSTER and the seat each man is in, so the add/drop planner and the\n` +
			`    trade verdict have a team to reason about.\n` +
			`Both are stamped with the time they were read, and the app says how old they\n` +
			`are rather than showing them as live. --settings-only skips them.\n` +
			`\n` +
			`  Yahoo  https://baseball.fantasysports.yahoo.com/b1/<league>/<team>\n` +
			`         The only way in. Yahoo sends no CORS headers, so no browser can\n` +
			`         read it — this command can, and beanemachine.com cannot.\n` +
			`  ESPN   https://fantasy.espn.com/baseball/league?leagueId=<id>&teamId=<id>\n` +
			`         Works here and equally well in the browser, which reads ESPN itself,\n` +
			`         roster included. Only the settings are read here.\n` +
			`\n` +
			`The league must be publicly viewable; a private one needs a signed-in session\n` +
			`this has no way to hold. Sleeper is not supported — it runs no fantasy\n` +
			`baseball at all.\n` +
			`\n` +
			`Then: drop the file it prints onto beanemachine.com — anywhere on the page —\n` +
			`or run \`npx vite\` and it seeds from scoring.json directly.`
	)
	process.exit(missing ? 1 : 0)
}

/** The four values the engine needs before it can rank anything, checked out loud.
 *  An import that silently produced none of them is what made "new league from a
 *  template" useless, and a summary that only counted rows would have hidden it. */
const readiness = (league: League): { ok: boolean; label: string; have: string }[] => [
	{
		ok: Object.keys(league.scoring.batting).length > 0,
		label: "batting scoring",
		have: `${Object.keys(league.scoring.batting).length} stats`
	},
	{
		ok: Object.keys(league.scoring.pitching).length > 0,
		label: "pitching scoring",
		have: `${Object.keys(league.scoring.pitching).length} stats`
	},
	{
		ok: Object.keys(league.roster.slots).length > 0,
		label: "roster slots",
		have: `${Object.values(league.roster.slots).reduce((a, b) => a + b, 0)} seats`
	},
	{
		ok: league.meta.max_teams !== null,
		label: "team count",
		have: league.meta.max_teams === null ? "not stated" : `${league.meta.max_teams} teams`
	}
]

/**
 * Yahoo's names joined to MLBAM ids, so the roster travels as ids rather than as
 * strings the browser has to re-resolve.
 *
 * The browser stores a roster as `id:group` keys against the same snapshot this
 * reads, which is the file the site serves — so the join is done once, here, with
 * the misses NAMED. A roster that quietly lost two players would misprice every
 * trade on the page, and the two ways to lose them are a name this capture spells
 * differently and a player who is not in it at all; both come back as a name, not
 * as a silent gap.
 *
 * A two-way player is two rated rows and Yahoo's team page does not say which of
 * them you hold, so both keys are written — the same thing the browser's own read
 * does, and the reader drops whichever he does not own.
 */
const resolveRoster = async (
	names: string[]
): Promise<{ keys: string[]; missed: string[]; note: string } | null> => {
	let players: { id: number; name: string; group: string }[]
	try {
		players = JSON.parse(await readFile(SNAPSHOT, "utf8")).players
	} catch (e) {
		// Absent is reported as absent: the seats still travel, so the planner works;
		// only the id list is missing, and the page can rebuild it with one click.
		return null
	}
	const byName = new Map<string, { id: number; group: string }[]>()
	for (const p of players) {
		const k = normalizeName(p.name)
		byName.set(k, [...(byName.get(k) ?? []), { id: p.id, group: p.group }])
	}
	const keys: string[] = []
	const missed: string[] = []
	for (const name of names) {
		const hits = byName.get(normalizeName(name))
		if (!hits?.length) {
			missed.push(name)
			continue
		}
		for (const h of hits) keys.push(`${h.id}:${h.group}`)
	}
	return {
		keys,
		missed,
		note: `${keys.length} of ${names.length} matched to the committed snapshot`
	}
}

/** What the extra Yahoo reads produced, each either a result or a stated reason
 *  there is none. Nothing here ever half-succeeds silently. */
interface Extras {
	pool: { at: string; leagueId: string; players: unknown[]; positionsRead: string[]; note: string } | null
	lineup: { at: string; spots: unknown[] } | null
	rosterKeys: string[] | null
	lines: string[]
}

const readExtras = async (league: League, leagueId: string): Promise<Extras> => {
	const lines: string[] = []
	const out: Extras = { pool: null, lineup: null, rosterKeys: null, lines }

	// ── the free agents ────────────────────────────────────────────────────────
	process.stderr.write(`  reading your league's free agents (nine position sweeps)… `)
	const pool = await fetchAvailable(leagueId)
	process.stderr.write(`${pool.players.length}\n`)
	if (pool.players.length) {
		out.pool = {
			at: new Date().toISOString(),
			leagueId,
			players: pool.players.map(p => ({
				yahooId: p.yahooId,
				name: p.name,
				team: p.team,
				positions: p.positions
			})),
			positionsRead: pool.positionsRead,
			note: pool.note
		}
		lines.push(
			`    ✓ ${"free agents".padEnd(16)} ${pool.players.length} across ` +
				`${pool.positionsRead.join(", ")}`
		)
	} else
		lines.push(
			`    ✗ ${"free agents".padEnd(16)} none read — the league may be private, or ` +
				`Yahoo throttled it`
		)

	// ── your team ──────────────────────────────────────────────────────────────
	const teamId = league.meta.team_id
	if (!teamId) {
		lines.push(
			`    ✗ ${"your roster".padEnd(16)} the URL named no team, so there was nothing ` +
				`to read (add /<team> to it)`
		)
		return out
	}
	process.stderr.write(`  reading your roster off team ${teamId}'s own page… `)
	const team = await fetchRoster(leagueId, teamId)
	process.stderr.write(`${team.players.length}\n`)
	if (!team.players.length) {
		lines.push(`    ✗ ${"your roster".padEnd(16)} ${team.note}`)
		return out
	}
	const seated = team.players.filter(p => p.slot)
	out.lineup = {
		at: new Date().toISOString(),
		spots: seated.map(p => ({ slot: p.slot!, name: p.name, positions: p.positions, team: p.team }))
	}
	const joined = await resolveRoster(team.players.map(p => p.name))
	out.rosterKeys = joined?.keys ?? null
	lines.push(
		`    ✓ ${"your roster".padEnd(16)} ${team.players.length} players, ` +
			`${seated.length} with a seat Yahoo printed` +
			(joined ? `, ${joined.note}` : `` )
	)
	if (!joined)
		lines.push(
			`      the committed data/snapshot.json could not be read, so only the seats ` +
				`travel; the page rebuilds the id list with one click`
		)
	else if (joined.missed.length)
		lines.push(`      not in that capture, add by hand: ${joined.missed.join(", ")}`)
	return out
}

try {
	const { key, league } = await importLeague(url)
	const config = (await loadConfig()) as ReturnType<typeof Object> & {
		leagues: Record<string, League>
		active_league: string | null
		pools?: Record<string, unknown>
		lineups?: Record<string, unknown>
		rosters?: Record<string, string[]>
	}
	const existing = key in config.leagues
	config.leagues[key] = league
	config.active_league = key

	const out: string[] = []
	out.push(
		`${existing ? "Re-read" : "Imported"} ${league.meta.league_name ?? key} ` +
			`(${league.meta.platform}${league.meta.team_name ? `, ${league.meta.team_name}` : ""})`
	)
	out.push(``)
	// The readiness table is the point of the summary: four lines that say whether
	// the app can rank anything with what just landed, rather than a row count that
	// reads as success either way.
	out.push(`  What the engine needs to rank anything:`)
	for (const r of readiness(league)) out.push(`    ${r.ok ? "✓" : "✗"} ${r.label.padEnd(16)} ${r.have}`)

	// Not one of the four: a league with no readable period still ranks, over a
	// rolling window. Printed when it IS read because it changes what the board means.
	const p = league.scoring_period
	if (p?.kind)
		out.push(
			`    ✓ ${"scoring period".padEnd(16)} ${p.kind}${p.days ? `, ${p.days} days` : ""}` +
				`${p.starts_on ? `, starts ${p.starts_on}` : ""}`
		)
	if (league.roster.raw) out.push(``, `  Slots: ${league.roster.raw}`)

	/**
	 * The two reads a browser cannot do, and the only reason this command exists as
	 * more than a convenience.
	 *
	 * Yahoo-only on purpose. `fetchAvailable` and `fetchRoster` parse Yahoo's own
	 * markup; ESPN has neither an equivalent here nor any need for one, because
	 * ESPN sends CORS headers and the page reads its rosters for itself
	 * (`readableInBrowser` in src/import.ts). Doing nothing quietly would be the
	 * wrong shape, so the summary below says which reads ran and which did not.
	 */
	const yahoo = league.meta.platform === "yahoo" && league.meta.league_id
	if (yahoo && !flag("--settings-only")) {
		out.push(``, `  What only this machine can read:`)
		const extras = await readExtras(league, league.meta.league_id!)
		out.push(...extras.lines)
		if (extras.pool) config.pools = { ...config.pools, [key]: extras.pool }
		if (extras.lineup) config.lineups = { ...config.lineups, [key]: extras.lineup }
		if (extras.rosterKeys?.length) config.rosters = { ...config.rosters, [key]: extras.rosterKeys }
	} else if (yahoo)
		out.push(
			``,
			`  --settings-only: your free agents and your roster were NOT read, so the ` +
				`file carries neither.`
		)
	else if (league.meta.platform === "espn")
		out.push(
			``,
			`  ESPN sends CORS headers, so the page reads your roster itself — open the ` +
				`Trade tab and press Read roster. Only the settings needed this command.`
		)

	if (league.needs_review.length) {
		out.push(
			``,
			`  ${league.needs_review.length} thing${league.needs_review.length === 1 ? "" : "s"} ` +
				`the source did not state:`
		)
		// Printed in full, never truncated. These are the values that stayed null, and
		// a summary that hid them would let a missing setting pass for a read one.
		for (const n of league.needs_review) out.push(`    · ${n}`)
	}

	const short = readiness(league).filter(r => !r.ok)
	if (short.length)
		out.push(
			``,
			`  ${short.length} of the 4 required inputs ${short.length === 1 ? "is" : "are"} ` +
				`missing (${short.map(r => r.label).join(", ")}), so this league cannot rank ` +
				`players yet.`,
			`  Open League setup in the app and fill them in — nothing here will guess them.`
		)

	await saveConfig(config)

	// LAST, always. This is the one line the reader has to act on — the file goes to
	// beanemachine.com — and a path buried above a list of caveats is a path that
	// gets scrolled past.
	out.push(
		``,
		`  Active league is now ${key}`,
		`  Drop this file anywhere on beanemachine.com to load all of it into that browser:`,
		``,
		`    ${CONFIG}`
	)

	console.log(out.join("\n"))
} catch (e) {
	if (e instanceof ImportError) {
		console.error(`error: ${e.message}`)
		console.error(`\nusage: ${RUN} <league-url>   (--help for the URL shapes)`)
	} else console.error(e)
	process.exit(1)
}
