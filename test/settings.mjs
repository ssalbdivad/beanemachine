// A whole league, out of a pasted settings page.
//
// The ground truth this suite measures against is not invented: `scoring.json`
// holds the league that was FETCHED from Yahoo on the day the importer still
// worked, with its scoring, its slots and its team count read off the real
// settings page. So the test reconstructs what that page looks like when a person
// selects it and presses Ctrl-C, feeds it through the paste reader, and asserts
// the league that comes out is the same league.
//
// That is the whole claim of the paste route. Yahoo sends no CORS headers, so no
// browser will ever fetch that page, and — measured 2026-09-09 — a server asking
// for it is told "Request denied". The reader's own signed-in browser is the only
// program in the world that can see it, and Ctrl-A is the only way out. If the two
// routes disagreed about what a league is, the paste route would be a second,
// quieter source of truth, which is the thing this file exists to prevent.
import { readFileSync } from "node:fs"
import { leagueFromSettingsText, leagueFromPastedSettings } from "../src/data/paste-settings.ts"

const cfg = JSON.parse(readFileSync("scoring.json", "utf8"))
const real = cfg.leagues["yahoo:228947"]
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

/** How Yahoo spells each code on the page. Only the parenthesised code is read, so
 *  the prose in front of it is written the way Yahoo writes it and is deliberately
 *  not what anything matches on. */
const LABEL = {
  R: "Runs", "1B": "Singles", "2B": "Doubles", "3B": "Triples", HR: "Home Runs",
  RBI: "Runs Batted In", SB: "Stolen Bases", BB: "Walks", HBP: "Hit By Pitch",
  W: "Wins", SV: "Saves", OUT: "Outs", H: "Hits Allowed", ER: "Earned Runs",
  K: "Strikeouts"
}

/** The settings page as a browser copies it: one row per line, tab between cells. */
const asPasted = (league) => {
  const rows = []
  rows.push("Yahoo Fantasy Baseball\tMy Team\tLeague\tPlayers")
  rows.push("Scoring & Settings")
  rows.push("Setting\tValue")
  for (const [k, v] of Object.entries(league.league_rules.raw_settings)) rows.push(`${k}\t${v}`)
  rows.push("Batters Stat Category\tValue")
  for (const [c, v] of Object.entries(league.scoring.batting))
    rows.push(`${LABEL[c] ?? c} (${c})\t${v}`)
  rows.push("Pitchers Stat Category\tValue")
  // Yahoo prints this row INSIDE the pitchers' table, first: a row that carries a
  // stat code and is not a scoring line. It is in the fixture because leaving it out
  // is how the bug below survived — see the assertion headed "a row that carries a
  // code but scores nothing".
  rows.push("Innings Pitched (IP)\t0")
  for (const [c, v] of Object.entries(league.scoring.pitching))
    rows.push(`${LABEL[c] ?? c} (${c})\t${v}`)
  rows.push("Terms\tPrivacy\tHelp\tFeedback")
  return rows.join("\n")
}

const text = asPasted(real)

// ── the round trip ─────────────────────────────────────────────────────────────
{
  const { league, read } = leagueFromPastedSettings(text, "yahoo", "2026-09-09")
  t("a pasted settings page yields a league at all", !!league)
  t("with the same batting scoring the fetch read",
    JSON.stringify(league.scoring.batting) === JSON.stringify(real.scoring.batting),
    JSON.stringify(league.scoring.batting))
  t("and the same pitching scoring, negatives included",
    JSON.stringify(league.scoring.pitching) === JSON.stringify(real.scoring.pitching),
    JSON.stringify(league.scoring.pitching))
  t("the roster slots come back in the order the lineup is set in",
    JSON.stringify(league.roster.slot_order) === JSON.stringify(real.roster.slot_order),
    JSON.stringify(league.roster.slot_order))
  t("the seat counts match",
    JSON.stringify(league.roster.slots) === JSON.stringify(real.roster.slots))
  t("and so does which men may fill which seat, because one function decides it",
    JSON.stringify(league.roster.slot_accepts) === JSON.stringify(real.roster.slot_accepts),
    JSON.stringify(league.roster.slot_accepts))
  t("the team count is read, which is what replacement level is cut at",
    league.meta.max_teams === real.meta.max_teams, String(league.meta.max_teams))
  t("the scoring period is derived by the same rule as a fetched league",
    league.scoring_period.kind === real.scoring_period.kind &&
      league.scoring_period.days === real.scoring_period.days &&
      league.scoring_period.starts_on === real.scoring_period.starts_on &&
      league.scoring_period.lineup_lock === real.scoring_period.lineup_lock,
    JSON.stringify(league.scoring_period))
  t("every settings row is kept verbatim, so the rules derivations still work",
    Object.keys(league.league_rules.raw_settings).length ===
      Object.keys(real.league_rules.raw_settings).length,
    `${Object.keys(league.league_rules.raw_settings).length} of ${Object.keys(real.league_rules.raw_settings).length}`)
  t("nothing was missing from a whole page", read.missing.length === 0, read.missing.join(", "))
  // Yahoo prints "League ID#" on this page, and it is load-bearing: the free-agent
  // list is stored against the league id and `Board.tsx` looks it up by that id, so
  // a league without one can only ever be shown the ownership estimate.
  t("the league's own id is read, which is what lets it ever see its own free agents",
    league.meta.league_id === real.meta.league_id, String(league.meta.league_id))
  // It came off the reader's screen, not off a fetch this app made and can point
  // at. Wearing `verified` would make a paste indistinguishable from an import.
  t("but it is not marked verified, because nothing here fetched that page",
    league.provenance.verified === false)
  t("and it says so once, in words, rather than silently",
    league.needs_review.some(n => /pasted/i.test(n)), league.needs_review.join(" | "))
}

// ── the copy that flattens ─────────────────────────────────────────────────────
{
  // Some browsers, and every "paste as plain text", put one CELL on each line.
  // Scoring still comes through, because the (CODE) says where a stat row starts.
  const flat = text.split("\n").flatMap(l => l.split("\t")).join("\n")
  const { league, read } = leagueFromPastedSettings(flat, "yahoo", "2026-09-09")
  t("a copy that flattened to one cell per line still yields the scoring",
    league && JSON.stringify(league.scoring.batting) === JSON.stringify(real.scoring.batting),
    JSON.stringify(league?.scoring.batting))
  t("and the pitching values with it",
    JSON.stringify(league?.scoring.pitching) === JSON.stringify(real.scoring.pitching),
    JSON.stringify(league?.scoring.pitching))
  // Honesty about the half it cannot get: a label/value pair is unrecoverable
  // when both sit alone on their own line, so it is REPORTED rather than guessed.
  t("what a flattened copy cannot carry is named, not invented",
    read.missing.includes("roster positions") && read.missing.includes("team count"),
    read.missing.join(", "))
}

// ── what it refuses ────────────────────────────────────────────────────────────
{
  const { league, read } = leagueFromPastedSettings(
    "Yahoo Fantasy Baseball\nMy Team\tMrs. Met's Harem\nStandings\tScoreboard\nPlayers",
    "yahoo", "2026-09-09"
  )
  t("a page with no stat table yields no league rather than an empty one",
    league === null)
  t("and names the scoring it did not find",
    read.missing.includes("batting scoring") && read.missing.includes("pitching scoring"),
    read.missing.join(", "))
  t("empty input is empty output rather than an error",
    leagueFromSettingsText("").missing.length === 4)
}

// ── the two sides of the ball are not the same stat ────────────────────────────
{
  // "K" is a strikeout for a batter and for a pitcher, and in most leagues they
  // have opposite signs. The only thing that says which is which is the header
  // above the table, so a paste that lost the headers must not score anything.
  const headless = text
    .replace("Batters Stat Category\tValue\n", "")
    .replace("Pitchers Stat Category\tValue\n", "")
  const { league } = leagueFromPastedSettings(headless, "yahoo", "2026-09-09")
  t("with no table headers nothing is scored, rather than scored on the wrong side",
    league === null)
}

// ── a settings row after the stat table is not a stat ──────────────────────────
{
  const trailing = `${text}\nMax Moves (Season)\t120\nWaiver Time (WT)\t2`
  const { league } = leagueFromPastedSettings(trailing, "yahoo", "2026-09-09")
  t("a parenthesised code in a row BELOW the stat table is not scored",
    !("WT" in league.scoring.pitching), JSON.stringify(league.scoring.pitching))
  t("and it is kept as a setting instead",
    league.league_rules.raw_settings["Waiver Time (WT)"] === "2",
    JSON.stringify(league.league_rules.raw_settings["Waiver Time (WT)"]))
}

// ── a row that carries a code but scores nothing ─────────────────────────────
//
// This is the one that cost the whole pitching side, and it cost it silently.
//
// The parser ends a stat table when it meets a two-cell row with no stat code — that
// is how it stops reading the settings rows below the table as scoring. Yahoo prints
// "Innings Pitched (IP)" INSIDE the pitchers' table, and IP is a row that carries a
// code and is not a scoring line: `NOT_A_STAT` exists for exactly that. Without
// testing for the code, that row fell through to the end-of-table branch, the table
// ended on its first line, and every pitching value after it was read as a league
// setting instead.
//
// Measured on a faithful settings page before the fix: 9 of 9 batting stats and 0 of
// 8 pitching, reported as "no pitching scoring". Downstream that is a daily card that
// cannot price anybody on the mound and blames the roster for it.
{
  const withIp = asPasted(real)
  const { read } = leagueFromPastedSettings(withIp, "yahoo", "2026-09-09")
  t("an innings row inside the pitchers' table does not end the pitchers' table",
    Object.keys(read.pitching).length === Object.keys(real.scoring.pitching).length,
    `${Object.keys(read.pitching).length} of ${Object.keys(real.scoring.pitching).length}: ${Object.keys(read.pitching).join(",")}`)
  t("and it is not itself scored, because it is not a scoring line",
    !("IP" in read.pitching), JSON.stringify(read.pitching))
  // The other half of the same rule: a row with no code at all still ends the table,
  // or every setting printed below it would be read as a pitching value.
  const trailing = leagueFromSettingsText(withIp + "\nMax Moves\t120")
  t("a row with no code at all still ends the table",
    !("MOVES" in trailing.pitching) && trailing.settings["Max Moves"] === "120",
    JSON.stringify(Object.keys(trailing.pitching)))
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
