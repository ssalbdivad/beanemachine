// What actually happened, and what it cost you.
//
// Two files under test and one claim between them. `src/data/actuals.ts` turns MLB's
// own byDateRange read into real points; `src/auto/recap.ts` turns those into the three
// numbers a manager wants the next morning — what his men scored, what his LINEUP
// scored, and what the best lineup he could have set would have scored.
//
// The distinction this suite exists to defend is the one a recap is easiest to get
// wrong: DID NOT PLAY and SCORED NOTHING are different facts. The committed fixture
// carries both — Jo Adell went 0-for-4 on 2026-09-11 and is worth exactly 0.0 in this
// league, while a man with no split at all is worth `null`. An app that shows a null as
// a 0 tells you your shortstop had a bad night when he was never in the park.
//
// The fixtures are real responses, trimmed to eight men: every stat line below was
// produced by the 2026-09-11 slate, not invented, so the points asserted here are
// points Yahoo actually paid out for that day in league 228947's scoring.
//
// One live request is made at the end, to one public endpoint, once per run.
import { readActuals, fetchActuals, ACTUALS_URL } from "../src/data/actuals.ts"
import { recap } from "../src/auto/recap.ts"
import { readFileSync } from "node:fs"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.005

const fixture = name =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const HIT = fixture("mlb-byDateRange-hitting-2026-09-11.json")
const PIT = fixture("mlb-byDateRange-pitching-2026-09-11.json")

const hitting = readActuals("hitting", HIT)
const pitching = readActuals("pitching", PIT)
const lines = new Map([...hitting, ...pitching].map(l => [l.key, l]))

// --- the read -------------------------------------------------------------------

t("every hitting split becomes a line", hitting.length === 5, `got ${hitting.length}`)
t("every pitching split becomes a line", pitching.length === 3, `got ${pitching.length}`)
t(
  "a line is keyed the way a roster keys him",
  lines.has("663656:hitting") && lines.has("669160:pitching"),
  [...lines.keys()].join(",")
)
// A two-way player is two rows and only a roster knows which he holds — so the side of
// the ball is part of the key, not a property of the man.
t(
  "the same id on the other side of the ball is a different key",
  lines.get("663656:hitting").group === "hitting" && !lines.has("663656:pitching")
)
t("the man's name comes through", lines.get("663656:hitting").name === "Kyle Tucker")

// The capture filter, applied here too: a browser is sent 42 fields, not 67. See
// KEPT_STATS in src/engine/points.ts for what that was worth on the committed snapshot.
const tucker = lines.get("663656:hitting").stats
t("fields nothing reads are dropped", !("airOuts" in tucker) && !("babip" in tucker), Object.keys(tucker).join(","))
t("fields the scoring reads survive", tucker.hits === 3 && tucker.homeRuns === 1 && tucker.rbi === 5)
// Baseball's innings are thirds, so the pitching side is scored off `outs` and never
// off the decimal `inningsPitched` — 85.2 means eighty-five and two thirds.
t("a start is carried as outs", lines.get("671737:pitching").stats.outs === 18)

t("a response with no stats is an empty day, not a throw", readActuals("hitting", {}).length === 0)
t("a split with no player id is skipped", readActuals("hitting", { stats: [{ splits: [{ stat: { hits: 1 } }] }] }).length === 0)
t("the url asks for one day", ACTUALS_URL(2026, "hitting", "2026-09-11").includes("startDate=2026-09-11&endDate=2026-09-11"))

// --- the league the recap is scored in ------------------------------------------

/** League 228947's real batting and pitching tables, and a roster shape small enough
 *  to reason about by hand: one OF, one Util, one SP, two bench, one IL. */
const LEAGUE = {
  meta: { platform: "yahoo" },
  scoring: {
    unit: "points",
    batting: { R: 1.9, "1B": 2.6, "2B": 5.2, "3B": 7.8, HR: 10.4, RBI: 1.9, SB: 4.2, BB: 2.6, HBP: 2.6 },
    pitching: { W: 8, SV: 8, OUT: 1, H: -1.3, ER: -3, BB: -1.3, HBP: -1.3, K: 3 }
  }
}
const SHAPE = {
  slots: { OF: 1, Util: 1, SP: 1, BN: 2, IL: 1 },
  slot_order: ["OF", "Util", "SP", "BN", "BN", "IL"],
  slot_accepts: {
    OF: ["OF"],
    Util: ["C", "1B", "2B", "3B", "SS", "OF"],
    SP: ["SP"],
    BN: "any",
    IL: "injured_only"
  }
}

const MAN = {
  tucker: { key: "663656:hitting", name: "Kyle Tucker", positions: ["OF"] },
  bregman: { key: "608324:hitting", name: "Alex Bregman", positions: ["3B"] },
  adell: { key: "666176:hitting", name: "Jo Adell", positions: ["OF"] },
  albies: { key: "645277:hitting", name: "Ozzie Albies", positions: ["2B"] },
  bradley: { key: "671737:pitching", name: "Taj Bradley", positions: ["SP"] },
  may: { key: "669160:pitching", name: "Dustin May", positions: ["SP"] }
}
const seated = (man, slot) => ({ ...man, slot })

// Hand-computed from the fixture lines against the table above. Tucker: 2 runs (3.8),
// one single (2.6), a triple (7.8), a homer (10.4) and 5 RBI (9.5) = 34.1.
const POINTS = { tucker: 34.1, bregman: 25.8, adell: 0, albies: 1.9, bradley: 29.5, may: 40.1 }

const team = [
  seated(MAN.tucker, "OF"),
  seated(MAN.adell, "Util"),
  seated(MAN.bradley, "SP"),
  seated(MAN.bregman, "BN"),
  seated(MAN.albies, "BN"),
  seated(MAN.may, "IL")
]
const r = recap({ date: "2026-09-11", men: team, lines, league: LEAGUE, shape: SHAPE })

// --- one man's night ------------------------------------------------------------

const of = name => r.men.find(m => m.name === name)
t("a big night is priced in the league's own scoring", near(of("Kyle Tucker").points, POINTS.tucker), String(of("Kyle Tucker").points))
t("a start is priced off outs, walks and strikeouts", near(of("Taj Bradley").points, POINTS.bradley), String(of("Taj Bradley").points))
t("a win is worth the win", near(of("Dustin May").points, POINTS.may), String(of("Dustin May").points))

// THE DISTINCTION. Adell played and was worth nothing; a man with no split was not in
// the park, and the two must never print the same.
t("0-for-4 is zero points, not nothing", of("Jo Adell").points === 0)
const withGhost = recap({
  date: "2026-09-11",
  men: [...team, { key: "999999:hitting", name: "Nobody Played", slot: "BN", positions: ["OF"] }],
  lines, league: LEAGUE, shape: SHAPE
})
t("a man who did not appear is null, not zero", withGhost.men.find(m => m.name === "Nobody Played").points === null)
t("did-not-play sorts below played-and-bad", withGhost.men.at(-1).name === "Nobody Played", withGhost.men.map(m => m.name).join(","))
t("a null adds nothing to the total", near(withGhost.ownedTotal, r.ownedTotal))
t("the night is explained by its biggest categories", of("Kyle Tucker").top[0].code === "HR", JSON.stringify(of("Kyle Tucker").top))
t("a category he did not touch is not listed", !of("Kyle Tucker").top.some(x => x.code === "SB"))

// --- the three totals ----------------------------------------------------------

t("what your men scored counts everybody you hold", near(r.ownedTotal, 131.4), String(r.ownedTotal))
t("what your lineup scored counts only startable seats", near(r.startedTotal, 63.6), String(r.startedTotal))
t("the best lineup you could have set", near(r.best.total, 89.4), String(r.best.total))
t("points left on the bench is the difference", near(r.leftOnBench, 25.8), String(r.leftOnBench))
t("nothing is blocked when the seats are known", r.blocked.length === 0, r.blocked.join(" | "))
t("every category in this league can be sourced", r.unscoreable.length === 0, r.unscoreable.join(","))

// The hindsight lineup is seated by the planner's own solver, so it is the BEST legal
// one and not merely a good one: Bregman is a third baseman and the only seat he can
// reach is Util, which is exactly the seat the 0-point outfielder was using.
t("the best lineup fills every seat it can", r.best.seated.length === 3, JSON.stringify(r.best.seated))
t("the bench man takes the seat he is legal for", r.best.seated.find(s => s.slot === "Util").name === "Alex Bregman")

// --- the one swap that explains the gap -----------------------------------------

t("the biggest regret names both sides", r.biggest && r.biggest.in === "Alex Bregman" && r.biggest.out === "Jo Adell", JSON.stringify(r.biggest))
t("its swing is the whole gap when one swap explains it", near(r.biggest.swing, 25.8), String(r.biggest?.swing))
// A perfect lineup has no regret to report, and reporting one anyway is the failure
// mode that would make this screen nag.
const perfect = recap({
  date: "2026-09-11",
  men: [seated(MAN.tucker, "OF"), seated(MAN.bregman, "Util"), seated(MAN.bradley, "SP"), seated(MAN.adell, "BN")],
  lines, league: LEAGUE, shape: SHAPE
})
t("a lineup that was already best leaves nothing on the bench", near(perfect.leftOnBench, 0), String(perfect.leftOnBench))
t("and is told nothing it should have done", perfect.biggest === null, JSON.stringify(perfect.biggest))

// --- the injured list is not hindsight ------------------------------------------

// Dustin May outscored everybody on this roster and could not have been started: he was
// on the IL, and activating him was a roster move that day's lineup did not have. A
// regret built on him would be a fiction.
t("a man on the injured list is not in the best lineup", !r.best.seated.some(s => s.name === "Dustin May"), JSON.stringify(r.best.seated))
const mayBenched = recap({
  date: "2026-09-11",
  men: team.map(m => (m.name === "Dustin May" ? { ...m, slot: "BN" } : m)),
  lines, league: LEAGUE, shape: SHAPE
})
t("the same man on the bench IS in it", near(mayBenched.best.total, 100.0), String(mayBenched.best.total))

// --- a team nobody read the seats of -------------------------------------------

// The hand-typed route produces a full roster with no seats at all, which is the common
// case rather than the edge one. It gets the totals it can have and is told, in words,
// which one it cannot.
const noSeats = recap({
  date: "2026-09-11",
  men: team.map(m => ({ ...m, slot: null })),
  lines, league: LEAGUE, shape: SHAPE
})
t("what your men scored still works with no seats", near(noSeats.ownedTotal, 131.4), String(noSeats.ownedTotal))
t("what your lineup scored is refused, not invented", noSeats.startedTotal === null)
t("and so is the bench gap", noSeats.leftOnBench === null && noSeats.biggest === null)
t("and the refusal says so in the reader's words", noSeats.blocked.some(b => /which of your men were in your lineup/.test(b)), noSeats.blocked.join(" | "))
t("the best lineup is still worth showing", near(noSeats.best.total, 100.0), String(noSeats.best.total))

// --- what the league states and MLB cannot answer -------------------------------

const withQS = recap({
  date: "2026-09-11",
  men: team,
  lines,
  league: { ...LEAGUE, scoring: { ...LEAGUE.scoring, pitching: { ...LEAGUE.scoring.pitching, QS: 4 } } },
  shape: SHAPE
})
t("a category MLB's day read cannot source is surfaced", withQS.unscoreable.includes("QS"), withQS.unscoreable.join(","))
t("and is not quietly scored as zero", near(withQS.men.find(m => m.name === "Taj Bradley").points, POINTS.bradley))

const noAccepts = recap({
  date: "2026-09-11", men: team, lines, league: LEAGUE,
  shape: { ...SHAPE, slot_accepts: null }
})
t("a league that never said what its seats accept gets no best lineup", noAccepts.best.total === 0 && noAccepts.blocked.some(b => /which players its seats accept/.test(b)), noAccepts.blocked.join(" | "))
t("but still gets what his men scored", near(noAccepts.ownedTotal, 131.4))

// --- one live request ----------------------------------------------------------

// Yesterday, from MLB, for real. Asserted loosely on purpose: the claim is that the
// read still works and still carries scorable fields, not that any particular man
// played. A failure here is a changed endpoint, which is worth knowing about.
const d = new Date(Date.now() - 36 * 3_600_000)
const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const live = await fetchActuals(2026, yesterday)
if (live.error) {
  console.log(`SKIP  live read of ${yesterday}: ${live.error}`)
} else {
  t(`live read of ${yesterday} returns men who played`, live.actuals.lines.size > 0, String(live.actuals.lines.size))
  const one = [...live.actuals.lines.values()].find(l => l.group === "hitting")
  t("a live line carries a name and scorable counting stats", !!one?.name && typeof one.stats.plateAppearances === "number", JSON.stringify(one?.stats ?? null).slice(0, 120))
  const liveRecap = recap({
    date: yesterday,
    men: [{ key: one.key, name: one.name, slot: "Util", positions: ["OF"] }],
    lines: live.actuals.lines, league: LEAGUE, shape: SHAPE
  })
  t("a live line prices into real points", typeof liveRecap.ownedTotal === "number" && Number.isFinite(liveRecap.ownedTotal), String(liveRecap.ownedTotal))
}

console.log(`passed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
