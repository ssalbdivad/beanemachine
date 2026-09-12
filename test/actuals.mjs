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
import { recap, gradeRecord, bestNights } from "../src/auto/recap.ts"
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

// --- a best lineup that is worse than the real one is not a bench gap -----------

// `best` can only seat a man the league's own slot_accepts table proves legal for a seat,
// and a reader's real lineup is not bound by what this app can prove: the committed
// capture's eligibility grid covers 328 of 1,446 players, so a man started at 3B whose
// stored eligibility says only "DH" is seatable nowhere here. A negative "points left on
// your bench" is nonsense and silently hiding it would be an absence dressed as a zero.
const unprovable = recap({
  date: "2026-09-11",
  men: [
    // started, and legal for nothing this league's table lists
    { ...MAN.tucker, positions: ["DH"], slot: "OF" },
    seated(MAN.bradley, "SP"),
    seated(MAN.adell, "BN")
  ],
  lines, league: LEAGUE, shape: SHAPE
})
t("a starter the eligibility cannot place is not in the best lineup", !unprovable.best.seated.some(s => s.name === "Kyle Tucker"), JSON.stringify(unprovable.best.seated))
t("what he actually scored still counts towards your lineup", near(unprovable.startedTotal, 63.6), String(unprovable.startedTotal))
t("and the bench gap is refused rather than reported negative", unprovable.leftOnBench === null, String(unprovable.leftOnBench))
t("with the reason said in the reader's words", unprovable.blocked.some(b => /does not cover 1 of the men you started/.test(b)), unprovable.blocked.join(" | "))
t("and no regret is invented from an incomplete lineup", unprovable.biggest === null)
// The ordinary case is untouched: where every starter can be placed, the gap is reported.
t("a comparable day still reports its gap", near(r.leftOnBench, 25.8), String(r.leftOnBench))

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

// --- the three states that look exactly like a bad night -------------------------

// Everything above this line is a sum over men, and a sum cannot tell "did not play"
// from "nobody could ask". These assert the three places that difference is
// load-bearing, all three of which shipped as a confident zero and were found by a
// refute pass rather than by a walk.

// ONE SIDE OF THE BALL DID NOT ANSWER. `fetchActuals` keeps a partial day on purpose, so
// the cost lands here: with the hitting read failed, every hitter held looks like he sat
// out. The total of the men who WERE checked survives; every comparison is refused.
const partial = recap({
  date: "2026-09-11",
  men: team,
  lines: new Map(pitching.map(l => [l.key, l])),
  league: LEAGUE, shape: SHAPE,
  missing: ["hitting"]
})
t("a side that did not answer is named as unread, not as absent", partial.men.find(m => m.name === "Kyle Tucker").unread === true)
t("a man on the side that DID answer is not marked unread", partial.men.find(m => m.name === "Taj Bradley").unread === false)
t("what the answered side scored is still totalled", near(partial.ownedTotal, 69.6), String(partial.ownedTotal))
t("the lineup total is refused under a partial read", partial.startedTotal === null, String(partial.startedTotal))
t("and so is the bench gap and the regret", partial.leftOnBench === null && partial.biggest === null)
t("the refusal counts the men nobody could check", partial.blocked.some(b => /4 of your men could not be checked/.test(b)), partial.blocked.join(" | "))
t("and says it once rather than twice", partial.blocked.length === 1, partial.blocked.join(" | "))
t("the sides that failed come out on the recap", partial.unread.join(",") === "hitting")

// NO BASEBALL AT ALL. An off day, a break, a date before the season: `lines` is empty for
// the whole of baseball, and "your lineup scored 0" is then a statement about the
// calendar wearing a statement about your team's clothes.
const offDay = recap({ date: "2026-04-01", men: team, lines: new Map(), league: LEAGUE, shape: SHAPE })
t("an empty day for all of baseball is flagged as one", offDay.noGames === true)
t("and every total that would read as a shutout is refused", offDay.startedTotal === null && offDay.leftOnBench === null && offDay.biggest === null)
t("with the reason in the reader's words", offDay.blocked.some(b => /no box scores at all/.test(b)), offDay.blocked.join(" | "))
t("nobody played, and it is counted rather than implied", offDay.played === 0)

// MY MEN DID NOT PLAY, WHICH IS A DIFFERENT THING. Baseball happened; none of it was
// his. `noGames` is false, the zero is honest, and the count is what lets the card say
// which of the two it is.
const theirsNotMine = recap({
  date: "2026-09-11",
  men: [{ key: "999999:hitting", name: "Nobody Played", slot: "OF", positions: ["OF"] }],
  lines, league: LEAGUE, shape: SHAPE
})
t("a day of baseball none of whose games were yours is not an empty day", theirsNotMine.noGames === false)
t("and none of his men played", theirsNotMine.played === 0)
t("a day somebody played is counted", r.played === 6, String(r.played))

// THE MAN COMING IN MUST HAVE PLAYED. A bench man who never took the field scores the
// same nothing an empty seat does — but a starter can score BELOW zero, and the
// subtraction then made a "swap" out of a man who did not pitch. No man in the committed
// fixture scored negative, so this line is CONSTRUCTED: three outs and seven earned runs,
// which is a real shelling and prices at 3 - 21 - 6.5 = -24.5 in this league.
const shelled = new Map(lines)
shelled.set("671737:pitching", {
  key: "671737:pitching", id: "671737", group: "pitching", name: "Taj Bradley",
  stats: { outs: 3, earnedRuns: 7, hits: 5, baseOnBalls: 0, strikeOuts: 0, wins: 0, saves: 0, hitByPitch: 0 }
})
const ghostOverShelling = recap({
  date: "2026-09-11",
  men: [
    seated(MAN.bradley, "SP"),
    seated(MAN.tucker, "OF"),
    { key: "999998:pitching", name: "Never Pitched", slot: "BN", positions: ["SP"] }
  ],
  lines: shelled, league: LEAGUE, shape: SHAPE
})
t("the constructed shelling really is negative", near(ghostOverShelling.men.find(m => m.name === "Taj Bradley").points, -24.5), String(ghostOverShelling.men.find(m => m.name === "Taj Bradley").points))
t("a man who did not play is never the swap you missed", ghostOverShelling.biggest === null, JSON.stringify(ghostOverShelling.biggest))
// And the swap that IS real carries what each man actually did, because "scored 25.8
// more than him" over a man with no box score is a comparison with nothing.
t("a real swap carries both men's own numbers", near(r.biggest.inPoints, 25.8) && r.biggest.outPoints === 0, JSON.stringify(r.biggest))

// --- Billy, graded against the lineup you already had ---------------------------

// The comparison the whole record rests on: two lineups, one that was recommended and
// one that was already in place, both scored against what those men actually did.
const byDate = new Map([["2026-09-11", lines]])
const side = (man, projected) => ({ key: man.key, name: man.name, slot: null, projected })

// A day Billy got right: he asked for Tucker (34.1) where Adell (0.0) was starting.
const won = {
  date: "2026-09-11", at: "2026-09-11T18:41:00.000Z",
  start: [side(MAN.tucker, 12), side(MAN.bradley, 20)],
  sit: [side(MAN.adell, 3)],
  had: [side(MAN.adell, 3), side(MAN.bradley, 20)]
}
const g1 = gradeRecord({ entries: [won], byDate, league: LEAGUE })
t("a graded day scores the lineup that was asked for", near(g1.days[0].asked, 63.6), String(g1.days[0].asked))
t("and the lineup that was already there", near(g1.days[0].had, 29.5), String(g1.days[0].had))
t("what following it was worth is the difference", near(g1.days[0].worth, 34.1), String(g1.days[0].worth))
t("a day he asked for a change counts towards the record", g1.changed === 1 && g1.better === 1 && g1.worse === 0)
t("and both numbers are kept per man, projected beside actual", g1.days[0].calls.some(c => c.name === "Kyle Tucker" && c.projected === 12 && near(c.actual, 34.1)), JSON.stringify(g1.days[0].calls))
t("the man asked to sit is on the other side of the entry", g1.days[0].calls.some(c => c.name === "Jo Adell" && c.side === "out"))

// A day he got it wrong. A record that can only flatter is not a record.
const lost = {
  date: "2026-09-11", at: "2026-09-11T18:41:00.000Z",
  start: [side(MAN.albies, 14)], sit: [side(MAN.bregman, 9)], had: [side(MAN.bregman, 9)]
}
const g2 = gradeRecord({ entries: [lost], byDate, league: LEAGUE })
t("a day he got wrong is negative", near(g2.days[0].worth, -23.9), String(g2.days[0].worth))
t("and is counted as wrong", g2.worse === 1 && g2.better === 0)
t("the net is allowed to be negative", near(g2.net, -23.9), String(g2.net))

// Two days, one each way, so the net is arithmetic rather than a sign.
const both = gradeRecord({
  entries: [won, { ...lost, date: "2026-09-10" }],
  byDate: new Map([["2026-09-11", lines], ["2026-09-10", lines]]),
  league: LEAGUE
})
t("the net sums the days it graded", near(both.net, 10.2), String(both.net))
t("the days come back oldest first", both.days.map(d => d.date).join(",") === "2026-09-10,2026-09-11", both.days.map(d => d.date).join(","))

// THE DENOMINATOR. Most days a lineup is already the best one and the advice is "leave it
// alone", which is worth nothing and would flatter a win rate computed over every day.
const same = {
  date: "2026-09-11", at: "2026-09-11T18:41:00.000Z",
  start: [side(MAN.tucker, 12)], sit: [], had: [side(MAN.tucker, 12)]
}
const g3 = gradeRecord({ entries: [same], byDate, league: LEAGUE })
t("a day he left the lineup alone is not counted as a win", g3.changed === 0 && g3.better === 0, JSON.stringify({ changed: g3.changed, better: g3.better }))
t("it is counted as what it was", g3.unchanged === 1)
t("and is worth nothing either way", near(g3.days[0].worth, 0))

// A real change that happened to be worth exactly nothing: Turang and Tucker both went
// 3-for-3 with a homer on 2026-09-11 and both price at 34.1 in this league.
const tie = {
  date: "2026-09-11", at: "2026-09-11T18:41:00.000Z",
  start: [{ key: "668930:hitting", name: "Brice Turang", slot: null, projected: 11 }],
  sit: [side(MAN.tucker, 12)], had: [side(MAN.tucker, 12)]
}
const g4 = gradeRecord({ entries: [tie], byDate, league: LEAGUE })
t("a change worth exactly nothing is counted as even, not as a win", g4.changed === 1 && g4.even === 1 && g4.better === 0, JSON.stringify({ changed: g4.changed, even: g4.even, better: g4.better }))

// Days it will not grade, each for a stated reason rather than silently.
const ungradeable = gradeRecord({
  entries: [
    // results in, seats never read: the day is scored but not compared
    { date: "2026-09-11", at: "x", start: [side(MAN.tucker, 12)], sit: [], had: [] },
    // results not in yet: nothing can be said about it at all
    { date: "2026-09-08", at: "x", start: [side(MAN.tucker, 12)], sit: [], had: [side(MAN.adell, 3)] },
    // the app was opened and had nothing to suggest
    { date: "2026-09-10", at: "x", start: [], sit: [], had: [side(MAN.adell, 3)] }
  ],
  byDate: new Map([["2026-09-11", lines], ["2026-09-10", lines]]),
  league: LEAGUE
})
t("a day with no seats on record is not a tie", ungradeable.days.find(d => d.date === "2026-09-11").worth === null, JSON.stringify(ungradeable.days))
t("but what was asked for is still scored", near(ungradeable.days.find(d => d.date === "2026-09-11").asked, 34.1))
t("and says why it stops there", ungradeable.skipped.some(s => s.date === "2026-09-11" && /which of your men were in your lineup/.test(s.why)), JSON.stringify(ungradeable.skipped))
t("a day whose results are not in yet is skipped", ungradeable.skipped.some(s => s.date === "2026-09-08" && /results aren't in yet/.test(s.why)), JSON.stringify(ungradeable.skipped))
t("a day with no recommendation is not graded", !ungradeable.days.some(d => d.date === "2026-09-10"), JSON.stringify(ungradeable.days.map(d => d.date)))
t("no ungradeable day reaches the record", ungradeable.changed === 0 && ungradeable.net === 0)

// A recommended starter who never took the field cost you the seat, and is scored that
// way — which is the one place an absence is a zero rather than a null.
const ghostStart = gradeRecord({
  entries: [{
    date: "2026-09-11", at: "x",
    start: [{ key: "999999:hitting", name: "Nobody Played", slot: null, projected: 15 }],
    sit: [], had: [side(MAN.albies, 2)]
  }],
  byDate, league: LEAGUE
})
t("starting a man who never played is scored as nothing, not skipped", near(ghostStart.days[0].asked, 0) && near(ghostStart.days[0].worth, -1.9), JSON.stringify(ghostStart.days[0]))
t("and his own line still reads as did-not-play", ghostStart.days[0].calls.find(c => c.name === "Nobody Played").actual === null)

// A day already settled needs no results at all, which is what makes a running record
// free: sixty days graded from live reads would be 120 requests and about 2.3 MB of wire
// every time the strip rendered, for answers that cannot change.
const settled = gradeRecord({
  entries: [
    { date: "2026-08-01", at: "x", start: [], sit: [], had: [],
      graded: { asked: 90, had: 70, worth: 20, unchanged: false } },
    { date: "2026-08-02", at: "x", start: [], sit: [], had: [],
      graded: { asked: 50, had: 62, worth: -12, unchanged: false } },
    { date: "2026-08-03", at: "x", start: [], sit: [], had: [],
      graded: { asked: 44, had: 44, worth: 0, unchanged: true } },
    won
  ],
  byDate, league: LEAGUE
})
t("a stored verdict is used without a request", settled.days.length === 4, String(settled.days.length))
t("and counts towards the record exactly as a fresh grade does", settled.changed === 3 && settled.better === 2 && settled.worse === 1, JSON.stringify({ changed: settled.changed, better: settled.better, worse: settled.worse }))
t("a stored unchanged day is still not a win", settled.unchanged === 1)
t("the net sums stored and fresh days together", near(settled.net, 42.1), String(settled.net))
// Yesterday is the only day the per-man detail is ever shown for, so it is the only day
// it is carried. A stored day has none and must not pretend to.
t("a stored day carries no invented per-man detail", settled.days.find(d => d.date === "2026-08-01").calls.length === 0)
t("while the freshly graded day has it", settled.days.find(d => d.date === "2026-09-11").calls.length > 0)

// --- the best nights in baseball, for a reader who has told the page nothing ------

// The one thing the app can put in front of a stranger that needs nothing from him. Before
// this existed, every number a first visit could see was about a borrowed league and a board
// ranked by value over replacement — which correctly puts unrostered men on top and, measured
// on the committed capture, made the first five names three White Sox and two men from the two
// worst teams in baseball.
{
  const top = bestNights(lines, LEAGUE, 8)
  t("the biggest night in the fixture leads", top[0].name === "Dustin May" && near(top[0].points, POINTS.may), JSON.stringify(top[0]))
  t("both sides of the ball are in one list", top.some(x => x.group === "hitting") && top.some(x => x.group === "pitching"))
  t("it is ordered by what the night was worth", top.every((x, i) => i === 0 || x.points <= top[i - 1].points), top.map(x => x.points).join(","))
  t("each night says what carried it", top[0].top[0].code === "K" || top[0].top[0].code === "OUT", JSON.stringify(top[0].top))
  t("the club comes through", top[0].team === "Milwaukee Brewers", String(top[0].team))
  // A night worth nothing is not one of the best nights. Jo Adell went 0-for-4 in this
  // fixture, and a list headed "the best nights" with a 0.0 at the foot reads as a list that
  // ran out. An exact tie between two men is kept in name order so two runs agree.
  t("a scoreless night is not one of the best", !top.some(x => x.name === "Jo Adell"), top.map(x => x.name).join(","))
  t("and the list is as long as there are nights worth showing", top.length === 7, String(top.length))
  t("a tie is broken by name so two runs agree", top[1].name === "Brice Turang" && top[2].name === "Kyle Tucker", top.map(x => x.name).join(","))
  t("asking for fewer gives the best of them", bestNights(lines, LEAGUE, 3).length === 3)
}

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
