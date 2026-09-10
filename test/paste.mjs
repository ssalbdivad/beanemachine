// Reading a team out of pasted text.
//
// This exists because every other way in depends on somebody else's permission. On
// 2026-09-09 the Yahoo sweep that had been returning 150 free agents returned 25,
// then 0, then the literal string "Request denied" — while the app went on offering
// a "Read my roster from Yahoo" button. A paste cannot be revoked: the browser doing
// the reading is the reader's own, already signed in, and not rate-limited as a
// scraper because it is not one. It also reaches PRIVATE leagues, which is most
// leagues and which scraping never could.
//
// The design bet is that refusing to parse is what makes it robust. Nothing here
// understands Yahoo's table; the text is searched for names already known from the
// snapshot and everything else is ignored — so a redesign, an advertisement, or a
// different platform entirely costs nothing.
import { readFileSync } from "node:fs"
import { playersInText, rosterFromPaste } from "../src/data/paste.ts"

const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const all = snap.players
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

/** Real men from the committed capture, so nothing here is invented. */
const pick = (group, n) =>
  all
    .filter(p => p.group === group)
    .sort((a, b) => (b.stats?.plateAppearances ?? b.stats?.outs ?? 0) - (a.stats?.plateAppearances ?? a.stats?.outs ?? 0))
    .slice(0, n)
const bats = pick("hitting", 6)
const arms = pick("pitching", 3)

// ── the shape Yahoo actually renders ───────────────────────────────────────────
{
  const slots = ["C", "1B", "2B", "3B", "SS", "OF"]
  const text =
    `Fantasy Baseball  My Team  Mrs. Met's Harem\nPos\tPlayer\tAction\n` +
    bats.map((p, i) => `${slots[i]}\t${p.name} ${p.team ?? "NYY"} - ${slots[i]}\tAdd/Drop`).join("\n") +
    `\n` +
    arms.map((p, i) => `${["SP", "RP", "BN"][i]}\t${p.name} ${p.team ?? "NYY"} - SP\tAdd/Drop`).join("\n")

  const r = playersInText(text, all)
  t("every player on a pasted roster page is found",
    bats.concat(arms).every(p => r.players.some(x => x.id === p.id)),
    `${r.players.length} of ${bats.length + arms.length}`)
  t("and nothing else is invented from the surrounding page furniture",
    r.players.length === bats.length + arms.length,
    r.players.map(p => p.name).join(", "))
  t("the seat beside each name is recovered, which is what makes a daily diff possible",
    slots.every((s, i) => r.players.find(x => x.id === bats[i].id)?.slot === s),
    r.players.slice(0, 6).map(p => `${p.name}=${p.slot}`).join(", "))
  t("a bench and an injured seat are read as themselves, not as a position",
    r.players.find(x => x.id === arms[2].id)?.slot === "BN",
    String(r.players.find(x => x.id === arms[2].id)?.slot))
  t("and the side of the ball comes from the snapshot, not from the paste",
    r.players.filter(p => p.group === "pitching").length === arms.length,
    r.players.filter(p => p.group === "pitching").map(p => p.name).join(", "))
}

// ── a bare list, which is what a free-agent page pastes as ─────────────────────
{
  const r = playersInText(bats.map(p => p.name).join("\n"), all)
  t("a plain list of names works with no slots at all",
    r.players.length === bats.length && r.players.every(p => p.slot === null),
    r.players.map(p => `${p.name}=${p.slot}`).join(", "))
}

// ── `Last, First`, which several platforms sort by ─────────────────────────────
{
  const flip = n => { const [f, ...rest] = n.split(" "); return `${rest.join(" ")}, ${f}` }
  const r = playersInText(bats.map(p => flip(p.name)).join("\n"), all)
  t("names written surname-first are matched too",
    r.players.length === bats.length, r.players.map(p => p.name).join(", "))
}

// ── what it refuses ────────────────────────────────────────────────────────────
{
  // Surnames alone appear in prose and in navigation. A roster assembled from them
  // would be confidently wrong, which is worse than an empty result.
  const surnames = playersInText(bats.map(p => p.name.split(" ").slice(-1)[0]).join("\n"), all)
  t("a surname on its own is not enough to put a man on your team",
    surnames.players.length === 0, surnames.players.map(p => p.name).join(", "))

  const prose = playersInText(
    "Welcome to Yahoo Fantasy Baseball. Sign in. Scores Standings Players Draft " +
      "Terms Privacy Help Feedback About Advertise",
    all
  )
  t("and ordinary page furniture yields nobody",
    prose.players.length === 0, prose.players.map(p => p.name).join(", "))

  t("empty input is empty output rather than an error",
    playersInText("", all).players.length === 0)
}

// ── duplicates and repeats ─────────────────────────────────────────────────────
{
  const twice = playersInText(`${bats[0].name}\n${bats[0].name}\n${bats[1].name}`, all)
  t("a man listed twice is on the team once",
    twice.players.filter(p => p.id === bats[0].id).length === 1,
    String(twice.players.length))
}

// ── two men with one name ──────────────────────────────────────────────────────
{
  // Real, and rare. Guessing puts somebody on a roster who is not on it, so neither
  // is taken and the name is reported instead.
  // Two DIFFERENT men with one name — different ids. The committed capture has two
  // (Max Muncy, Yunior Marte). Guessing between them puts somebody on a roster who
  // is not on it, so neither is taken and the name is reported.
  const ids = new Map()
  for (const p of all) ids.set(p.name, (ids.get(p.name) ?? new Set()).add(p.id))
  const shared = [...ids].find(([name, set]) => set.size > 1 && name.split(" ").length > 1)
  if (shared) {
    const r = playersInText(shared[0], all)
    t("a name held by two different players is reported, not guessed at",
      r.players.length === 0 && r.ambiguous.includes(shared[0]),
      `${r.players.length} taken, ambiguous ${JSON.stringify(r.ambiguous)}`)
  } else {
    t("this capture holds no two players with the same full name", true, "nothing to do")
  }

  // A two-way player is ONE man on two rows — same id, both sides of the ball — and
  // is not ambiguous at all. The first version of this test could not tell the two
  // cases apart and asserted the wrong one.
  const twoWay = all.find(p => all.filter(q => q.name === p.name).length > 1 &&
    new Set(all.filter(q => q.name === p.name).map(q => q.id)).size === 1)
  if (twoWay) {
    const r = playersInText(twoWay.name, all)
    t("a two-way player is one man on your team, not a collision",
      r.players.length === 1 && r.ambiguous.length === 0,
      `${twoWay.name}: ${r.players.length} taken, ambiguous ${JSON.stringify(r.ambiguous)}`)
  }
}

// ── scale ──────────────────────────────────────────────────────────────────────
{
  // A reader pastes a whole page, not a tidy list. This is the realistic input size.
  const big = all.slice(0, 400).map(p => `BN\t${p.name} ${p.team ?? ""} - OF\tAdd`).join("\n")
  const t0 = Date.now()
  const r = playersInText(big, all)
  const ms = Date.now() - t0
  t("a whole page of players is read, and quickly",
    r.players.length >= 380 && ms < 2000, `${r.players.length} in ${ms}ms`)
}

// ── the seats a pasted man may actually fill ──────────────────────────────────
//
// This is the bug that made the product look broken, and it was one mapping.
//
// `legalSlotsFor` in src/auto/plan.ts asks whether any of a man's `positions`
// appears in the league's `slot_accepts` list for a seat, and those lists are
// written in the PLATFORM's slot names — "OF", "SP", "RP", "Util". MLB's own
// position is a different vocabulary: a centre fielder is "CF" and every pitcher
// is "P". The league's eligibility grid, which does speak in slot names, covers
// 328 of this capture's 1,446 players — so more than three quarters of every
// pasted roster fell through to the raw MLB position and could be seated nowhere
// at all.
//
// Measured on a hand-pasted 23-man roster against the committed capture: the daily
// card seated ONE man and projected 16.41 points, and blamed the other seventeen on
// projections that existed. With `slotsFor` applied the same roster seats three and
// projects 31.92 on the same five-game night.
{
  const cf = all.find(p => p.position === "CF" && p.group === "hitting")
  const sp = all.find(p => p.group === "pitching" && (p.stats?.gamesStarted ?? 0) > 3)
  if (cf && sp) {
    const r = rosterFromPaste(`OF\t${cf.name}\nSP\t${sp.name}`, snap)
    const seatsOf = n => r.spots.find(s => s.name === n)?.positions ?? []
    t("a centre fielder is given the OF seat, not MLB's CF",
      seatsOf(cf.name).includes("OF") && !seatsOf(cf.name).includes("CF"),
      `${cf.name}: ${seatsOf(cf.name).join(",")}`)
    t("and the Util seat with it, because every batter is eligible there",
      seatsOf(cf.name).includes("Util"), seatsOf(cf.name).join(","))
    t("a starting pitcher is given SP and P, not MLB's bare P",
      seatsOf(sp.name).includes("SP") && seatsOf(sp.name).includes("P"),
      `${sp.name}: ${seatsOf(sp.name).join(",")}`)
    // The check that would have caught it: nothing a paste produces may be a name
    // no fantasy league has a seat for.
    const NOT_SEATS = new Set(["CF", "LF", "RF", "DH"])
    t("no man comes back holding a position no league has a seat for",
      r.spots.every(s => s.positions.every(x => !NOT_SEATS.has(x))),
      JSON.stringify(r.spots.map(s => s.positions)))
  } else {
    t("this capture holds no centre fielder and starter to seat", false, "fixture gap")
  }
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
