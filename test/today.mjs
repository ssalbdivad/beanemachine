// What is actually happening today.
//
// Every other number in this app is an average over a window, which is the right
// unit for "who is worth more" and the wrong one for the question a manager opens
// the app to answer before first pitch: is this man playing tonight? MLB's own
// schedule endpoint answers it, sends `access-control-allow-origin: *`, and needs
// no key — so the deployed static site can ask it directly.
//
// The claim this suite defends is not "the parse works". It is the distinction the
// parse exists to preserve: NOT PLAYING and NOT POSTED YET are different states,
// and reporting the second as the first would be the worst kind of wrong —
// confident, actionable and false. Measured 2026-09-10: every Pre-Game and In
// Progress game carried nine names a side, every Scheduled game carried none. So
// for most of any given day, silence about a hitter means nothing whatsoever.
//
// One live request is made at the end, to one public endpoint, once per run.
import { readSlate, statusOf, localDate, SLATE_URL, fetchSlate } from "../src/data/today.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

/** A day with one game posted and one not, which is every day between about 3pm and
 *  first pitch and is therefore the case that matters most. */
const DAY = {
  dates: [{
    games: [
      {
        gamePk: 1, gameDate: "2026-09-10T16:15:00Z",
        status: { detailedState: "Pre-Game" },
        venue: { name: "Truist Park" },
        teams: {
          home: { team: { id: 144, abbreviation: "ATL" }, probablePitcher: { id: 900 } },
          away: { team: { id: 139, abbreviation: "TB" }, probablePitcher: { id: 901 } }
        },
        lineups: {
          homePlayers: [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }, { id: 15 }, { id: 16 }, { id: 17 }, { id: 18 }, { id: 19 }],
          awayPlayers: [{ id: 21 }, { id: 22 }, { id: 23 }, { id: 24 }, { id: 25 }, { id: 26 }, { id: 27 }, { id: 28 }, { id: 29 }]
        }
      },
      {
        gamePk: 2, gameDate: "2026-09-10T23:10:00Z",
        status: { detailedState: "Scheduled" },
        venue: { name: "Wrigley Field" },
        teams: {
          home: { team: { id: 112, abbreviation: "CHC" }, probablePitcher: { id: 902 } },
          away: { team: { id: 134, abbreviation: "PIT" } }
        }
      }
    ]
  }]
}

const slate = readSlate("2026-09-10", DAY)

t("both games are read", slate.games.length === 2, String(slate.games.length))
t("every club with a game is known the moment the schedule loads",
  [144, 139, 112, 134].every(id => slate.playing.has(id)), [...slate.playing].join(","))
t("and a club with no game is not",
  !slate.playing.has(147), [...slate.playing].join(","))
t("the posted batting order is read, in order",
  slate.battingOrder.get(11) === 1 && slate.battingOrder.get(15) === 5 && slate.battingOrder.get(29) === 9,
  JSON.stringify([...slate.battingOrder].slice(0, 3)))
t("published probable starters are read for both sides",
  slate.probables.has(900) && slate.probables.has(901) && slate.probables.has(902),
  [...slate.probables].join(","))
t("and which club each is throwing for, so an opponent can be named",
  slate.probableFor.get(900) === 144 && slate.probableFor.get(902) === 112)

// ── the distinction the whole file exists for ─────────────────────────────────
t("a club whose lineup is out is marked as such",
  slate.postedFor.has(144) && slate.postedFor.has(139), [...slate.postedFor].join(","))
t("and a club whose lineup is not out is NOT",
  !slate.postedFor.has(112) && !slate.postedFor.has(134), [...slate.postedFor].join(","))

{
  // Same absence, two meanings. Player 99 is on ATL, whose card is out — he is
  // genuinely benched. Player 98 is on CHC, whose card is not out — nothing is known.
  const benched = statusOf(99, 144, "hitting", slate)
  const waiting = statusOf(98, 112, "hitting", slate)
  t("a hitter missing from a POSTED lineup is reported as benched",
    benched.kind === "benched", JSON.stringify(benched))
  t("a hitter missing from an UNPOSTED lineup is reported as unknown, never as benched",
    waiting.kind === "waiting", JSON.stringify(waiting))
  t("and the two say different things to the reader",
    benched.text !== waiting.text, `${benched.text} / ${waiting.text}`)
}

t("a man whose club is off today is told so, with no waiting involved",
  statusOf(50, 147, "hitting", slate).kind === "no-game")
t("a hitter in the posted lineup is given his place in the order",
  statusOf(15, 144, "hitting", slate).text === "batting 5")
t("a probable starter is told who he faces, from the same one request",
  statusOf(900, 144, "pitching", slate).text === "starts vs TB",
  JSON.stringify(statusOf(900, 144, "pitching", slate)))
// Most pitchers are not starting on most days and a reliever is available every
// day, so "not in the lineup" is meaningless for an arm. Silence is the honest
// answer, and it must not read as a benching.
t("a pitcher who is not today's starter is never called benched",
  statusOf(950, 144, "pitching", slate).kind === "waiting",
  JSON.stringify(statusOf(950, 144, "pitching", slate)))
t("a man with no club at all is not claimed to be playing",
  statusOf(50, null, "hitting", slate).kind === "no-game")

// ── failure is a state, not an exception ─────────────────────────────────────
for (const [name, input] of [
  ["null", null],
  ["an error body", { message: "nope" }],
  ["an empty day", { dates: [] }],
  ["a game with no teams", { dates: [{ games: [{ gamePk: 3 }] }] }]
]) {
  const s = readSlate("2026-09-10", input)
  t(`${name} yields an empty slate rather than throwing`,
    s.games.length === 0 && s.playing.size === 0)
  t(`  and every man reads as "no game" rather than as benched, on ${name}`,
    statusOf(1, 144, "hitting", s).kind === "no-game")
}

// ── the date is the reader's own ─────────────────────────────────────────────
// A 7pm Eastern game is tonight's game in California too, so the slate is asked for
// in local calendar terms rather than in UTC — which flips a day at 8pm Eastern.
t("the date is the local calendar date, not UTC",
  localDate(new Date(2026, 8, 10, 21, 30)) === "2026-09-10",
  localDate(new Date(2026, 8, 10, 21, 30)))
t("and it is zero-padded, which is what the API accepts",
  localDate(new Date(2026, 0, 5)) === "2026-01-05", localDate(new Date(2026, 0, 5)))
t("the URL asks for the three hydrations this file reads and nothing else",
  /hydrate=lineups,probablePitcher,team/.test(SLATE_URL("2026-09-10")) &&
    SLATE_URL("2026-09-10").includes("date=2026-09-10"),
  SLATE_URL("2026-09-10"))

// ── one live request, because a contract with somebody else's API is only real
//    if it is checked against the real thing ───────────────────────────────────
{
  // Politeness: one request per run, to a public endpoint, with no key and no
  // enumeration. A date in the middle of last season, so the answer is stable and
  // this cannot fail because today happens to be an off day.
  const { slate: live, error } = await fetchSlate("2025-07-15")
  if (error) {
    t("live MLB read (skipped — network unavailable)", true, error)
  } else {
    t("MLB still answers the shape this file parses",
      live.games.length > 0 && live.games.every(g => g.homeTeamId > 0 && g.awayTeamId > 0),
      `${live.games.length} games`)
    t("and a finished day carries both its posted lineups and its starters",
      live.postedFor.size > 0 && live.probables.size > 0 && live.battingOrder.size > 0,
      `posted ${live.postedFor.size} clubs, ${live.probables.size} probables, ${live.battingOrder.size} in orders`)
    t("and every batting-order place it reports is a real one",
      [...live.battingOrder.values()].every(n => n >= 1 && n <= 9),
      [...new Set(live.battingOrder.values())].sort().join(","))
  }
}

// ── a hang is a failure too ──────────────────────────────────────────────────
//
// The try/catch above turns a refusal, a 500 and a malformed body into a state.
// It cannot turn a HANG into one: if the connection is accepted and nothing ever
// comes back, the promise never settles, `useSlate` stays `loading` forever, and
// the page waits on a request that has already effectively failed. Measured from
// outside the app during a test run — the request was still outstanding after 32
// seconds with no error and no state change, which is also what made
// `waitUntil: "networkidle"` unusable against this page.
{
  const t0 = Date.now()
  const { slate, error } = await fetchSlate("2025-07-15", undefined, 1)
  const ms = Date.now() - t0
  t("a request that does not answer in time becomes an error, not a wait",
    error !== null && ms < 3000, `${ms}ms, error=${error}`)
  t("and the caller still gets a usable empty slate rather than a throw",
    slate.games.length === 0 && slate.playing.size === 0)
  t("the message says the deadline passed, so it is not read as a refusal",
    /did not answer/.test(error ?? ""), String(error))
}

// ── when a seat stops being changeable ───────────────────────────────────────
//
// There is no single lineup moment. Measured across the 2025 season, first pitches
// spread over a median 7h25m window and only about a quarter fall in the 7pm ET
// hour — so at any point in an evening part of a roster is already locked and the
// rest is not. A list of changes ordered by what each is WORTH is ordered on the
// wrong axis at the moment somebody is acting on it: half of it has expired and the
// reader has to find the half that has not.
{
  const { lockFor, nextLock, clock } = await import("../src/data/today.ts")
  t("a man's lock is his club's first pitch",
    lockFor(144, slate) === Date.parse("2026-09-10T16:15:00Z"),
    String(lockFor(144, slate)))
  t("and it is the same for both clubs in the game",
    lockFor(139, slate) === lockFor(144, slate))
  t("a club with no game has no lock, which is not the same as a lock of zero",
    lockFor(147, slate) === null && lockFor(null, slate) === null)

  const early = Date.parse("2026-09-10T16:15:00Z")
  const late = Date.parse("2026-09-10T23:10:00Z")
  t("the next lock is the earliest one still ahead",
    nextLock([late, early], Date.parse("2026-09-10T15:00:00Z")) === early)
  // The whole point: a game that has started is not a deadline any more.
  t("a lock that has passed is not offered as the next one",
    nextLock([late, early], Date.parse("2026-09-10T17:00:00Z")) === late)
  t("and when they have all started there is no next lock at all",
    nextLock([late, early], Date.parse("2026-09-11T00:00:00Z")) === null)
  t("an unknown lock never becomes the deadline",
    nextLock([null, late], Date.parse("2026-09-10T15:00:00Z")) === late)
  t("nothing known at all is null rather than a guess",
    nextLock([null, null]) === null)
  // A deadline is read at a glance or it is not read. 24-hour, seconds and a
  // timezone suffix are all things a reader has to parse.
  t("the clock reads the way a person says a time",
    /^\d{1,2}:\d{2}[ap]m$/.test(clock(Date.parse("2026-09-10T23:05:00Z"))),
    clock(Date.parse("2026-09-10T23:05:00Z")))
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
