import { readFileSync } from "node:fs"
import { hydrate, type Snapshot } from "../data/snapshot.ts"
import { fetchAvailable, normalizeName } from "../data/yahoo-pool.ts"
import { rateAll, withUndervaluation } from "../engine/bscore.ts"
import type { League } from "../schema.ts"
import { DEFAULTS, plan, railViolations, type PlanInput } from "./plan.ts"
import { leagueLimits } from "../import.ts"
import { applyLineup, describeMoves, permits as permitsFor } from "./execute.ts"
import { readRoster } from "./roster.ts"
import { checkSession, login, openSession, type ReadFailure } from "./session.ts"

/**
 * Autonomous mode: let Billy look after the team.
 *
 * SAFETY, because this reasons about real and hard-to-reverse actions on a real
 * account — a dropped player can be claimed by someone else within seconds:
 *   · dry run is the DEFAULT and changes nothing;
 *   · at most `--max-moves` per run (default 1);
 *   · nobody at or above `--keep-floor` is ever proposed for a drop;
 *   · a swap needs to clear `--min-gain` projected points to be worth making;
 *   · nobody MLB lists on the IL is ever proposed as an add or a starter;
 *   · every proposal is printed with the numbers behind it, and the finished plan
 *     is re-audited against those rails before anything is printed at all.
 *
 * Every step that reads the live site reports what it could not read. Exit 1 means
 * Billy was blind, exit 2 means he produced a plan that broke his own rails and
 * withheld it, and exit 0 means the plan below is the whole picture. "No move
 * clears the bar" and "the roster could not be read" must never look alike.
 *
 * Credentials are never handled by this code. You log into Yahoo by hand once and
 * Playwright reuses the resulting cookies from a gitignored file.
 */
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1]
const flag = (name: string) => process.argv.includes(`--${name}`)

/** A margin is only ever printed with its own sign — a "+-3" reads as a typo, and
 *  a plan that is worth less than today's is exactly the one to notice. */
const signed = (n: number): string => (n >= 0 ? `+${n}` : String(n))

const stop: (failure: ReadFailure) => never = failure => {
	console.log(`\nBILLY IS BLIND — ${failure.step}`)
	console.log(`  could not read: ${failure.what}`)
	if (failure.detail) console.log(`  the page said:  ${failure.detail}`)
	if (failure.fix) console.log(`  to fix:         ${failure.fix}`)
	console.log("\nNo plan was produced. This is NOT the same as having nothing to do.")
	process.exit(1)
}

if (flag("login")) {
	const result = await login()
	if (!result.ok) stop(result.failure)
	else console.log(`Session saved to ${result.value}. It is gitignored; treat it like a password.`)
	process.exit(0)
}

/** Reads a local file this run cannot proceed without, and names it when it can't. */
const readJson: (path: string, step: string, fix: string) => unknown = (path, step, fix) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"))
	} catch (e) {
		stop({ step, what: `${path} could not be read`, fix, detail: String(e) })
	}
}

const key = arg("league") ?? "yahoo:228947"
const config = readJson("scoring.json", "config", "run: node src/cli.ts") as {
	leagues: Record<string, League | undefined>
}
const league = config.leagues[key]
if (!league) stop({ step: "config", what: `scoring.json has no league "${key}"`, fix: "pass --league=<key>" })
const leagueId = league.meta.league_id
const teamId = arg("team") ?? league.meta.team_id
const teams = league.meta.max_teams
if (!leagueId)
	stop({ step: "config", what: `league "${key}" has no league_id`, fix: "re-import the league" })
if (!teamId)
	stop({ step: "config", what: `league "${key}" has no team_id`, fix: "pass --team=<id>" })
// Never defaulted: the team count sets every replacement level, so guessing it
// would move every bscore in the plan.
if (!teams)
	stop({ step: "config", what: `league "${key}" has no max_teams, which sets every replacement level`, fix: "re-import the league" })

const options = {
	minGain: Number(arg("min-gain") ?? DEFAULTS.minGain),
	keepFloor: Number(arg("keep-floor") ?? DEFAULTS.keepFloor),
	maxMoves: Number(arg("max-moves") ?? DEFAULTS.maxMoves),
	lineupMinGain: Number(arg("lineup-min-gain") ?? DEFAULTS.lineupMinGain)
}
for (const [name, value] of Object.entries(options))
	if (!Number.isFinite(value))
		stop({ step: "config", what: `--${name} was not a number`, fix: "pass a number, or leave it out" })

console.log(`Billy is looking at ${league.meta.team_name ?? teamId} in ${league.meta.league_name}`)
console.log(
	`mode: ${
		!flag("execute") ? "dry run (nothing is changed)"
		: flag("allow-drops") ? "EXECUTING — lineup and add/drop"
		: "EXECUTING — lineup only (add/drop withheld)"
	} · min gain ${options.minGain} · ` +
		`keep floor ${options.keepFloor} · max ${options.maxMoves} move(s)\n`
)

// Checked before a single page is fetched. A run with no usable cookies cannot end
// in a plan, and there is no reason to spend nine free-agent page loads against
// Yahoo's rate limit discovering it.
const saved = checkSession()
if (!saved.ok) stop(saved.failure)

const snapshot = readJson("data/snapshot.json", "snapshot", "run: node src/refresh.ts") as Snapshot
const h = hydrate(snapshot)

/*
   THE WIRE IS READ BEFORE THE RANKING, AND IT USED TO BE READ AFTER IT.

   `rateAll` prices every man against a REPLACEMENT BAR — what the best available man at the
   same seat would give this league — and it takes the league's own free-agent list to compute
   it. Handed nothing, it walks down the whole of baseball instead, which is the right answer
   for a page that cannot see a wire and the wrong one for a run that is about to fetch it.

   This ranked first and fetched the wire fifteen lines later, then used it for one thing only:
   filtering candidate names. So the autonomous run priced every add against the best man in
   baseball while the card on the reader's screen priced the same add against the best man
   actually free in his league — two answers to the same question from one codebase, and the
   worse one was the one that acted on its own.

   `Decide.tsx` has passed both of these since the wire landed; this is the same pair, in the
   same order, so the two cannot disagree.
*/
const pool = await fetchAvailable(leagueId)
// Yahoo answers a throttled or signed-out request with an empty page rather than
// an error, so nine empty pages means we could not see the wire — not that the
// wire is empty.
if (!pool.positionsRead.length)
	stop({
		step: "free-agents",
		what: `no free-agent page could be read for league ${leagueId} (all positions came back empty or blocked)`,
		fix: "check the league is publicly viewable, then wait a few minutes and try again"
	})
const availableNames = new Set(pool.players.map(p => normalizeName(p.name)))
console.log(`read: ${pool.players.length} free agents across ${pool.positionsRead.join(", ")}`)

const rated = withUndervaluation(
	rateAll({
		league: league,
		players: h.players,
		underlying: h.underlying,
		injuries: h.injuries,
		teamGamesPlayed: h.teamGamesPlayed,
		gamesByTeam: h.gamesByTeam,
		opponentsByTeam: h.opponentsByTeam,
		recentVolumeByWindow: h.recentVolumeByWindow,
		recentStats: h.recentStats,
		teams,
		/* The league's own wire, as a test any rated man can be put to — the same shape
		   `wireTest` takes in src/client/Decide.tsx, by normalised name because a name is all
		   a Yahoo players page gives that both sides share. */
		available: r => availableNames.has(normalizeName(r.player.name)),
		/* WHICH SEATS THAT LIST CAN SPEAK FOR. A sweep that read four positions knows nothing
		   about the other five, and a bar of zero at a seat nobody was read for says "anybody
		   is free here", which is the most expensive number this function produces. See
		   `slotsCoveredBy`. */
		availablePositions: pool.positionsRead
	})
)
console.log(
	`read: ${rated.length} players rated from the snapshot, against the ` +
		`${pool.players.length} men actually free in this league`
)

const session = await openSession(!flag("headed"))
if (!session.ok) stop(session.failure)
const read = await readRoster(session.value.context, leagueId, teamId)
await session.value.close()
if (!read.ok) stop(read.failure)

const roster = read.value.spots
const expected = league.roster.counts?.total ?? null
console.log(
	`read: ${roster.length} roster spots` +
		(expected === null ? "" : ` (the league's roster holds ${expected})`)
)
if (expected !== null && roster.length !== expected)
	console.log(
		`  NOTE: that is not the ${expected} the league settings describe, so at least one row ` +
			`did not parse. The plan below sees only what is listed.`
	)
for (const w of read.value.warnings) console.log(`  could not read: ${w}`)

const input: PlanInput = {
	roster,
	rated,
	availableNames,
	shape: {
		slots: league.roster.slots,
		slot_order: league.roster.slot_order,
		slot_accepts: league.roster.slot_accepts
	},
	options,
	/* The league's own stated rules, so the autonomous run obeys the same cap the card
	   does. `--max-moves` is still a rail on top of it: the planner takes the lower of the
	   two, and a league that allows six does not make this run take six. */
	limits: leagueLimits(league)
}
const result = plan(input)

const violations = railViolations(result, input)
if (violations.length) {
	console.log("\nPLAN WITHHELD — it broke Billy's own rails:")
	for (const v of violations) console.log(`  · ${v}`)
	console.log("\nNothing is printed as a recommendation. This is a bug in the planner.")
	process.exit(2)
}

for (const s of result.skipped) console.log(`  skipped: ${s}`)

console.log("\nLINEUP")
if (result.lineup.blocked) console.log(`  not planned: ${result.lineup.blocked}`)
else if (!result.lineup.swaps.length && !result.lineup.shifts.length && !result.lineup.sits.length)
	// A lineup nothing beats and a lineup whose only improvement was held back by
	// --lineup-min-gain are different facts, and only the first one is "optimal".
	console.log(
		result.lineup.gain > 0 ?
			`  left alone — ${result.lineup.pointsNow} projected points. The best legal ` +
				`rearrangement is worth ${signed(result.lineup.gain)}, below the ` +
				`${options.lineupMinGain}-point lineup bar.`
		:	`  already optimal — ${result.lineup.pointsNow} projected points, and no legal ` +
				`rearrangement of your own players beats it.`
	)
else {
	// Every exit past the paired swaps still has to be named: a seat freed by a
	// shift, or by a man nobody can replace, is a change to your lineup too.
	const unpaired = result.lineup.sits.slice(result.lineup.swaps.length)
	console.log(
		`  ${result.lineup.swaps.length + result.lineup.shifts.length + unpaired.length} change(s), ` +
			`${result.lineup.pointsNow} → ${result.lineup.pointsPlanned} projected points ` +
			`(${signed(result.lineup.gain)})\n`
	)
	for (const s of result.lineup.swaps) {
		console.log(`  START ${s.start}  (${s.startSlot}, ${s.startPoints} projected)`)
		console.log(
			`  SIT   ${s.sit ?? "— the seat is empty"}` +
				(s.sitPoints === null ? "" : `  (${s.sitPoints} projected)`)
		)
		console.log(`  net   ${signed(s.gain)} projected points`)
		console.log(`  why   ${s.reason}\n`)
	}
	for (const s of unpaired)
		console.log(
			`  SIT   ${s.name}${s.why ? ` — ${s.why}` : ""}, and no bench man is eligible to take the seat`
		)
	for (const s of result.lineup.shifts)
		console.log(`  MOVE  ${s.name}: ${s.from} → ${s.to}, to make the above legal`)
}
for (const slot of result.lineup.emptySlots)
	console.log(`  EMPTY ${slot}: nobody on your roster is eligible there`)

console.log("\nADD / DROP")
for (const n of result.notes) console.log(`  ${n}`)
if (!result.moves.length) console.log("  no move clears the bar. Billy is standing pat.")
else {
	console.log(`  Billy would make ${result.moves.length} move(s):\n`)
	for (const m of result.moves) {
		console.log(`  ADD  ${m.add}   (bscore ${m.addScore})`)
		console.log(`  DROP ${m.drop}  (bscore ${m.dropScore})`)
		console.log(`  net  ${signed(m.gain)} projected points`)
		console.log(`  why  ${m.reason}\n`)
	}
}
/**
 * Execution. Two flags, because the two capabilities carry different risk:
 * `--execute` sets lineups, which is reversible in one click; `--allow-drops` is
 * needed on top of it before anything irreversible, and even then this build
 * prints the add/drop rather than clicking it.
 */
const gates = permitsFor({ execute: flag("execute"), allowDrops: flag("allow-drops") })
for (const why of gates.reasons) console.log(`\n${why}`)

if (!gates.lineup) {
	console.log("\nThis is a dry run — nothing was changed on your team.")
	process.exit(0)
}

console.log("\nABOUT TO CHANGE YOUR TEAM")
for (const s of result.lineup.swaps)
	console.log(`  start ${s.start} at ${s.startSlot}, sitting ${s.sit ?? "nobody"}`)
if (!result.lineup.swaps.length) {
	/*
	   "ALREADY MATCHES THE PLAN" WAS SAID ABOUT PLANS IT DOES NOT MATCH.
	
	   A lineup plan holds three kinds of change — swaps, sits and shifts — and only swaps are
	   ones this run knows how to make on Yahoo. It gated on swaps alone, so a plan whose only
	   changes were a sit and a seat shift printed "1 change(s)" a few lines above and then
	   "nothing — the lineup already matches the plan" here, and exited 0. The README's own
	   contract for 0 is "the plan below is the whole picture"; it was not, and a reader who
	   trusts the exit code leaves an injured man in his lineup.
	
	   Two different endings now. Nothing to do at all is still 0 and still says so. Changes
	   this run cannot make are named, counted, and exit 1 — "Billy was blind" in the README's
	   words is the closest of the three to "he could not do it", and the one thing that must
	   never happen is that this looks like success.
	*/
	const manual = [
		...result.lineup.sits.map(x => `sit ${x.name}${x.why ? ` — ${x.why}` : ""}`),
		...result.lineup.shifts.map(x => `move ${x.name} from ${x.from} to ${x.to}`)
	]
	if (!manual.length) {
		console.log("  nothing — the lineup already matches the plan.")
		process.exit(0)
	}
	console.log(
		`  nothing this run can do for you. The plan's ${manual.length} change(s) are seat ` +
			`moves and sits, which it does not make on Yahoo:`
	)
	for (const m of manual) console.log(`    ${m}`)
	console.log("  Make those on Yahoo yourself — your lineup is unchanged.")
	process.exit(1)
}

const writing = await openSession(!flag("headed"))
if (!writing.ok) stop(writing.failure)
const page = await writing.value.context.newPage()
// edit mode is where the position dropdowns exist at all
await page.goto(`https://baseball.fantasysports.yahoo.com/b1/${leagueId}/${teamId}`, {
	waitUntil: "domcontentloaded"
})
const applied = await applyLineup(
	page,
	result.lineup,
	async () => {
		const back = await readRoster(writing.value.context, leagueId, teamId)
		// a re-read that fails must not read as "the change is not there" — those are
		// different claims, and only one of them is about the roster
		if (!back.ok) throw new Error(`could not re-read the roster to verify: ${back.failure.what}`)
		return back.value.spots.map(r => ({ name: r.name, slot: r.slot }))
	},
	{ dryRun: false }
)
await writing.value.close()

console.log("\nRESULT")
for (const a of applied)
	console.log(`  ${a.verified ? "OK  " : "??  "}${a.action} — ${a.detail}`)
const unverified = applied.filter(a => !a.verified)
if (unverified.length)
	console.log(
		`\n${unverified.length} action(s) could not be confirmed by re-reading the page. ` +
			`Check the roster by hand before trusting this run — a click that did not throw ` +
			`is not a click that worked.`
	)
if (result.moves.length) for (const m of describeMoves(result.moves)) console.log(`\n  ${m}`)
