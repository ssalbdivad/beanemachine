// The decision card, in a real browser, against a team this test constructs.
//
// The roster and the wire are BUILT HERE from the committed snapshot rather than
// loaded from anybody's file: the card's whole job is to answer for a specific
// team, and a test that needed a real person's roster could neither be committed
// nor re-run by someone else. Every player named below is in data/snapshot.json,
// so the projections behind the assertions are the ones the app really computes.
import { chromium } from "playwright-core"
import { readFileSync } from "node:fs"

const BASE = process.env.BASE ?? "http://127.0.0.1:5173"
const browser = await chromium.launch({ args: ["--no-sandbox"] })
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const league = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const KEY = "yahoo:228947"

/** Seat the N best players at each position the league seats, so the constructed
 *  team is a legal one rather than an arbitrary bag of names. */
const bestAt = (pos, n, taken) =>
	snap.players
		.filter(p => p.group === "hitting" && p.position === pos && !taken.has(p.name))
		.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
		.slice(0, n)
const pitchers = n =>
	snap.players
		.filter(p => p.group === "pitching")
		.sort((a, b) => (b.stats?.outs ?? 0) - (a.stats?.outs ?? 0))
		.slice(0, n)

const taken = new Set()
const spots = []
const seat = (slot, p, positions) => { taken.add(p.name); spots.push({ slot, name: p.name, positions, team: null }) }
for (const [pos, slot] of [["C", "C"], ["1B", "1B"], ["2B", "2B"], ["3B", "3B"], ["SS", "SS"]])
	for (const p of bestAt(pos, 1, taken)) seat(slot, p, [pos])
for (const p of bestAt("LF", 1, taken)) seat("OF", p, ["OF"])
for (const p of bestAt("CF", 1, taken)) seat("OF", p, ["OF"])
for (const p of bestAt("RF", 1, taken)) seat("OF", p, ["OF"])
const arms = pitchers(8)
;["SP", "SP", "RP", "RP", "P", "P", "P", "P"].forEach((slot, i) => {
	if (arms[i]) seat(slot, arms[i], [slot === "RP" ? "RP" : "SP"])
})
/** One deliberately terrible bench bat, so there is something to drop. */
const scrub = snap.players.find(
	p => p.group === "hitting" && p.position === "1B" && (p.stats?.plateAppearances ?? 0) > 20 &&
		(p.stats?.plateAppearances ?? 0) < 60 && !taken.has(p.name)
)
if (scrub) seat("BN", scrub, ["1B"])

/** A wire of good, unrostered bats — men the card should want. */
const wire = snap.players
	.filter(p => p.group === "hitting" && !taken.has(p.name) && (p.stats?.plateAppearances ?? 0) > 400)
	.sort((a, b) => (b.stats?.plateAppearances ?? 0) - (a.stats?.plateAppearances ?? 0))
	.slice(0, 25)
	.map(p => ({ yahooId: String(p.id), name: p.name, team: p.team ?? null, positions: ["1B", "OF"] }))

const seedLineup = { [KEY]: { at: new Date().toISOString(), spots } }
const seedPool = {
	[KEY]: {
		at: new Date().toISOString(), leagueId: "228947", players: wire,
		positionsRead: ["1B", "OF"], note: "constructed by test/decide.mjs"
	}
}

const open = async seeds => {
	const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } })
	await page.addInitScript(([l, p, cfgLeague]) => {
		if (l) localStorage.setItem("beanemachine:lineup", JSON.stringify(l))
		if (p) localStorage.setItem("beanemachine:pool", JSON.stringify(p))
		void cfgLeague
	}, [seeds.lineup ?? null, seeds.pool ?? null, league])
	await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 })
	await page.waitForSelector(".decide", { timeout: 30000 })
	await page.waitForTimeout(1500)
	return page
}

/**
 * With a team and a wire, the card names both sides of every move.
 *
 * This is the whole claim: a ranked list is not a decision, and a decision that
 * does not say who leaves cannot be carried out.
 */
{
	const page = await open({ lineup: seedLineup, pool: seedPool })
	const text = await page.$eval(".decide", e => e.innerText)
	t("the card is the first thing on the page, above the board",
		await page.evaluate(() => {
			const d = document.querySelector(".decide"), b = document.querySelector(".board")
			return !b || d.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
		}), text.slice(0, 60))
	t("it answers for the league's own scoring period, not a fortnight",
		/For <?b?>?(this matchup|this scoring period|today)/.test(text) || /For\s+(this matchup|this scoring period|today)/.test(text),
		text.split("\n").slice(0, 3).join(" | "))
	t("every move it proposes names the man who leaves",
		[...text.matchAll(/^\+[\d.]+\nAdd .+, drop .+$/gm)].length ===
			[...text.matchAll(/^Add /gm)].length,
		text)
	const adds = [...text.matchAll(/Add ([^,]+), drop (.+)/g)].map(m => [m[1], m[2]])
	t("it never proposes adding a player already on the roster",
		adds.every(([a]) => !spots.some(s => s.name === a)), JSON.stringify(adds))
	t("it never proposes dropping a player who is not on the roster",
		adds.every(([, d]) => spots.some(s => s.name === d)), JSON.stringify(adds))
	await page.close()
}

/**
 * Without a roster it says so, and does not pretend.
 *
 * The failure it must never make is answering anyway — a ranked board rendered
 * where an answer belongs reads as an answer.
 */
{
	const page = await open({})
	const text = await page.$eval(".decide", e => e.innerText)
	t("with no roster it names what is missing rather than answering",
		/not been told which players are yours/.test(text), text.slice(0, 160))
	t("and it proposes no moves at all",
		!/Add .+, drop /.test(text), text.slice(0, 200))
	await page.close()
}

/**
 * With a roster but no wire, the lineup half still answers and the moves half
 * refuses — they depend on different things and must fail independently.
 */
{
	const page = await open({ lineup: seedLineup })
	const text = await page.$eval(".decide", e => e.innerText)
	t("the lineup half answers without any free-agent list",
		/Set your lineup/.test(text) && !/not been told which players are yours/.test(text),
		text.slice(0, 160))
	t("and the moves half says why it cannot, naming CORS rather than shrugging",
		/free-agent list/.test(text) && /CORS/.test(text), text)
	await page.close()
}

console.log(`\npassed ${pass}, failed ${fail}`)
await browser.close()
process.exit(fail ? 1 : 0)
