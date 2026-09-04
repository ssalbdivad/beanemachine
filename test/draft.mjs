// Draft mode, asserted against the real snapshot rather than a fixture.
// The claim it makes is that the next pick is worth what it does to YOUR STARTING
// LINEUP given what you have already taken, and that scarcity is read off the
// players still on the board — so every test here is a roster or a pool changing,
// never a question about who has the higher bscore.
import { readFileSync } from "node:fs"
import { hydrate } from "../src/data/snapshot.ts"
import { rateAll } from "../src/engine/bscore.ts"
import { activeSlots, replacementBySlot, startingLineup } from "../src/engine/trade.ts"
import { recommend } from "../src/engine/draft.ts"

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
const byPoints = pool.filter(r => r.rateable).sort((a, b) => b.points - a.points)
/** Everyone eligible at a slot, best projection first. */
const at = slot => byPoints.filter(r => r.slots.includes(slot))
/** Best available body for each spot, in the league's own slot order — the same
 *  helper test/trade.mjs drafts a roster with. */
const fill = wanted => {
	const held = new Set()
	const out = []
	for (const slot of wanted) {
		const pick = byPoints.find(r => !held.has(key(r)) && r.slots.includes(slot))
		if (!pick) continue
		held.add(key(pick))
		out.push(pick)
	}
	return out
}
const advise = (mine, taken = mine) => recommend({ league, pool, taken, mine, teams })

// --- the empty board: the first pick of a draft ---
const opening = advise([], [])
t("an empty board recommends somebody", opening.pick !== null && opening.pick.gain > 0,
	`${opening.pick?.player.player.name} +${opening.pick?.gain}`)
console.log(`      → ${opening.explanation}`)

// With nothing on your roster every spot is priced at the bar, so the man you take
// is worth exactly what he beats that bar by. That is the whole metric in one line.
t("the first pick's gain is his points over the bar at the spot he fills",
	Math.abs(opening.pick.gain - (opening.pick.player.points - opening.bars.get(opening.pick.at))) < 0.02,
	`${opening.pick.gain} vs ${opening.pick.player.points} − ${opening.bars.get(opening.pick.at)}`)
t("every spot the league makes you fill has a cliff row",
	opening.cliffs.length === new Set(spots).size &&
		opening.cliffs.every(c => spots.includes(c.slot)),
	opening.cliffs.map(c => c.slot).join(","))
t("the cliffs are ordered steepest first",
	opening.cliffs.every((c, i) =>
		i === 0 || (opening.cliffs[i - 1].cliff ?? -Infinity) >= (c.cliff ?? -Infinity)),
	opening.cliffs.map(c => `${c.slot}:${c.cliff}`).join(" "))

// Nobody can be worth negative points to a lineup: seating one more player can only
// improve a fill that was already the best one available. A negative here would mean
// the greedy fill in trade.ts had stopped being optimal on this eligibility.
t("no candidate makes the lineup worse",
	[opening.pick, ...opening.alternatives].every(c => c.gain >= 0) &&
		opening.cliffs.every(c => (c.best?.gain ?? 0) >= 0 && (c.next?.gain ?? 0) >= 0))

// --- 1. the recommendation follows the roster, not the pool ---
// Two managers against one identical board: the taken list is a full best-available
// roster, and the second manager is that roster minus his catcher. Nothing else
// differs, so anything that moves between the two answers is the roster talking.
const full = fill(spots)
const cap = full.find(r => r.slots[0] === "C")
const capless = full.filter(r => key(r) !== key(cap))
const sated = advise(full, full)
const needsC = advise(capless, full)
t("the two managers are told to do different things",
	sated.pick.player.player.id !== needsC.pick.player.player.id,
	`${sated.pick.player.player.name} vs ${needsC.pick.player.player.name}`)
t("the one spot a manager has open is the spot he is sent to fill",
	needsC.pick.at === "C" && needsC.pick.gain > 0,
	`${needsC.pick.player.player.name} at ${needsC.pick.at} +${needsC.pick.gain}`)
t("and that gain is the best catcher left over the bar the board leaves at C",
	Math.abs(needsC.pick.gain - (needsC.pick.player.points - needsC.bars.get("C"))) < 0.02,
	`${needsC.pick.gain} vs ${needsC.pick.player.points} − ${needsC.bars.get("C")}`)
// A roster nobody left can improve is told exactly that, and the best body left is
// still named — "nothing to gain" is an answer, not an empty screen.
t("a roster nobody can improve is told so, and the man is named anyway",
	sated.pick.gain === 0 && sated.pick.at === null &&
		/would sit on your bench/.test(sated.explanation),
	sated.explanation)
console.log(`      → ${needsC.explanation}`)
console.log(`      → ${sated.explanation}`)

// --- 2. a slot filled to its limit stops being recommended ---
// C is one spot and Util is two, and this roster holds all three with bats no
// remaining catcher can displace. The catcher slot is then finished: the best one
// left is worth exactly nothing, and nothing is what he is offered at. The second
// manager is the same five bats without the catcher, against the same board.
const catcher = at("C")[0]
const bats = at("OF").slice(0, 5)
const stocked = [catcher, ...bats]
const board = [...new Set([...stocked, ...at("SP").slice(0, 3), ...at("RP").slice(0, 3)])]
const withC = advise(stocked, board)
const withoutC = advise(bats, board)
const cSpots = withC.lineup.starters.filter(s => s.slot === "C" || s.slot === "Util")
const cCliff = withC.cliffs.find(c => c.slot === "C")
const openCliff = withoutC.cliffs.find(c => c.slot === "C")
t("the stocked roster really has filled C and both Util spots",
	cSpots.length === 3 && cSpots.every(s => s.source === "roster"),
	cSpots.map(s => `${s.slot}=${s.source}`).join(","))
t("with C and Util full the best catcher left adds nothing",
	cCliff.best.gain === 0 && cCliff.best.at === null && cCliff.live === 0,
	`${cCliff.best.player.player.name} +${cCliff.best.gain}, ${cCliff.live} live`)
t("and the very same catcher is worth real points to the manager who has none",
	cCliff.best.player.player.id === openCliff.best.player.player.id &&
		openCliff.best.gain > 0 && openCliff.live > 0,
	`${openCliff.best.player.player.name} +${openCliff.best.gain}, ${openCliff.live} live`)
t("so a filled slot is never what gets recommended",
	withC.pick.at !== "C" && withC.pick.gain > cCliff.best.gain,
	`${withC.pick.at} +${withC.pick.gain}`)

// The fourth outfielder is the same collapse read off the other end: three OF spots
// and two Util spots are held, so the next outfielder cracks nothing.
const ofCliff = withC.cliffs.find(c => c.slot === "OF")
t("the marginal outfielder collapses once the outfield is full",
	ofCliff.best.gain === 0 && ofCliff.best.at === null,
	`${ofCliff.best.player.player.name} +${ofCliff.best.gain} at ${ofCliff.best.at}`)

// --- 3. taking players off the board moves the cliff ---
// Same roster, same league; the only difference is that the top catchers are gone.
const runOnCatchers = at("C").slice(0, 8)
const afterRun = advise(bats, [...board, ...runOnCatchers])
const runCliff = afterRun.cliffs.find(c => c.slot === "C")
t("a run on catchers changes who the best one left is",
	runCliff.best.player.player.id !== openCliff.best.player.player.id,
	`${openCliff.best.player.player.name} → ${runCliff.best.player.player.name}`)
t("and it changes the cliff at that slot",
	runCliff.cliff !== openCliff.cliff, `${openCliff.cliff} → ${runCliff.cliff}`)
t("the bar at C is read off the remaining pool, so a run moves it",
	afterRun.bars.get("C") !== withoutC.bars.get("C"),
	`${withoutC.bars.get("C")} → ${afterRun.bars.get("C")}`)
t("the bars are exactly the ones the remaining pool produces",
	[...afterRun.bars].every(([slot, bar]) =>
		bar === replacementBySlot(league, pool.filter(r =>
			![...board, ...runOnCatchers].some(x => key(x) === key(r))), teams).get(slot)))
// Counted exactly, not bounded: `recent` is one round and `gone` is the whole
// draft, and a `recent` that had quietly widened to the whole draft still sits
// under `teams` on a board this size — so a bound would not notice.
const marked = [...board, ...runOnCatchers]
t("the run itself is reported, in the order it was marked",
	runCliff.gone === marked.filter(r => r.slots.includes("C")).length &&
		runCliff.recent === marked.slice(-teams).filter(r => r.slots.includes("C")).length &&
		runCliff.recent < runCliff.gone,
	`${runCliff.gone} gone, ${runCliff.recent} of the last ${teams}`)
console.log(`      → ${afterRun.explanation}`)

// A cliff is the drop between the two men, which with the slot open is just the
// points between them — the bar cancels, because both would fill the same spot.
t("an open slot's cliff is the points gap between the two men",
	Math.abs(openCliff.cliff - (openCliff.best.player.points - openCliff.next.player.points)) < 0.02,
	`${openCliff.cliff} vs ${openCliff.best.player.points} − ${openCliff.next.player.points}`)

// --- what it refuses to do ---
const offBoard = new Set([...board, ...runOnCatchers].map(key))
t("nobody already off the board is ever recommended",
	!offBoard.has(key(afterRun.pick.player)) &&
		afterRun.alternatives.every(c => !offBoard.has(key(c.player))) &&
		afterRun.cliffs.every(c => !c.best || !offBoard.has(key(c.best.player))))
t("a player on my team is not offered back to me",
	withC.alternatives.every(c => !stocked.some(m => key(m) === key(c.player))))
t("holding someone you never marked taken is reported, not silently repaired",
	advise(stocked, []).missing.some(m => m.includes(catcher.player.name)),
	advise(stocked, []).missing.slice(0, 1).join(""))
// Every candidate the advice exposes, not just the alternatives: a man already on
// your roster gains nothing by being added twice, so he sorts to the bottom of the
// alternatives on his own and that list would pass whether or not he was excluded.
// The cliff rows are where it shows — he is the best projection at his slot, so a
// tie at zero gain puts him back on top of it.
const unmarked = advise(stocked, [])
const exposed = a => [a.pick, ...a.alternatives, ...a.cliffs.flatMap(c => [c.best, c.next])]
	.filter(c => c !== null)
t("and he is still kept off the board",
	exposed(unmarked).every(c => !stocked.some(m => key(m) === key(c.player))),
	exposed(unmarked).filter(c => stocked.some(m => key(m) === key(c.player)))
		.map(c => `${c.player.player.name} +${c.gain}`).join(", "))

// The gain has to be the difference between two real lineups, not a shortcut.
const bars = withoutC.bars
t("every gain is the difference the lineup actually makes",
	[withoutC.pick, ...withoutC.alternatives].every(c =>
		Math.abs(
			c.gain -
				(startingLineup(league, [...bats, c.player], bars).points -
					startingLineup(league, bats, bars).points)
		) < 0.02))
t("the advice does not depend on the order the roster arrives in",
	advise([...bats].reverse(), board).pick.player.player.id === withoutC.pick.player.player.id)

// --- what this tab is worth, against the tab next to it ---
//
// The Draft tab is one of four permanent tabs and is useful for a few days a year,
// so what it says that the Recommendations board does not is measured rather than
// asserted in prose. Draft.tsx now tells the reader the first half of this out
// loud, and that sentence has to keep being true.
const bscoreOrder = pool.filter(r => r.rateable).sort((a, b) => b.bscore - a.bscore)
const fresh = advise([], [])
const freshTop = [fresh.pick, ...fresh.alternatives].filter(Boolean)
const boardTop = new Set(bscoreOrder.slice(0, freshTop.length).map(key))
t("with nothing marked, the draft's order IS the board's — a gain against an empty roster is just his value",
	freshTop.every(c => boardTop.has(key(c.player))),
	`${freshTop.filter(c => boardTop.has(key(c.player))).length} of ${freshTop.length} shared`)
// and the divergence, which is the whole reason the tab exists
const fiveOF = bscoreOrder.filter(r => r.slots.includes("OF")).slice(0, 5)
const stuffedOF = advise(fiveOF, [])
const stuffedTop = [stuffedOF.pick, ...stuffedOF.alternatives].filter(Boolean)
t("fill the outfield and outfielders leave the top of the list entirely",
	stuffedTop.filter(c => c.at === "OF").length === 0 &&
		freshTop.some(c => c.at === "OF"),
	`${stuffedTop.filter(c => c.at === "OF").length} OF left, from ${freshTop.filter(c => c.at === "OF").length}`)
// The cliff table has no counterpart on the board at all: it prices WAITING per
// slot, and the board ranks players. A flat table would be one worth cutting.
const drops = fresh.cliffs.filter(c => c.cliff !== null).map(c => c.cliff)
t("the cliff table separates the slots that punish waiting from the ones that don't",
	drops.length > 4 && Math.max(...drops) > 5 * Math.min(...drops),
	`min ${Math.min(...drops).toFixed(2)}, max ${Math.max(...drops).toFixed(2)} over ${drops.length} slots`)

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
