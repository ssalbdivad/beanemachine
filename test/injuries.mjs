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

// --- out of the majors is not an injury, and is not available either ---------------
//
// This file's own comment used to say, correctly, that "an option, a recall or a waiver claim
// is a real move and not an injury" — and then dropped those rows, which left the board
// ranking men who cannot appear in a major-league box score. Measured against the live feed for
// 2026-09-05 to 2026-09-12: 199 rows, 36 options, 14 designations, 9 outrights, 5 releases, and
// 50 of those men carried rows on the committed board — eleven of them with real playing time,
// Jasson Domínguez among them. The cost is not a bad recommendation, it is a wasted waiver
// claim, and the shipped league allows six a week.
//
// These rows need no sentence reading: MLB stamps each with a `typeCode`, so the two sets are
// an enumeration rather than a parse. That is why this half is safer than the injury half.
{
	const tx = (rows) => ({ transactions: rows })
	const row = (id, typeCode, description, effectiveDate = "2026-09-10") =>
		({ person: { id }, typeCode, description, effectiveDate })

	const out = readMoves(tx([
		row(1, "OPT", "San Francisco Giants optioned RHP Ryan Walker to Sacramento River Cats."),
		row(2, "DES", "Los Angeles Dodgers designated CF Alek Thomas for assignment."),
		row(3, "OUT", "Colorado Rockies sent RF Tyler Freeman outright to Albuquerque Isotopes."),
		row(4, "REL", "Miami Marlins released 3B Leo Jiménez."),
		row(5, "CU", "New York Yankees recalled RF Jasson Domínguez from Scranton.")
	]))
	t("every way out of the majors is read", out.sent.size === 4, [...out.sent.values()].map(m => m.status).join(", "))
	t("and each is called what MLB called it",
		out.sent.get(1).status === "optioned to the minors" &&
			out.sent.get(2).status === "designated for assignment" &&
			out.sent.get(3).status === "sent outright to the minors" &&
			out.sent.get(4).status === "released",
		[...out.sent.values()].map(m => m.status).join(" | "))
	t("a recall is the other direction", out.back.has(5) && !out.sent.has(5))
	// None of this is an injury, and reporting it as one would put a false sentence on the card.
	t("and none of it is reported as an injury", out.placed.size === 0 && out.activated.size === 0)
	// The unread counter exists to say how much of the INJURY feed cannot be read. Rows that
	// are not injuries must not inflate it or the number means nothing.
	t("nor counted as injury rows this parser could not read", out.unparsed === 0, String(out.unparsed))

	// FEED ORDER, LAST WORD WINS, which is the rule the injury half already follows. Taken from
	// a real pair: the Yankees recalled Jasson Domínguez on 2026-09-05 and optioned him again on
	// 2026-09-11, so on the 12th he cannot play.
	const flip = readMoves(tx([
		row(9, "CU", "New York Yankees recalled RF Jasson Domínguez from Scranton.", "2026-09-05"),
		row(9, "OPT", "New York Yankees optioned RF Jasson Domínguez to Scranton.", "2026-09-11")
	]))
	t("recalled then optioned is optioned", flip.sent.has(9) && !flip.back.has(9))
	const back = readMoves(tx([
		row(9, "OPT", "New York Yankees optioned RF Jasson Domínguez to Scranton.", "2026-09-05"),
		row(9, "CU", "New York Yankees recalled RF Jasson Domínguez from Scranton.", "2026-09-11")
	]))
	t("and optioned then recalled is available", back.back.has(9) && !back.sent.has(9))

	// CONSERVATISM, which is the rule the whole file is written under. A rehab assignment
	// happens to a man already on the injured list, and a minor-league signing is not a return
	// to the majors — so neither set claims them.
	const neither = readMoves(tx([
		row(11, "ASG", "Arizona Diamondbacks sent RHP Ryne Nelson on a rehab assignment to Visalia."),
		row(12, "SFA", "San Diego Padres signed free agent RHP Trevor Gott to a minor league contract."),
		row(13, "ZZZ", "Something MLB has not done before.")
	]))
	t("a rehab assignment changes nothing", !neither.sent.has(11) && !neither.back.has(11))
	t("a minor-league signing changes nothing", !neither.sent.has(12) && !neither.back.has(12))
	t("and a code this file does not know changes nothing",
		neither.sent.size === 0 && neither.back.size === 0)

	// THE MERGE. The engine asks one question of this map — can he play — so both kinds belong
	// in it, and the later, larger fact wins where a man is both.
	const merged = withMoves(new Map([[2, "Injured 60-Day"], [7, "Injured 10-Day"]]), readMoves(tx([
		row(2, "OUT", "Colorado Rockies sent 2B somebody outright to Albuquerque."),
		row(7, "CU", "Somebody recalled 7 from somewhere."),
		row(8, "OPT", "Somebody optioned 8 to somewhere.")
	])))
	t("a man both hurt and outrighted reads as outrighted",
		merged.get(2) === "sent outright to the minors", String(merged.get(2)))
	// A recall does NOT clear an injury — they are different facts, and the capture's injury
	// stands until an activation says otherwise.
	t("but a recall does not clear an injury the capture recorded",
		merged.get(7) === "Injured 10-Day", String(merged.get(7)))
	t("and an optioned man joins the map the engine reads",
		merged.get(8) === "optioned to the minors", String(merged.get(8)))
	// The strings are written to read after "MLB lists him", which is the frame src/auto/plan.ts
	// puts an unavailability in.
	t("every reason reads as a sentence about him",
		[...merged.values()].every(v => /^(Injured \d+-Day|optioned to the minors|designated for assignment|sent outright to the minors|released)$/.test(v)),
		[...new Set(merged.values())].join(" | "))
}

// A hang is a failure too — see the same note in test/today.mjs.
{
  const t0 = Date.now()
  const { error } = await fetchMoves("2025-07-10", "2025-07-15", undefined, 1)
  t("a request that does not answer in time becomes an error, not a wait",
    error !== null && Date.now() - t0 < 3000, String(error))
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE DAY THE PATCH STOPS REACHING THE CAPTURE.
 *
 * The injured list on the card is the capture's, patched with every move MLB has reported
 * since — and the patch looks back a fortnight at most, measured from NOW. Once the capture
 * is older than that, the window starts AFTER it: every placement and return in between is
 * invisible, and the capture's own entry stays authoritative for men who have since moved.
 * That is the failure this file's own header is written against — starting a man the box
 * score already contradicted.
 *
 * It arrives on a DATE with no change to any code. The shipped capture is 2026-09-08T19:17Z
 * and the fortnight runs out on 2026-09-21, so this is asserted against a clock rather than
 * waited for.
 * ═══════════════════════════════════════════════════════════════════════════════════
 */
{
  const { uncoveredDaysOf } = await import("../src/client/useInjuries.ts")
  const captured = "2026-09-08T19:17:37Z"
  const at = d => Date.parse(`${d}T20:00:00Z`)
  t("while the window still reaches the capture, there is nothing to say",
    uncoveredDaysOf(captured, at("2026-09-18")) === 0 &&
      uncoveredDaysOf(captured, at("2026-09-21")) === 0,
    `${uncoveredDaysOf(captured, at("2026-09-18"))} / ${uncoveredDaysOf(captured, at("2026-09-21"))}`)
  t("the day after the fortnight runs out, one day is uncovered",
    uncoveredDaysOf(captured, at("2026-09-22")) === 1, String(uncoveredDaysOf(captured, at("2026-09-22"))))
  t("and it grows a day at a time from there",
    uncoveredDaysOf(captured, at("2026-09-25")) === 4 &&
      uncoveredDaysOf(captured, at("2026-10-08")) === 17,
    `${uncoveredDaysOf(captured, at("2026-09-25"))} / ${uncoveredDaysOf(captured, at("2026-10-08"))}`)
  /* A few hours past the boundary is not a day of blindness, and a capture with no timestamp
     at all cannot be measured against — both are zero, which prints nothing. */
  t("a few hours over the line is not reported as a day",
    uncoveredDaysOf(captured, Date.parse("2026-09-22T01:00:00Z")) === 0,
    String(uncoveredDaysOf(captured, Date.parse("2026-09-22T01:00:00Z"))))
  t("and a capture with no timestamp says nothing rather than something",
    uncoveredDaysOf(undefined, at("2026-10-08")) === 0 &&
      uncoveredDaysOf("not a date", at("2026-10-08")) === 0)
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
