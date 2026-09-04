// Where a streaming week ends. Pure date arithmetic plus window counting, so this
// suite needs no network and no snapshot — which is the point: the rule about what a
// league's week IS should be pinned somewhere nothing else can move it.
import { resolvePeriod, windowFrom, datesBetween, withinDays } from "../src/engine/period.ts"

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

// --- who each announced starter actually faces -------------------------------
//
// `opponents` is per CLUB, which is the right question for a hitter — he plays them
// all. A starter takes one turn in five, and which lineup falls on his turn is most
// of what a streaming decision is about, so the window records it separately.
{
  const slate = [
    { date: "2026-09-03", home: 1, away: 2, homeProbable: 100, awayProbable: 200, final: false },
    { date: "2026-09-04", home: 1, away: 2, homeProbable: 101, awayProbable: null, final: false },
    { date: "2026-09-05", home: 3, away: 1, homeProbable: null, awayProbable: 100, final: false }
  ]
  const w = windowFrom(slate, "2026-09-03", "2026-09-05")
  t("an announced starter's own opponents are recorded",
    JSON.stringify(w.startOpponents.get(100)) === JSON.stringify([2, 3]),
    JSON.stringify([...w.startOpponents]))
  t("and they are his, not his club's whole week",
    JSON.stringify(w.startOpponents.get(101)) === JSON.stringify([2]),
    JSON.stringify(w.startOpponents.get(101)))
  // club 1 plays 2 twice and 3 once; pitcher 101 faces only 2
  t("the club-level list still carries every game, unchanged",
    JSON.stringify(w.opponents.get(1)) === JSON.stringify([2, 2, 3]),
    JSON.stringify(w.opponents.get(1)))
  t("an unannounced game contributes no start opponent",
    !w.startOpponents.has(999) && w.startOpponents.size === 3,
    JSON.stringify([...w.startOpponents.keys()]))
}

// --- the reader's own horizon -------------------------------------------------
//
// "Which starters are pitching over the next three days" is the most common
// question in the game and the period alone cannot express it. `withinDays` is the
// SAME control with a nearer far edge: one inclusive window, so everything
// downstream still takes a start and an end and cannot tell which produced them.
{
  // the Monday-anchored period holding Wednesday runs Aug 31 - Sep 6; from Wednesday
  // the actionable window is Sep 2 - Sep 6, five dates
  const p = resolvePeriod(lg(WEEK), WED, FAR)
  const three = withinDays(p, 3, FAR)
  t("a three-day window is three dates counted from the window's own start",
    three.start === WED && three.end === "2026-09-04" && datesBetween(three.start, three.end) === 3,
    `${three.start} → ${three.end}`)
  t("and it names itself by its length rather than by the period it came out of",
    three.kind === "days" && three.basis.startsWith("3 days, 2026-09-02 to 2026-09-04"), three.basis)
  t("a day count shorter than the period says nothing about running past it",
    three.basis.includes("runs past") === false, three.basis)

  // the period's own end is Sep 6; asking for seven days from Sep 2 reaches Sep 8
  const seven = withinDays(p, 7, FAR)
  t("a window longer than the period is answered at the length asked for, not clamped",
    seven.end === "2026-09-08" && datesBetween(seven.start, seven.end) === 7,
    `${seven.start} → ${seven.end}`)
  t("but it says the games past the reset score for the next matchup, because they do",
    seven.basis.includes("runs past 2026-09-06") && seven.basis.includes("next matchup"),
    seven.basis)
  t("the period's own end survives the day count, so the board can still name it",
    seven.periodEnd === "2026-09-06")

  // a one-day window is a legitimate question (a daily-lineup league, or "who
  // pitches tonight"), and one date is one day
  const one = withinDays(p, 1, FAR)
  t("a one-day window is the single date it starts on",
    one.start === WED && one.end === WED && datesBetween(one.start, one.end) === 1)

  // a snapshot cannot answer about games it never captured, and a day count must
  // not manufacture them
  const short = withinDays(p, 7, "2026-09-05")
  t("a day count is clipped to the games actually captured, and says it was clipped",
    short.end === "2026-09-05" && short.clipped === true && short.basis.includes("clipped to 2026-09-05"),
    short.basis)

  // a locked lineup means this period cannot be acted on: the day count then has to
  // run from the period the reader CAN act on, not from a date he cannot touch
  const locked = resolvePeriod(lg({ ...WEEK, lineup_lock: "period" }), WED, FAR)
  const lockedThree = withinDays(locked, 3, FAR)
  t("with lineups locked, a three-day window counts the first three days he can act on",
    lockedThree.start === "2026-09-07" && lockedThree.end === "2026-09-09",
    `${lockedThree.start} → ${lockedThree.end}`)

  // a rolling fallback's `assumed` was a claim about the WINDOW — seven days,
  // because the league never said — and the reader has just replaced that window
  // with one he chose. What is left is a start date of today, which assumes nothing.
  const rolling = withinDays(resolvePeriod(lg(null), WED, FAR), 3, FAR)
  t("choosing a window drops the rolling fallback's assumption, because it replaced it",
    rolling.assumed === false && rolling.basis.includes("has not said") === false, rolling.basis)
  const stillAssumed = withinDays(resolvePeriod(lg({ ...WEEK, starts_on: null }), WED, FAR), 3, FAR)
  t("but a period whose START is assumed keeps saying so, because the count begins there",
    stillAssumed.assumed === true, JSON.stringify(stillAssumed))

  // the whole point of one control rather than two: the counting code cannot tell
  // which kind of window it was handed
  const wPeriod = windowFrom(slate, p.start, p.end)
  const wDays = windowFrom(slate, three.start, three.end)
  t("windowFrom counts a chosen window exactly as it counts a period",
    wDays.games.get(1) === 2 && wDays.games.get(2) === 2 && wPeriod.games.get(1) === 2,
    JSON.stringify([...wDays.games]))
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
