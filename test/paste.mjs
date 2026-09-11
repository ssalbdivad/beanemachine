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
import { nearestName, playersInText, rosterFromPaste } from "../src/data/paste.ts"

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
      ["a surname on its own", "Raleigh"],
      ["a nickname", "Vladdy"],
      ["another nickname", "Big Dumper"],
      ["an initial and a surname", "A. Judge"]
    ])
      t(`${label} is still refused, with no guess attached`,
        sug(line).length === 0, JSON.stringify(sug(line)))

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

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
