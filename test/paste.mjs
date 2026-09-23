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
import { eligibilityInText, nearestName, playersInText, rosterFromPaste } from "../src/data/paste.ts"

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

// ── "did you mean" ─────────────────────────────────────────────────────────────
//
// The parser's good behaviour was also a dead end. A typo, a nickname, initials and
// a transposition were all refused and quoted back — correctly, because a silent
// correction puts a man on a roster the reader never chose — and then the only way
// forward was retyping the line on a phone keyboard, which is where people quit.
//
// So `suggestions` is a question, not an answer: `players`, `keys` and `unmatched`
// are byte-for-byte what they were, and the tests above still pass unchanged. What
// is new is that a refusal can now carry what the line was probably meant to say.
{
  const judge = all.find(p => /^Aaron Judge$/.test(p.name))
  const raleigh = all.find(p => /^Cal Raleigh$/.test(p.name))
  if (!judge || !raleigh) t("this capture holds Judge and Raleigh to mistype", false, "fixture gap")
  else {
    const sug = text => rosterFromPaste(text, snap).suggestions

    // One deletion, which is the single commonest phone typo.
    const one = sug("Aaron Judg")
    t("a name one letter short is named back, not just refused",
      one.length === 1 && one[0].name === judge.name, JSON.stringify(one))

    // The same, inside the row a platform actually renders, so the suggestion has
    // to survive a slot token, a team and an "Add/Drop" on the same line.
    const row = sug("OF\tAaron Judeg NYY - OF\tAdd/Drop")
    t("and inside a whole roster row, slot and team and all",
      row.length === 1 && row[0].name === judge.name, JSON.stringify(row))

    // Two adjacent letters swapped is TWO Levenshtein edits and one Damerau edit.
    // Plain Levenshtein 1 resolved 0 of this capture's 1,286 transpositions; this is
    // why the distance counts a transposition as one.
    const swapped = sug("Cal Raliegh")
    t("a transposition is recognised, which plain edit distance cannot do",
      swapped.length === 1 && swapped[0].name === raleigh.name, JSON.stringify(swapped))

    // It must still REFUSE. Suggesting is not matching: nothing is added, the line
    // is still reported unmatched, and the keys the roster is stored under are empty.
    const r = rosterFromPaste("Aaron Judg", snap)
    t("and nothing is added by a suggestion — the line is still unmatched",
      r.players.length === 0 && r.keys.length === 0 && r.unmatched.length === 1 &&
        r.unmatched[0] === "Aaron Judg",
      JSON.stringify({ players: r.players.length, keys: r.keys, unmatched: r.unmatched }))
    t("the note asks rather than claims, and says the line is not counted",
      /Did you mean Aaron Judge\?/.test(r.note) && /not counted/.test(r.note), r.note)
    t("and the reader's own line comes back with the guess, so the screen can quote it",
      r.suggestions[0].line === "Aaron Judg" && r.suggestions[0].id === judge.id,
      JSON.stringify(r.suggestions))

    // The four refusals the measurement chose distance 1 to keep. A surname alone, a
    // nickname and an initial are all things a reader might MEAN, but each of them
    // fits many men or none, and a suggestion the reader accepts without reading is
    // worse than no suggestion at all. Not absolute for initials: 34 of the 1,445
    // initial-and-surname forms do land on exactly one man at distance 1, and 2 of
    // those 34 land on the wrong one. At distance 2 it is 19 wrong of 120, which is
    // one of the two reasons 2 was not taken.
    for (const [label, line] of [
      ["a nickname", "Vladdy"],
      ["another nickname", "Big Dumper"],
      ["an initial and a surname", "A. Judge"]
    ])
      t(`${label} is still refused, with no guess attached`,
        sug(line).length === 0, JSON.stringify(sug(line)))

    /*
     * A SURNAME ON ITS OWN MOVED from this list to its own rule, and the distinction is
     * the one that makes it safe: the edit-distance rule above GUESSES which man a
     * misspelling meant, and a unique surname IDENTIFIES one. It cannot land on the
     * wrong man, because a unique surname belongs to exactly one.
     *
     * Measured over the committed capture: 1,445 men, 1,143 distinct surnames, 984 of
     * them unique — so 68% of the pool is reachable this way with nothing wrong by
     * construction, and the other 461 share a surname and are refused with nothing
     * offered, exactly as before. Restricted to a line that is ONE WORD, which is what
     * keeps it off prose and off a pasted page: 0 of the 44 one-word lines in README.md
     * and docs/ look like a unique surname, and a roster page's lines carry columns.
     *
     * AND IT IS NOW ACCEPTED RATHER THAN OFFERED, which is the assertion that changed.
     *
     * THE OLD TRUTH, asserted here until 2026-09-12: "a unique surname on its own is offered
     * — never accepted" and "it still puts nobody on the team by itself". That was the
     * cautious reading and walking the live app showed what it cost. Typed into the setup
     * box, one to a line: Judge / Soto / Ohtani / Skenes / Witt / Rodón. Nothing was added,
     * and the screen said "I couldn't find a player in these lines: «Judge», «Soto»,
     * «Ohtani», «Skenes», «Witt», «Rodón». Nothing in them is counted anywhere." — with five
     * tappable buttons reading Aaron Judge, Shohei Ohtani, Paul Skenes, Bobby Witt Jr. and
     * Carlos Rodón directly beneath it. It knew who they were on the same screen it refused
     * them: nine taps and twelve seconds to a recommendation, five of them spent re-accepting
     * men the app had already identified.
     *
     * The caution belonged to `nearestName`, which GUESSES which man a misspelling meant and
     * still only offers. A unique surname identifies one, and there is nothing to confirm.
     * «Soto» is two men and is still refused, which is the whole distinction.
     */
    t("a unique surname on its own is accepted, and it is the right man",
      rosterFromPaste("Raleigh", snap).players.length === 1 &&
        rosterFromPaste("Raleigh", snap).players[0].name === "Cal Raleigh",
      JSON.stringify(rosterFromPaste("Raleigh", snap).players))
    // It carries no seat, because one word cannot say where he was sitting, and an invented
    // "BN" would be a claim about his lineup rather than about his name.
    t("and he arrives with no seat, because the line carried none",
      rosterFromPaste("Raleigh", snap).players[0].slot === null &&
        rosterFromPaste("Raleigh", snap).spots.length === 0,
      JSON.stringify(rosterFromPaste("Raleigh", snap).spots))
    // Nothing is left to ask about, so nothing is asked: the chip and the refusal were the
    // two halves of the defect and both go together.
    t("and nothing is offered or reported unmatched about him",
      sug("Raleigh").length === 0 && rosterFromPaste("Raleigh", snap).unmatched.length === 0,
      `${JSON.stringify(sug("Raleigh"))} / ${JSON.stringify(rosterFromPaste("Raleigh", snap).unmatched)}`)
    {
      // A surname two men share says nothing, and says it by offering nothing.
      const bySur = new Map()
      for (const p of snap.players) {
        const parts = p.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(" ")
        if (parts.length < 2) continue
        const k = parts[parts.length - 1]
        bySur.set(k, new Set([...(bySur.get(k) ?? []), p.id]))
      }
      const shared = [...bySur].find(([, ids]) => ids.size > 1)?.[0]
      t("a surname two men share is refused, with no guess attached",
        !shared || sug(shared).length === 0, `${shared}: ${JSON.stringify(sug(shared ?? "zzz"))}`)
    }
    // and it is one word or nothing: two words that are not a name stay refused
    t("a two-word line that is nobody is still refused",
      sug("Big Dumper").length === 0, JSON.stringify(sug("Big Dumper")))

    // A man the paste already produced is not offered as a correction to another
    // line: he is on the team, and asking about him reads as a failure.
    const twice = rosterFromPaste(`${judge.name}\nAaron Judg`, snap)
    t("a man already found is not suggested again for a second, misspelled line",
      twice.players.length === 1 && twice.suggestions.length === 0,
      JSON.stringify(twice.suggestions))

    // Page furniture produced nobody before and must produce no questions either.
    const junk = rosterFromPaste(
      "Sign in Scores Standings Players Draft\nTerms Privacy Help Feedback About Advertise\n" +
        "Download the app today and get a free trial\nMoneyline Over Under Spread Parlay Bet now",
      snap
    )
    t("and a page of advertising asks nothing",
      junk.suggestions.length === 0, JSON.stringify(junk.suggestions))
  }
}

// ── the rule, measured against the whole capture ───────────────────────────────
//
// The numbers quoted in src/data/paste.ts, re-derived here — with the two REJECTED
// rules alongside, because the reason for the threshold is a comparison and a
// comparison nobody can re-run is an opinion.
//
// What chose the rule is the false-match rate, not the hit rate. A reader accepts a
// plausible name without reading it, so a suggestion that is right most of the time
// is worse than no suggestion: he would end up with a roster he did not assemble and
// no way to tell. Both rejected rules are rejected on that number alone.
//
//   · "a surname unique among all the men" — tempting, because 982 of the 1,445
//     surnames are unique. Printed below as `surname`.
//   · the same edit-distance rule at 2 instead of 1, which catches more real typos
//     and pays for it. Printed below as `d2`, and run through the shipped function
//     itself so the two differ in nothing but the threshold.
{
  const byId = new Map()
  for (const p of all) if (!byId.has(p.id)) byId.set(p.id, p)
  const men = [...byId.values()]

  const fold = n =>
    n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[.'’]/g, "").replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
      .replace(/[.,’\-]/g, " ").replace(/\s+/g, " ").trim()

  const surnames = new Map()
  for (const p of men) {
    const toks = fold(p.name).split(" ")
    const last = toks[toks.length - 1]
    if (!surnames.has(last)) surnames.set(last, new Set())
    surnames.get(last).add(p.id)
  }
  const unique = [...surnames.values()].filter(s => s.size === 1).length

  const RULES = {
    "ours (d1)": line => nearestName(line, all, 1)?.id ?? null,
    d2: line => nearestName(line, all, 2)?.id ?? null,
    surname: line => {
      const hits = new Set()
      for (const tok of fold(line).split(" ")) {
        const s = surnames.get(tok)
        if (s) for (const id of s) hits.add(id)
      }
      return hits.size === 1 ? [...hits][0] : null
    }
  }

  // Typos modelled on a thumb: a dropped letter, a neighbouring key, a doubled
  // letter, two adjacent letters swapped. Then three inputs that are not typos at
  // all and must be refused — a surname alone, an initial and a surname, and a line
  // mangled twice, which no longer says who it meant.
  const NEAR = { a: "s", b: "v", c: "x", d: "s", e: "w", f: "d", g: "f", h: "g", i: "u",
    j: "h", k: "j", l: "k", m: "n", n: "b", o: "i", p: "o", q: "w", r: "e", s: "a",
    t: "r", u: "y", v: "c", w: "q", x: "z", y: "t", z: "x" }
  const mid = n => {
    const L = [...n].map((c, i) => [c, i]).filter(([c]) => /[a-z]/i.test(c))
    return L.length ? L[Math.floor(L.length / 2)] : null
  }
  const drop = n => { const m = mid(n); return m ? n.slice(0, m[1]) + n.slice(m[1] + 1) : null }
  const near = n => { const m = mid(n); return m ? n.slice(0, m[1]) + (NEAR[m[0].toLowerCase()] ?? "x") + n.slice(m[1] + 1) : null }
  const twice = n => { const m = mid(n); return m ? n.slice(0, m[1]) + m[0] + n.slice(m[1]) : null }
  const swap = n => {
    const parts = n.split(" ")
    const w = parts[parts.length - 1]
    if (w.length < 4) return null
    const i = Math.floor(w.length / 2)
    parts[parts.length - 1] = w.slice(0, i - 1) + w[i] + w[i - 1] + w.slice(i + 1)
    return parts.join(" ")
  }
  const GENS = {
    "a dropped letter": drop,
    "a neighbouring key": near,
    "a doubled letter": twice,
    "two letters swapped": swap,
    "· surname alone": n => n.split(" ").slice(1).join(" "),
    "· initial + surname": n => `${n[0]}. ${n.split(" ").slice(1).join(" ")}`,
    "· mangled twice": n => { const a = drop(n); return a ? near(a) : null }
  }

  const score = (resolve, gen) => {
    let n = 0, right = 0, wrong = 0
    for (const p of men) {
      const typo = gen(p.name)
      if (!typo || fold(typo) === fold(p.name)) continue
      n++
      const id = resolve(typo)
      if (id === p.id) right++
      else if (id) wrong++
    }
    return { n, right, wrong }
  }
  const pct = (a, b) => `${((100 * a) / b).toFixed(1)}%`
  const tally = {}
  const t0 = Date.now()
  console.log(`      ${" ".repeat(21)}${Object.keys(RULES).map(r => r.padStart(18)).join("")}`)
  for (const [label, gen] of Object.entries(GENS)) {
    const row = []
    for (const [rule, resolve] of Object.entries(RULES)) {
      const s = score(resolve, gen)
      tally[rule] = tally[rule] ?? { n: 0, right: 0, wrong: 0 }
      const bucket = label.startsWith("·") ? "refuse" : "typo"
      tally[rule][bucket] = tally[rule][bucket] ?? { n: 0, right: 0, wrong: 0 }
      for (const f of ["n", "right", "wrong"]) tally[rule][bucket][f] += s[f]
      row.push(`${s.right}/${s.wrong}`.padStart(18))
      tally[rule][`${label}`] = s
    }
    console.log(`      ${label.padEnd(21)}${row.join("")}   of ${score(RULES["ours (d1)"], gen).n}`)
  }
  console.log(`      right/wrong per rule. ${unique} of ${men.length} surnames are unique. ${Date.now() - t0}ms`)

  const d1 = tally["ours (d1)"], d2 = tally.d2, sn = tally.surname
  for (const [lab, r] of [["d1", d1], ["d2", d2], ["surname", sn]])
    console.log(`      ${lab.padEnd(8)} real typos ${pct(r.typo.right, r.typo.n)} right, ${pct(r.typo.wrong, r.typo.n)} wrong` +
      ` | should-refuse answered ${pct(r.refuse.right + r.refuse.wrong, r.refuse.n)}, of those ${pct(r.refuse.wrong, Math.max(1, r.refuse.right + r.refuse.wrong))} wrong`)

  // Distance 1 was 99.1% right with 0 wrong on 5,621 single-typo names when this was
  // written. The floor is what the comment in src/data/paste.ts claims; the
  // wrong-answer ceiling is the assertion that matters, because a wrong suggestion is
  // the only harm this feature can do and a missed one is merely the status quo.
  t("a single typo resolves to the right man, nearly always",
    d1.typo.right / d1.typo.n > 0.98, `${d1.typo.right}/${d1.typo.n}`)
  t("and to the wrong man almost never",
    d1.typo.wrong / d1.typo.n < 0.005, `${d1.typo.wrong}/${d1.typo.n}`)

  // The surname rule answers a third as often AND is wrong on two fifths of the
  // answers it does give: a misspelled surname is the actual case here, and a
  // misspelled surname is a different surname.
  t("a unique surname is wrong on a large share of the answers it gives",
    sn.typo.wrong / (sn.typo.right + sn.typo.wrong) > 0.3,
    `${sn.typo.wrong} wrong of ${sn.typo.right + sn.typo.wrong} answered`)
  t("where distance 1 gives none of those wrong answers at all",
    d1.typo.wrong < sn.typo.wrong / 20, `${d1.typo.wrong} vs ${sn.typo.wrong}`)

  // Distance 2 reads better on real typos and is still the wrong threshold: it
  // answers inputs that do not say who they meant — a bare surname, an initial and a
  // surname, a line mangled twice — and a suggestion offered there is wrong far more
  // often than one offered at distance 1.
  t("distance 2 answers the inputs that do not say who they meant",
    d2.refuse.right + d2.refuse.wrong > 5 * (d1.refuse.right + d1.refuse.wrong),
    `${d2.refuse.right + d2.refuse.wrong} vs ${d1.refuse.right + d1.refuse.wrong} of ${d1.refuse.n}`)
  t("and is wrong on more of them than distance 1 is",
    d2.refuse.wrong > d1.refuse.wrong, `${d2.refuse.wrong} vs ${d1.refuse.wrong}`)

  // ── and on text that holds no player at all ─────────────────────────────────
  //
  // The corpus is this repo's own committed English prose — README.md and docs/ —
  // because it is the closest reproducible thing to the prose a reader's paste
  // carries around the names, and every question asked of it is a wrong question:
  // documentation is not a roster.
  const prose = ["README.md", "docs/GUIDE.md", "docs/METHODOLOGY.md"]
    .flatMap(f => readFileSync(f, "utf8").split(/\r?\n/))
    .map(l => l.trim())
    .filter(l => l.length > 3 && /[a-z]/i.test(l))
  const fire = (resolve, lines) => lines.filter(l => resolve(l) !== null).length
  const t1 = Date.now()
  const mineFire = fire(RULES["ours (d1)"], prose)
  const ms = Date.now() - t1
  const snFire = fire(RULES.surname, prose)
  // Distance 2 is not scored on this corpus: it takes about five seconds, and the
  // case against it is already made above by how much it answers when it should
  // refuse. Measured once by hand on 2026-09-11 it asked on 11 of these 2,679 lines
  // against distance 1's 2, which is the same direction and is not relied on here.
  console.log(`      ${prose.length} lines of prose, no player in any of them: d1 asked on ${mineFire} (${pct(mineFire, prose.length)}) in ${ms}ms, surname on ${snFire} (${pct(snFire, prose.length)})`)

  // 0.07% when this was written — 2 lines of 2,679: "their own pages" is one edit
  // from Andy Pages and "lets Billy look" from Billy Cook. Nothing rules those out
  // without a dictionary, and at one line in 1,340 the reader is asked a silly
  // question rarely enough that it reads as a silly question rather than as a bug.
  t("text that holds no player asks the reader almost nothing",
    mineFire / prose.length < 0.003, `${mineFire}/${prose.length}`)
  // The surname rule asked on 2.9% of these lines — one in thirty-four — which is
  // what ruled it out on its own.
  t("where a unique surname would interrupt him far more often",
    snFire > mineFire * 10, `${snFire} vs ${mineFire}`)
  // Index build plus 2,679 lines, which is several times the size of a pasted roster
  // page. Comparing every one of the 2,882 keys instead of looking up the deletion
  // index took 63 seconds for the same work.
  t("and it is fast enough to run on every read rather than on a button",
    ms < 3000, `${ms}ms`)
}

// --- a surname two men share says why, rather than reading like a typo ------------
//
// Once a unique surname is accepted, the one-word line left over is the one two men carry —
// and the reader was told only "I couldn't find a player in this line: «Soto»", which is true,
// unhelpful, and indistinguishable from a misspelling. He typed a real surname and the app
// knows exactly what is wrong with it.
{
	const r = rosterFromPaste("Judge\nSoto\nOhtani", snap)
	t("the unique surnames are taken and the shared one is not",
		r.players.length === 2 && r.unmatched.join() === "Soto",
		`${r.players.map(p => p.name).join(", ")} / ${JSON.stringify(r.unmatched)}`)
	t("and the note says why that one was left out",
		/«Soto» is a surname more than one man in baseball has/.test(r.note) &&
			/add a first name/.test(r.note),
		r.note)
	// No names offered, deliberately: "Juan Soto or Gregory Soto" as buttons is the guess this
	// whole path refuses, and a tappable wrong answer beside a tappable right one is how a
	// reader ends up owning a roster he did not assemble.
	t("and offers neither of them as a chip",
		!r.suggestions.some(s => /Soto/.test(s.name)), JSON.stringify(r.suggestions))
	// Plural and singular are different sentences, and the plural one is the commoner.
	const two = rosterFromPaste("Soto\nGarcía", snap)
	t("two shared surnames read as two", /are surnames/.test(two.note) || two.unmatched.length < 2,
		`${JSON.stringify(two.unmatched)} — ${two.note}`)
	// Quoted the same way the unmatched-lines message quotes a line, so one screen does not
	// quote the same string two ways.
	t("quoted the way the rest of the message quotes a line", /«Soto»/.test(r.note), r.note)
}

/*
 * THE ADVICE MATCHES THE ROUTE HE TOOK.
 *
 * One sentence answered both and it was written for the paste. Measured by a stranger on
 * a phone who typed six surnames into a box headed "First and last name, one to a line":
 * six failures, then "Select your whole roster page — extra columns and adverts do no
 * harm", which is advice for a route a phone does not have, as the second sentence he
 * reads after failing.
 */
{
	/* THE OLD FIXTURE WAS "Judge / Vladdy / Skubal / Witt Jr", and it stopped matching nobody
	   on 2026-09-12 — "Judge" and "Skubal" are surnames exactly one man in the pool carries, so
	   they are now accepted rather than refused, which is the change that landed that day. The
	   claim under test is about the ADVICE a failure gives, so the fixture is now four lines
	   that genuinely resolve to nobody: two nicknames, one surname two men share, and gibberish.
	   That the old fixture no longer fits is itself evidence the surname rule works. */
	const typed = rosterFromPaste("Vladdy\nBig Dumper\nSoto\nasdfgh", snap)
	t("a typed list that matches nobody is told how to write a name",
		typed.players.length === 0 &&
			/first and last name/i.test(typed.note) &&
			!/roster page/i.test(typed.note),
		typed.note)
	// A real paste still gets the paste advice: tabs, or a page's worth of lines.
	const pasted = rosterFromPaste(
		Array.from({ length: 14 }, (_, i) => `Bench\tNobody Atall ${i}\tSEA\t0.0`).join("\n"),
		snap
	)
	/* IT NO LONGER SAYS "the whole page", and that is the point of the change rather than a
	   loosening: a walk that followed "select your whole roster page" literally pulled two men
	   nobody owns into a roster, out of the news and trending modules beside the list. The claim
	   under test is unchanged — a paste gets paste advice and not "write each man's name" — so
	   it is matched on the advice's own subject, the list of players. */
	t("and a pasted page that matches nobody is still told to select the list, not to type",
		pasted.players.length === 0 &&
			/list of your players/i.test(pasted.note) &&
			!/one to a line/i.test(pasted.note),
		pasted.note)
}

/*
 * TWO SILENCES, both of them the same rule: an absence is stated as an absence.
 *
 * A man listed twice is counted once — correct, and it used to say nothing, so a reader
 * whose pasted page prints somebody in a lineup section AND a bench section got a count he
 * could not reconcile with what he could see.
 *
 * And `unmatched` had a three-character floor, which is right for a copied page (a column
 * of ordinals, a stray "OF", an advert's "x") and wrong for a list somebody typed, where
 * every line is his. Typing "asdfgh / 12345 / ???" quoted only «asdfgh» back while saying
 * "Nothing in THEM is counted anywhere" — a plural about a list the reader cannot see. The
 * floor now applies only where the text looks pasted, by the same test that picks which
 * advice to give.
 */
{
	/* Named here rather than borrowed: `judge` above is scoped to another block. */
	const who = snap.players.find(p => /^Aaron Judge$/.test(p.name)).name
	const thrice = rosterFromPaste(`${who}\n${who}\n${who}`, snap)
	t("a man listed three times is counted once, and the note says he was",
		thrice.players.length === 1 && /3 times/.test(thrice.note) && /counted once/.test(thrice.note),
		thrice.note)
	t("and a man listed once is not accused of being listed twice",
		!/more than once/.test(rosterFromPaste(who, snap).note),
		rosterFromPaste(who, snap).note)

	const typed = rosterFromPaste("asdfgh\n12345\n???", snap)
	t("every line of a TYPED list that matched nobody is quoted back, short ones included",
		typed.unmatched.includes("asdfgh") && typed.unmatched.includes("12345"),
		JSON.stringify(typed.unmatched))
	/* The floor still holds on a paste, which is what it is for: a page's worth of tab-
	   separated rows must not have its furniture quoted back line by line. */
	const page = Array.from({ length: 14 }, (_, i) => `${i + 1}\tNobody Atall ${i}\tSEA\t0.0`).join("\n")
	const pasted = rosterFromPaste(page, snap)
	t("and a pasted page is still judged by the floor, so its furniture is not quoted",
		pasted.unmatched.every(l => l.length > 3), JSON.stringify(pasted.unmatched.slice(0, 3)))
}

// ── YAHOO'S OWN FLAG BESIDE A HURT MAN ────────────────────────────────────────
//
// It is read from the gap between his name and the NEXT man's seat, and that gap
// stops 24 characters short of the next name — exactly the span `slotBefore` claims
// for his seat — because IL and NA are seat tokens as well as flags. Overlap the two
// and the next man's IL SEAT sits this man down.
{
  const [a, b, c] = bats
  /* THE ROW IS WIDE, and that is what makes this checkable rather than a fixture
     trick. A Yahoo team row carries the seat, the name, the eligibility line, the
     flag, the opponent, the start time and a run of stat cells, so there are well
     over 24 characters between one man's name and the next man's seat. A narrow
     fixture would make `statusBetween` correctly find nothing and this suite would
     pass over a dead function. */
  const wide = "Wed 7:05 pm @ BAL Preview 0.0 0.0 0.0 0.0 Add Drop"
  const flagged = playersInText(
    `C\t${a.name} NYY - C\tQ\t${wide}\n` +
      `1B\t${b.name} NYY - 1B\t${wide}\n` +
      `IL\t${c.name} NYY - OF\t${wide}`,
    all
  ).players
  const of = n => flagged.find(x => x.id === n.id)
  t("the flag between his name and the next man is read",
    of(a)?.status === "Q", JSON.stringify(of(a)))
  t("a man with nothing beside him carries no flag, and null is not \"healthy\"",
    of(b)?.status === null, JSON.stringify(of(b)))
  /* THE ONE THAT MATTERS. The third man SITS in an IL seat; the second man has
     nothing. If the window reached the next name, "IL" would be read as the second
     man's injury and a healthy regular would be benched by a seat label. */
  t("the next man's IL SEAT is never read as this man's injury",
    of(b)?.status === null && of(c)?.slot === "IL", `${of(b)?.status} / ${of(c)?.slot}`)
  const plus = playersInText(`C\t${a.name} NYY - C\tIL+\tP\tAdd/Drop`, all).players
  t("IL+ is read at its own index rather than shadowed by IL",
    plus[0]?.status === "IL+", JSON.stringify(plus[0]))
  t("…and a bare P in the same gap is never a flag, because P is a seat and a position",
    plus[0]?.status !== "P")
  t("a typed list of names carries no flags at all, which is what a typed list says",
    playersInText(bats.map(p => p.name).join("\n"), all).players.every(p => p.status === null))
}

// ── THE LEAGUE'S OWN ELIGIBILITY LINE ─────────────────────────────────────────
//
// "NYY - C,1B" is the live multi-position line and the only place a league's REAL
// eligibility is readable. Until now this app read `snapshot.eligibility`, 328 of
// 1,446 players captured on one day, and gave the other 77% StatsAPI's single
// primary position. Every refusal below leaves a man ABSENT, which puts him back on
// exactly those two fallbacks — so the rule can widen a man and can never narrow one.
{
  const [a, b] = bats
  const arm = arms[0]
  const got = eligibilityInText(
    `C\t${a.name} NYY - C,1B\tAdd/Drop\n` +
      `SP\t${arm.name} DET - SP\tWed 7:05 @ BAL\t14-4 W-L\n` +
      `1B\t${b.name} NYY - 1B,XX\tAdd/Drop`,
    [a, b, arm]
  )
  t("the whole line is read, so a man Yahoo lists at two positions is eligible at two",
    JSON.stringify(got.get(a.id)) === JSON.stringify(["C", "1B"]), JSON.stringify(got.get(a.id)))
  t("a pitcher's W-L record is not read as an eligibility line",
    JSON.stringify(got.get(arm.id)) === JSON.stringify(["SP"]), JSON.stringify(got.get(arm.id)))
  t("a list carrying one token that is not a position is refused whole, not in part",
    got.get(b.id) === undefined, JSON.stringify(got.get(b.id)))
  /* Ohtani is the real shape: Yahoo lists him twice, as a batter and as a pitcher,
     with a different line each. One line is his, or none is. */
  t("a man on two lines has no line that is his, so he keeps the fallback",
    eligibilityInText(`C\t${a.name} NYY - C\n SP\t${a.name} NYY - SP`, [a]).get(a.id) === undefined)
  t("a token before a name is not that name's eligibility",
    eligibilityInText(`NYY - C,1B\tsomething else entirely ${a.name}`, [a]).get(a.id) === undefined)
  t("a typed list with no line at all yields nothing and throws nothing",
    eligibilityInText(bats.map(p => p.name).join("\n"), bats).size === 0)
  // And the seat it actually produces: DH must become Util or a designated hitter is
  // unseatable, which `slotsFor` does and this must not bypass.
  const seated = rosterFromPaste(`C\t${a.name} NYY - C,1B\tAdd/Drop`, snap).spots
  t("the page's line reaches the seat, widening a man the capture never listed",
    seated[0]?.positions.includes("1B") && seated[0]?.positions.includes("C"),
    JSON.stringify(seated[0]))
}

// ── the seat he is already in is evidence, and the fourth tier ────────────────
//
// Yahoo enforces eligibility on every startable seat: it will not let a man sit at 1B
// unless it grants him 1B. So a roster page showing him at 1B is a FACT about his
// eligibility, and a better one than the two fallbacks under the page — the capture's
// 328-of-1,446 grid, and StatsAPI's single primary position.
//
// WHAT IT COST. Measured 2026-09-23 on a 27-man fixture whose seats came from a real
// card and whose positions came from the capture: zero of the 27 were in the grid, so
// all 27 fell to their primary position, nine of the eighteen active seats then
// contradicted it, `planLineup` could seat those nine nowhere, and the period plan came
// back at -144.42 against the lineup it was replacing — a loss made entirely of men
// leaving the model. Put each man's own seat back and nothing else changes: +16.36,
// nobody unplaceable, 16 of 18 seats filled instead of 12.
//
// The bound on it is the half that makes it safe: a seat that accepts ANYBODY proves
// nothing about the man in it, so Util, BN, IL and NA may not widen him. That is the
// same refusal `eligibilityInText` above makes when a line offers more tokens than a
// league could be tracking — evidence, or nothing, never half of it.
{
  // A catcher, pasted into a 1B seat his capture position does not grant, with no
  // eligibility line beside him so the page tier cannot answer either.
  const c = all.find(p => p.group === "hitting" && p.position === "C" && !snap.eligibility?.[String(p.id)])
  if (c) {
    const seat = n => rosterFromPaste(`${n}\t${c.name}`, snap).spots[0]?.positions ?? []
    t("a man in a startable seat is eligible there, because his league put him in it",
      seat("1B").includes("1B"), `${c.name} at 1B: ${seat("1B").join(",")}`)
    t("…and keeps what the capture already knew about him",
      seat("1B").includes("C") && seat("1B").includes("Util"),
      `${c.name} at 1B: ${seat("1B").join(",")}`)
    /* `seat("C")` is the unwidened baseline: his own capture position already grants C,
       so the union is a no-op there and whatever it returns is what the tiers alone say.
       A seat that accepts anybody must come back identical to it. */
    const base = seat("C").join(",")
    t("a Util seat widens nobody, because it accepts everybody",
      seat("Util").join(",") === base, `Util: ${seat("Util").join(",")} vs ${base}`)
    t("and neither does the bench or the injured list",
      seat("BN").join(",") === base && seat("IL").join(",") === base,
      `BN: ${seat("BN").join(",")} | IL: ${seat("IL").join(",")} vs ${base}`)
    t("a startable seat that IS in his positions adds nothing twice",
      seat("C").length === new Set(seat("C")).size, seat("C").join(","))
    /* And the page still wins where it answers: a man Yahoo prints as C,1B needs no
       help from his seat, and the seat must not push a third position onto him. */
    const printed = rosterFromPaste(`3B\t${c.name} NYY - C,1B\tAdd/Drop`, snap).spots[0]
    t("a seat the page contradicts still adds itself, because the page is about eligibility and the seat is a fact",
      (printed?.positions ?? []).includes("3B") && (printed?.positions ?? []).includes("1B"),
      JSON.stringify(printed))
  } else {
    t("this capture holds a catcher the eligibility grid does not list", false, "fixture gap")
  }
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
