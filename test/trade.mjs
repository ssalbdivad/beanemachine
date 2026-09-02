// The trade analyzer, asserted against the real snapshot rather than a fixture.
// The whole claim it makes is that a trade is worth what it does to YOUR STARTING
// LINEUP, so every test here is about slots, not about who has the higher bscore.
import { readFileSync } from "node:fs"
import { hydrate } from "../src/data/snapshot.ts"
import { rateAll } from "../src/engine/bscore.ts"
import { activeSlots, replacementBySlot, startingLineup, evaluateTrade } from "../src/engine/trade.ts"

const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const league = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const hy = hydrate(snap)
const teams = league.meta.max_teams
const pool = rateAll({
	league, players: hy.players, underlying: hy.underlying, injuries: hy.injuries,
	teamGamesPlayed: hy.teamGamesPlayed, gamesByTeam: hy.gamesByTeam,
	opponentsByTeam: hy.opponentsByTeam, recentVolumeByWindow: hy.recentVolumeByWindow,
	recentStats: hy.recentStats, ownership: hy.ownership, teams
})

const key = r => `${r.player.id}:${r.player.group}`
const spots = activeSlots(league)
const bars = replacementBySlot(league, pool, teams)
const byPoints = pool.filter(r => r.rateable).sort((a, b) => b.points - a.points)
/** Best available body for each spot, in the league's own slot order. */
const draft = (wanted, exclude = []) => {
	const taken = new Set(exclude.map(key))
	const out = []
	for (const slot of wanted) {
		const pick = byPoints.find(r => !taken.has(key(r)) && r.slots.includes(slot))
		if (!pick) continue
		taken.add(key(pick))
		out.push(pick)
	}
	return out
}
const evaluate = (roster, out, incoming) =>
	evaluateTrade({ league, roster, out, in: incoming, pool, teams })

// --- the shape of the thing being filled ---
t("active slots expand to one entry per startable spot",
	spots.length === league.roster.counts.active && !spots.some(s => ["BN", "IL", "NA"].includes(s)),
	`${spots.length} vs ${league.roster.counts.active} active`)

// The bars are recomputed here because rateAll keeps them to itself. If the two
// ever disagree the analyzer is pricing vacated spots off a different waiver wire
// than the board is, which is exactly the kind of silent drift this pins down.
const drifted = pool.filter(r => r.rateable && bars.has(r.slot) && bars.get(r.slot) !== r.replacement)
t("replacement bars match the ones bscore used", drifted.length === 0,
	drifted.slice(0, 3).map(r => `${r.slot}: ${bars.get(r.slot)} vs ${r.replacement}`).join(", "))

// ...and the reason they have to be recomputed rather than read back: Rated.replacement
// only ever reports a player's BEST slot, so a slot nobody is best at is missing from it
// entirely. SP is that slot here — its bar sits above P's, so every starter is worth more
// at P — which is exactly the bar the drift check above cannot see.
const bestSlots = new Set(pool.filter(r => r.rateable).map(r => r.slot))
const unreachable = [...bars.keys()].filter(s => !bestSlots.has(s))
t("a bar nobody is best at cannot be read back off Rated.replacement",
	unreachable.includes("SP") && bars.get("SP") > bars.get("P"),
	`unreachable [${unreachable.join(",")}], SP ${bars.get("SP")} vs P ${bars.get("P")}`)

// --- filling a lineup ---
const full = draft(spots)
const lineup = startingLineup(league, full, bars)
t("a full roster fills every startable spot from the roster",
	lineup.starters.length === spots.length && lineup.starters.every(s => s.source === "roster"),
	lineup.starters.filter(s => s.source !== "roster").map(s => s.slot).join(","))
t("the lineup total is the sum of its spots",
	Math.abs(lineup.points - lineup.starters.reduce((a, s) => a + s.points, 0)) < 0.01)
t("nobody starts twice",
	new Set(lineup.starters.map(s => s.player && key(s.player))).size === lineup.starters.length)
t("every starter is eligible where he was put",
	lineup.starters.every(s => !s.player || s.player.slots.includes(s.slot)))

// Scarcest slot first is the whole reason the fill is ordered at all: a catcher
// spent on a Util spot leaves C empty, and C is the cheapest bar in the league.
// `slots[0]` used to be the primary position; with real multi-position
// eligibility the array is a set of everywhere he qualifies, so eligibility has
// to be asked for directly.
const catcher = byPoints.find(r => r.slots.includes("C"))
const dh = byPoints.find(r => r.slots.length === 1 && r.slots[0] === "Util")
const twoBats = [catcher, dh]
const naive = (roster, order) => {          // fill in the league's printed order
	const taken = new Set()
	let points = 0
	for (const slot of order) {
		const pick = roster.find(r => !taken.has(key(r)) && r.slots.includes(slot))
		if (pick) { taken.add(key(pick)); points += pick.points }
		else points += bars.get(slot) ?? 0
	}
	return Number(points.toFixed(2))
}
const utilFirst = { ...league, roster: { ...league.roster, slot_order: [...spots].reverse() } }
const scarce = startingLineup(utilFirst, twoBats, bars)
t("a catcher is put at C, not spent on a Util spot",
	scarce.starters.find(s => s.slot === "C")?.player?.player.name === catcher.player.name,
	`C holds ${scarce.starters.find(s => s.slot === "C")?.player?.player.name ?? "nobody"}`)
t("and that ordering is worth real points over filling slots as printed",
	scarce.points > naive(twoBats, activeSlots(utilFirst)),
	`${scarce.points} vs ${naive(twoBats, activeSlots(utilFirst))}`)

// --- 1. a trade that is positive ONLY because of scarcity ---
// Two rosters, identical but for a catcher, offered the same deal: a lesser bat
// who happens to catch, for a better bat who does not.
const catcherless = draft(spots.filter(s => s !== "C"))
const withCatcher = [...catcherless, catcher]
const secondCatcher = byPoints.filter(r => r.slots[0] === "C" && key(r) !== key(catcher))[0]
const utilStarters = startingLineup(league, catcherless, bars).starters
	.filter(s => s.slot === "Util" && s.player)
	.map(s => s.player)
const givenUp = utilStarters.filter(r => r.points > secondCatcher.points).sort((a, b) => a.points - b.points)[0]

const scarcity = evaluate(catcherless, [givenUp], [secondCatcher])
const stocked = evaluate(withCatcher, [givenUp], [secondCatcher])
t("the incoming player is the worse player on raw points",
	secondCatcher.points < givenUp.points,
	`${secondCatcher.player.name} ${secondCatcher.points} < ${givenUp.player.name} ${givenUp.points}`)
t("and the trade is still a gain, because it fills the slot you cannot fill",
	scarcity.delta > 0, `${scarcity.delta}`)
t("the same deal is a loss for a manager who already starts a catcher",
	stocked.delta < 0 && stocked.delta < scarcity.delta,
	`${stocked.delta} vs ${scarcity.delta}`)
t("the gain is exactly the catcher slot minus the bat slot",
	Math.abs(scarcity.delta - ((secondCatcher.points - bars.get("C")) - (givenUp.points - bars.get("Util")))) < 0.02,
	`${scarcity.delta} vs slots ${(secondCatcher.points - bars.get("C")).toFixed(2)} − ${(givenUp.points - bars.get("Util")).toFixed(2)}`)
t("the explanation names the mechanism rather than the verdict",
	/instead of/.test(scarcity.explanation) && scarcity.explanation.includes("catcher"),
	scarcity.explanation)
console.log(`      → ${scarcity.explanation}`)
console.log(`      → ${stocked.explanation}`)

// --- 2. a 2-for-1: the vacated spot is filled at replacement level, not by magic ---
const outfielders = full.filter(r => r.slots[0] === "OF").sort((a, b) => a.points - b.points)
const [outA, outB] = outfielders
const incomingOF = byPoints.filter(r => r.slots[0] === "OF" && !full.some(f => key(f) === key(r)))[0]
const twoForOne = evaluate(full, [outA, outB], [incomingOF])
const covered = twoForOne.lineups.after.starters.filter(s => s.source === "replacement")
t("a 2-for-1 leaves the roster a body short",
	twoForOne.lineups.after.starters.filter(s => s.source === "roster").length ===
		twoForOne.lineups.before.starters.filter(s => s.source === "roster").length - 1)
t("and the spot it opens is covered at the league's replacement level",
	covered.length === 1 && covered[0].slot === "OF" && covered[0].points === bars.get("OF"),
	covered.map(s => `${s.slot}=${s.points}`).join(","))
t("the 2-for-1 delta is the arithmetic of the three players and the bar",
	Math.abs(twoForOne.delta - (incomingOF.points + bars.get("OF") - outA.points - outB.points)) < 0.02,
	`${twoForOne.delta}`)
t("the explanation says where the missing body came from",
	/freely available/.test(twoForOne.explanation), twoForOne.explanation)
console.log(`      → ${twoForOne.explanation}`)

// Bench depth counts for exactly as much as it changes what can be started: with a
// spare outfielder the same 2-for-1 is worth the gap between him and the wire.
const spare = byPoints.filter(r =>
	r.slots[0] === "OF" && !full.some(f => key(f) === key(r)) && key(r) !== key(incomingOF))[0]
const deep = evaluate([...full, spare], [outA, outB], [incomingOF])
t("bench depth changes the same trade, by exactly what it saves you on the wire",
	deep.delta > twoForOne.delta &&
		Math.abs((deep.delta - twoForOne.delta) - (spare.points - bars.get("OF"))) < 0.02,
	`${deep.delta} vs ${twoForOne.delta}, spare ${spare.player.name} ${spare.points}`)
t("a bench outfielder you never start is not worth anything by himself",
	evaluate([...full, spare], [], []).delta === 0)

// --- 3. trading a player for himself is exactly zero ---
for (const victim of [full[0], full[8], outA, catcher]) {
	const roster = full.some(f => key(f) === key(victim)) ? full : [...full, victim]
	const self = evaluate(roster, [victim], [victim])
	t(`trading ${victim.player.name} for himself changes nothing`,
		self.delta === 0 && self.changes.length === 0 &&
			self.before === self.after && self.lineups.after.points === self.lineups.before.points,
		`${self.delta}, ${self.changes.length} changes`)
}
const swap = evaluate(full, [outA, outB], [outB, outA])
t("and neither does swapping two players for themselves", swap.delta === 0 && swap.changes.length === 0)
const shuffled = startingLineup(league, [...full].reverse(), bars)
t("the lineup does not depend on the order the roster arrives in",
	shuffled.points === lineup.points)

// --- what it refuses to assume ---
const notMine = byPoints.find(r => !full.some(f => key(f) === key(r)))
const bogus = evaluate(full, [notMine], [])
t("giving up someone you do not own is reported, not quietly honoured",
	bogus.missing.some(m => m.includes(notMine.player.name)) && bogus.delta === 0,
	bogus.missing.join(" | "))
t("and it does not leave you a body short, because nobody left",
	!/short/.test(bogus.explanation), bogus.explanation)

// The sentence has to name the spot this deal opened, not whichever covered spot
// happens to sit last in the lineup. This roster is already starting four wire
// pitchers before the trade; giving up the catcher opens C and nothing else.
const noArms = draft(spots.filter(s => !["SP", "RP", "P"].includes(s)))
const armless = evaluate(noArms, [noArms.find(r => r.slots[0] === "C")], [])
t("the spot named as opening is the one that actually opened",
	/freely available C \(/.test(armless.explanation) && !/available P /.test(armless.explanation),
	armless.explanation)
t("an empty roster is holes, not zeroes, when no bar exists",
	startingLineup(league, [], null).starters.every(s => s.source === "empty") &&
		startingLineup(league, [], null).holes.length === spots.length)
t("with bars in hand the same empty roster is priced off the wire",
	startingLineup(league, [], bars).points ===
		Number(spots.reduce((a, s) => a + bars.get(s), 0).toFixed(2)))

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
