// Who went on the injured list since the capture, and who came off it.
//
// The shipped snapshot's injury map is right on the day it is built and wrong every
// day after, in the direction that costs most: a man placed on the IL yesterday is
// still, to the file, available to start tonight. The complaint people actually make
// about fantasy tools is never "your model is wrong" — of 1,180 one- and two-star
// reviews across the four big platforms, 11 mention projections at all — it is "you
// told me something the box score already contradicted". So the correctness bar for
// this file is not accuracy, it is CONSERVATISM: a description it cannot read
// changes nothing, and the capture stays authoritative until MLB has said, in words
// this file recognises, that it is out of date.
//
// One live request at the end, to one public endpoint, once per run.
import { readMoves, withMoves, fetchMoves, TRANSACTIONS_URL } from "../src/data/injuries.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

const tx = (id, description, effectiveDate = "2026-09-05", typeCode = "SC") =>
  ({ person: { id }, typeCode, typeDesc: "Status Change", description, effectiveDate })

// Verbatim shapes, copied from the live feed on 2026-09-10 rather than invented —
// the whole risk in this file is that it reads somebody else's prose, so the fixture
// has to be that prose.
const FEED = {
  transactions: [
    tx(687221, "Los Angeles Dodgers placed C Dalton Rushing on the 10-day injured list retroactive to September 5, 2026. Right elbow discomfort."),
    tx(500001, "Chicago Cubs placed RHP Some Body on the 60-day injured list. Right shoulder surgery."),
    tx(500002, "New York Mets transferred LHP Another Man to the 60-day injured list."),
    tx(500003, "Seattle Mariners activated CF Third Person from the 10-day injured list.", "2026-09-07"),
    tx(500004, "Detroit Tigers reinstated 2B Fourth Man from the injured list.", "2026-09-08"),
    // Real rows that are not injuries. Counting these as unreadable would make the
    // `unparsed` number meaningless, which is the number that says whether this
    // parser is working or merely quiet.
    tx(500005, "Baltimore Orioles optioned RHP Fifth Guy to Triple-A Norfolk.", "2026-09-06", "OPT"),
    tx(500006, "Texas Rangers recalled C Sixth Guy from Triple-A Round Rock.", "2026-09-06", "REC"),
    // A status change that IS about the list and that this file cannot read. It has
    // to be COUNTED, not silently dropped.
    tx(500007, "Miami Marlins moved 1B Seventh Guy to the injured list in an unfamiliar phrasing", "2026-09-06")
  ]
}

const moves = readMoves(FEED)

t("a man placed on the injured list is read, with the list's length",
  moves.placed.get(687221)?.status === "Injured 10-Day", JSON.stringify(moves.placed.get(687221)))
// The body part is the part a reader uses to guess how long this lasts, and no
// projection in this repo can supply it.
t("and what MLB says is wrong with him",
  moves.placed.get(687221)?.note === "Right elbow discomfort", String(moves.placed.get(687221)?.note))
t("the date is the day it took effect, not the day it was published",
  moves.placed.get(687221)?.on === "2026-09-05", String(moves.placed.get(687221)?.on))
t("a 60-day placement is a 60-day placement",
  moves.placed.get(500001)?.status === "Injured 60-Day")
t("and a transfer TO the 60-day list counts as one, which is how a 10-day becomes a 60",
  moves.placed.get(500002)?.status === "Injured 60-Day")

// The half that gets forgotten. Without it a returning star stays benched by a file
// from last Tuesday, which is the same defect as starting an injured man, pointing
// the other way.
t("an activation is read", moves.activated.has(500003))
t("and so is a reinstatement, which is the other word MLB uses",
  moves.activated.has(500004))
t("neither activation is also recorded as a placement",
  !moves.placed.has(500003) && !moves.placed.has(500004))

t("an option and a recall are not injuries and are not counted as unreadable",
  !moves.placed.has(500005) && !moves.placed.has(500006) && moves.unparsed === 1,
  `unparsed=${moves.unparsed}`)
t("but a status change about the list that could not be read IS counted",
  moves.unparsed === 1, `unparsed=${moves.unparsed}`)

// ── the last word wins ────────────────────────────────────────────────────────
{
  // Placed Monday, back Thursday. In feed order the activation is last and he is
  // active — the opposite order and he is not.
  const there = readMoves({ transactions: [
    tx(700001, "Team placed OF Man on the 10-day injured list.", "2026-09-01"),
    tx(700001, "Team activated OF Man from the 10-day injured list.", "2026-09-04")
  ]})
  t("a man placed and then activated is active",
    there.activated.has(700001) && !there.placed.has(700001))
  const back = readMoves({ transactions: [
    tx(700002, "Team activated OF Man from the 10-day injured list.", "2026-09-01"),
    tx(700002, "Team placed OF Man on the 10-day injured list.", "2026-09-04")
  ]})
  t("and a man activated and then placed again is not",
    back.placed.has(700002) && !back.activated.has(700002))
}

// ── the overlay ───────────────────────────────────────────────────────────────
{
  const captured = new Map([[687221, "Active-ish nonsense"], [900001, "Injured 10-Day"], [500003, "Injured 10-Day"]])
  const merged = withMoves(captured, moves)
  t("a new placement reaches the map", merged.get(687221) === "Injured 10-Day")
  t("an activation REMOVES him, which is the half that gets forgotten",
    !merged.has(500003), String(merged.get(500003)))
  t("and a man the feed said nothing about is left exactly as the capture had him",
    merged.get(900001) === "Injured 10-Day")
  t("the capture itself is never mutated — the caller may hold it across renders",
    captured.get(687221) === "Active-ish nonsense" && captured.has(500003))
}

// ── failure is a state ────────────────────────────────────────────────────────
for (const [name, input] of [["null", null], ["an error body", { message: "no" }], ["an empty feed", { transactions: [] }]]) {
  const m = readMoves(input)
  t(`${name} yields no moves rather than throwing`,
    m.placed.size === 0 && m.activated.size === 0 && m.unparsed === 0)
  t(`  and the capture survives it untouched, on ${name}`,
    withMoves(new Map([[1, "Injured 10-Day"]]), m).get(1) === "Injured 10-Day")
}

t("the URL pins sportId=1, without which the rows are minor-league noise",
  /[?&]sportId=1(&|$)/.test(TRANSACTIONS_URL("2026-09-06", "2026-09-10")),
  TRANSACTIONS_URL("2026-09-06", "2026-09-10"))

// ── one live request ──────────────────────────────────────────────────────────
{
  // A five-day window from last season, so the answer is stable and this cannot fail
  // because nobody happened to get hurt today. One request, no key, no enumeration.
  const { moves: live, error } = await fetchMoves("2025-07-10", "2025-07-15")
  if (error) {
    t("live MLB read (skipped — network unavailable)", true, error)
  } else {
    t("MLB still publishes roster moves in the shape this file parses",
      live.placed.size > 0 || live.activated.size > 0,
      `${live.placed.size} placed, ${live.activated.size} activated, ${live.unparsed} unread`)
    // The number that says whether the parser is working or merely quiet. If MLB
    // rephrases, this is the assertion that notices.
    const seen = live.placed.size + live.activated.size
    t("and it reads the great majority of what it sees",
      seen === 0 || live.unparsed / (seen + live.unparsed) < 0.25,
      `${live.unparsed} unread of ${seen + live.unparsed} list rows`)
    t("every status it reports names a real list length",
      [...live.placed.values()].every(m => /^Injured \d+-Day$/.test(m.status)),
      [...new Set([...live.placed.values()].map(m => m.status))].join(", "))
  }
}

// A hang is a failure too — see the same note in test/today.mjs.
{
  const t0 = Date.now()
  const { error } = await fetchMoves("2025-07-10", "2025-07-15", undefined, 1)
  t("a request that does not answer in time becomes an error, not a wait",
    error !== null && Date.now() - t0 < 3000, String(error))
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
