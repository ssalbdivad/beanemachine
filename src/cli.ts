import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, saveConfig } from "./config.ts"
import { ImportError, importLeague } from "./import.ts"
import type { League } from "./schema.ts"

/**
 * Read one league off its own pages and write it into scoring.json.
 *
 * This is the ONLY route to a Yahoo league, and Yahoo is the platform most of this
 * app's users are on. Measured 2026-09-04: Yahoo sends no `access-control-allow-*`
 * headers on any of the pages the importer reads, so a browser is never handed the
 * response body — the hosted build at beanemachine.com cannot import a Yahoo league
 * and never will be able to. Running this once is what a Yahoo user does instead,
 * and the file it writes is portable: `leagues.replace` in the browser loads it.
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

if (process.argv.includes("--help") || process.argv.includes("-h") || !process.argv[2]) {
	const missing = !process.argv[2] && !process.argv.includes("--help")
	console[missing ? "error" : "log"](
		`${missing ? "No league URL given.\n\n" : ""}usage: ${RUN} <league-url>\n` +
			`\n` +
			`Reads a league's own settings pages and writes it into scoring.json, then\n` +
			`makes it the active league. Nothing is invented: whatever the source does not\n` +
			`state is left blank and listed under "needs review".\n` +
			`\n` +
			`  Yahoo  https://baseball.fantasysports.yahoo.com/b1/<league>/<team>\n` +
			`         The only way in. Yahoo sends no CORS headers, so no browser can\n` +
			`         read it — this command can, and beanemachine.com cannot.\n` +
			`  ESPN   https://fantasy.espn.com/baseball/league?leagueId=<id>&teamId=<id>\n` +
			`         Works here and equally well in the browser, which reads ESPN itself.\n` +
			`\n` +
			`The league must be publicly viewable; a private one needs a signed-in session\n` +
			`this has no way to hold. Sleeper is not supported — it runs no fantasy\n` +
			`baseball at all.\n` +
			`\n` +
			`Then: open the app, League setup → Download, to get a file you can load into\n` +
			`any browser; or run \`npx vite\` and it seeds from scoring.json directly.`
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

try {
	const { key, league } = await importLeague(process.argv[2]!)
	const config = await loadConfig()
	const existing = key in config.leagues
	config.leagues[key] = league
	config.active_league = key
	await saveConfig(config)

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

	out.push(``, `  Written to ${join(ROOT, "scoring.json")}`, `  Active league is now ${key}`)

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

	console.log(out.join("\n"))
} catch (e) {
	if (e instanceof ImportError) {
		console.error(`error: ${e.message}`)
		console.error(`\nusage: ${RUN} <league-url>   (--help for the URL shapes)`)
	} else console.error(e)
	process.exit(1)
}
