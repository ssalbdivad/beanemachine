// Where a streaming week ends. Pure date arithmetic plus window counting, so this
// suite needs no network and no snapshot — which is the point: the rule about what a
// league's week IS should be pinned somewhere nothing else can move it.
import { resolvePeriod, windowFrom, datesBetween } from "../src/engine/period.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const lg = (scoring_period) => ({ scoring_period })
const WEEK = { kind: "matchup", days: 7, starts_on: "mon", anchor: null, lineup_lock: "daily", source: "test" }
// 2026-09-02 is a Wednesday; the Monday-anchored period holding it is Aug 31 - Sep 6
const WED = "2026-09-02", FAR = "2026-12-31"

// --- the bug this module exists to fix ---
const mid = resolvePeriod(lg(WEEK), WED, FAR)
t("a mid-week streaming window ends when the matchup does, not seven days out",
  mid.start === WED && mid.end === "2026-09-06", `${mid.start} → ${mid.end}`)
t("and it is five dates, not the eight the old rolling window asked for",
  datesBetween(mid.start, mid.end) === 5, String(datesBetween(mid.start, mid.end)))
t("the period's own end is reported even though the window starts today",
  mid.periodEnd === "2026-09-06" && mid.kind === "matchup")
t("a stated period is not flagged as an assumption", mid.assumed === false)

// inclusive boundaries: a seven-day period is seven dates, which is what the
// backtest measures. `now + 7` asked for eight, and that is the off-by-one.
const monday = resolvePeriod(lg(WEEK), "2026-08-31", FAR)
t("a full period opens on its first day and runs seven dates",
  monday.start === "2026-08-31" && monday.end === "2026-09-06" &&
    datesBetween(monday.start, monday.end) === 7, `${monday.start} → ${monday.end}`)

const sunday = resolvePeriod(lg(WEEK), "2026-09-06", FAR)
t("the last day of a period is a one-date window, which is correct and not a bug",
  sunday.start === "2026-09-06" && sunday.end === "2026-09-06" &&
    datesBetween(sunday.start, sunday.end) === 1)

// --- the lock decides WHICH period you are deciding about ---
const locked = resolvePeriod(lg({ ...WEEK, lineup_lock: "period" }), WED, FAR)
t("a lineup locked for the period points the decision at the next one",
  locked.start === "2026-09-07" && locked.end === "2026-09-13",
  `${locked.start} → ${locked.end}`)
t("and says so, because that is not what the reader asked for",
  locked.basis.includes("locked"), locked.basis)

// --- the other league shapes ---
t("a daily-scored league's window is today", (() => {
  const d = resolvePeriod(lg({ ...WEEK, kind: "daily" }), WED, FAR)
  return d.start === WED && d.end === WED && d.kind === "daily"
})())
t("a league with no period gets a rolling window, and is not called an assumption", (() => {
  const r = resolvePeriod(lg({ ...WEEK, kind: "none" }), WED, FAR)
  return r.kind === "rolling" && r.assumed === false && datesBetween(r.start, r.end) === 7
})())
t("a league that has said nothing gets the same window, flagged as assumed", (() => {
  const r = resolvePeriod(lg(null), WED, FAR)
  return r.kind === "rolling" && r.assumed === true && r.basis.includes("has not said")
})())
t("a stated length with no weekday assumes Monday out loud", (() => {
  const r = resolvePeriod(lg({ ...WEEK, starts_on: null }), WED, FAR)
  return r.assumed === true && r.basis.includes("assuming a Monday start")
})())
t("a stated period with no length says it is assuming seven days", (() => {
  const r = resolvePeriod(lg({ ...WEEK, days: null }), WED, FAR)
  return r.assumed === true && r.basis.includes("a seven-day period")
})(), resolvePeriod(lg({ ...WEEK, days: null }), WED, FAR).basis)
t("and a league missing both says both", (() => {
  const r = resolvePeriod(lg({ ...WEEK, days: null, starts_on: null }), WED, FAR)
  return r.basis.includes("a Monday start and a seven-day period")
})(), resolvePeriod(lg({ ...WEEK, days: null, starts_on: null }), WED, FAR).basis)
t("a fully stated period claims no assumptions at all",
  resolvePeriod(lg(WEEK), WED, FAR).basis.includes("assuming") === false)

t("an anchored grid ignores the weekday and counts from the pin", (() => {
  // anchored on a Thursday, ten-day periods: 2026-08-27 + 10 = 2026-09-06
  const r = resolvePeriod(
    lg({ kind: "matchup", days: 10, starts_on: null, anchor: "2026-08-27", lineup_lock: "daily", source: "t" }),
    WED, FAR)
  return r.periodEnd === "2026-09-05" && r.start === WED
})(), JSON.stringify(resolvePeriod(lg({ kind: "matchup", days: 10, starts_on: null, anchor: "2026-08-27", lineup_lock: "daily", source: "t" }), WED, FAR)))

// --- a snapshot cannot answer about games it never captured ---
const clipped = resolvePeriod(lg(WEEK), WED, "2026-09-04")
t("a window is clipped to the games actually captured, and says it was clipped",
  clipped.end === "2026-09-04" && clipped.clipped === true && clipped.periodEnd === "2026-09-06")

// --- counting a window off the slate ---
const slate = [
  { date: "2026-09-02", home: 1, away: 2, homeProbable: 11, awayProbable: 22, final: true },
  { date: "2026-09-03", home: 2, away: 1, homeProbable: 21, awayProbable: null, final: false },
  { date: "2026-09-08", home: 1, away: 3, homeProbable: 12, awayProbable: 33, final: false }
]
const w = windowFrom(slate, "2026-09-02", "2026-09-06")
t("only games inside the window are counted",
  w.games.get(1) === 2 && w.games.get(2) === 2 && w.games.get(3) === undefined,
  JSON.stringify([...w.games]))
t("opponents are one entry per game, not a set",
  JSON.stringify(w.opponents.get(1)) === JSON.stringify([2, 2]))
t("an announced starter is counted once per announced start",
  w.probableStarts.get(11) === 1 && w.probableStarts.get(21) === 1 && w.probableStarts.get(33) === undefined)
// team 1 plays twice in the window: home on the 2nd against 22, away on the 3rd
// against team 2's announced 21. Both count; the unannounced one on the 3rd does not.
t("a club faces the starters announced against it, one per announced game",
  JSON.stringify(w.opposingStarters.get(1)) === JSON.stringify([22, 21]) &&
    JSON.stringify(w.opposingStarters.get(2)) === JSON.stringify([11]),
  JSON.stringify([...w.opposingStarters]))
t("coverage counts the same games the window does, so the fraction cannot disagree",
  [...w.coverage].every(([team, c]) => c.games === w.games.get(team) && c.published <= c.games),
  JSON.stringify([...w.coverage]))
t("an unannounced starter is absent from the count rather than present at zero",
  w.coverage.get(2).published === 2 && w.coverage.get(2).games === 2 &&
    w.coverage.get(1).published === 1 && w.coverage.get(1).games === 2,
  JSON.stringify([...w.coverage]))
t("played-only counts the finals and nothing else",
  windowFrom(slate, "2026-09-02", "2026-09-06", true).games.get(1) === 1)
t("a window that starts after it ends counts nothing rather than everything",
  windowFrom(slate, "2026-09-10", "2026-09-06").games.size === 0)

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
