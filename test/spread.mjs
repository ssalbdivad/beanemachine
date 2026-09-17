// What src/engine/spread.ts measures, asserted against the committed bytes — and,
// behind --measure, the harness that re-derives every number in that file's comments
// from MLB's own day-by-day record.
//
// The split matters. The default run asserts arithmetic and refusals against files
// that are in this repository, so it is offline, deterministic and fast. The corpus
// the module's coefficients came from is 736 live single-day reads across two
// seasons, which no test may make on every run — so it lives behind a flag, uses the
// backtest's own URL-keyed disk cache, and is the thing to run when a coefficient in
// spread.ts is in doubt. Evidence that cannot be re-derived is not evidence.
import { readFileSync } from "node:fs"
import {
	spreadOf, cohortOf, separates,
	LEVEL_FIT, RELIABILITY_K, SAMPLING_ERROR, COHORT_SHAPE,
	MINIMUM_APPEARANCES, START_SHARE
} from "../src/engine/spread.ts"
import { asNumber, mapPlayerSeasons, windowStatsUrl } from "../src/data/statsapi.ts"
import { scoreStats } from "../src/engine/points.ts"

const league = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const BAT = league.scoring.batting
const PIT = league.scoring.pitching
let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol

// ---------------------------------------------------------------------------
// 0. THE ABSENCE. This is the assertion the whole module rests on, so it is first.
//
// data/snapshot.json LOOKS like it carries game logs — `recentStats` is a per-player
// map of stat lines — and it does not. Each line is one AGGREGATE over the longest
// recent window (21 days), so the games inside it have already been added together
// and the distribution destroyed. If that ever changes, spread.ts could read the
// capture directly instead of being handed lines, and this test should be the thing
// that notices. Stated as an absence because it is one.
// ---------------------------------------------------------------------------
const snap = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const recent = Object.entries(snap.recentStats ?? {})
const multi = recent.filter(([, line]) => (line.gamesPlayed ?? 0) > 1)
t("the committed capture holds no per-game line: recentStats are window aggregates",
	recent.length > 0 && multi.length / recent.length > 0.5,
	`${multi.length} of ${recent.length} cover more than one appearance`)
t("that aggregation is what spread.ts's comment records (455 of 515, 88.3%, max 11)",
	recent.length === 515 && multi.length === 455 &&
		Math.max(...recent.map(([, l]) => l.gamesPlayed ?? 0)) === 11,
	`${multi.length}/${recent.length}, max ${Math.max(...recent.map(([, l]) => l.gamesPlayed ?? 0))}`)
t("and the capture carries no recent line at all on the hitting side",
	recent.every(([key]) => key.endsWith(":pitching")),
	`${recent.filter(([k]) => k.endsWith(":hitting")).length} hitting lines`)

// ---------------------------------------------------------------------------
// 1. REAL COMMITTED GAME LINES. test/fixtures/mlb-byDateRange-*-2026-09-11.json are
// MLB's own byDateRange responses for a single day, so every split in them is one
// real game. Five hitters and three pitchers is not a distribution and is not
// pretended to be one — what it pins is that the scoring path, the quantiles and the
// derived fields all agree with hand-checkable arithmetic on bytes nobody can edit
// without the diff showing.
// ---------------------------------------------------------------------------
const fixtureLines = group =>
	JSON.parse(readFileSync(`test/fixtures/mlb-byDateRange-${group}-2026-09-11.json`, "utf8"))
		.stats.flatMap(b => b.splits)
		.map(s => {
			const line = {}
			for (const [k, v] of Object.entries(s.stat ?? {})) {
				const n = asNumber(v)
				if (n !== null) line[k] = n
			}
			return line
		})
const H = fixtureLines("hitting")
const P = fixtureLines("pitching")
t("the committed fixtures are single-game lines", H.length === 5 && P.length === 3 &&
	[...H, ...P].every(l => l.gamesPlayed === 1), `${H.length} hitting, ${P.length} pitching`)

// priced in league 228947's own table, which is what makes these point figures
// league-specific rather than universal
const hPts = H.map(l => scoreStats(l, BAT, "hitting").points).sort((a, b) => a - b)
t("the five real hitter-days price to 0, 1.9, 25.8, 34.1, 34.1 in this league",
	JSON.stringify(hPts) === JSON.stringify([0, 1.9, 25.8, 34.1, 34.1]), JSON.stringify(hPts))

const h = spreadOf(H, BAT, "hitting", { minimum: 5 })
t("mean of those five is 19.18", near(h.mean, 19.18))
// R type 7 on five points: median is the 3rd, p25 the 2nd, p75 the 4th, and p90
// interpolates 60% of the way from the 4th to the 5th — which here are equal
t("median is the middle value, 25.8", near(h.median, 25.8))
t("p25 is the second value, 1.9 (h = 4 × 0.25 = 1, no interpolation)", near(h.p25, 1.9))
t("p75 is the fourth value, 34.1 (h = 3)", near(h.p75, 34.1))
t("p90 interpolates between the 4th and 5th, both 34.1", near(h.p90, 34.1))
t("sample sd (n − 1) of those five is 17.00", near(h.sd, 17))
t("relative spread is sd ÷ mean, 0.886", near(h.relative, 0.886, 0.0005))

// the derived fields are the published coefficients applied, not separate magic
t("expected is LEVEL_FIT applied to the measured mean",
	near(h.expected, LEVEL_FIT.hitters.intercept + LEVEL_FIT.hitters.slope * h.mean, 0.01))
t("reliability is n / (n + k)", near(h.reliability, 5 / (5 + RELIABILITY_K.hitters), 0.001))
t("shrunkSd pulls the measured sd back toward expected by exactly that share",
	near(h.shrunkSd, h.expected + (h.sd - h.expected) * h.reliability, 0.01))
t("error is the measured sampling constant × sd ÷ √n",
	near(h.error, SAMPLING_ERROR.hitters * h.sd / Math.sqrt(5), 0.01))
// 5 games out of a k of 210 is 2.3% signal, so the shrunk number is the cohort's
// expectation with a rounding error on it. That is the correct answer and it is why
// MINIMUM_APPEARANCES exists.
t("five games shrink almost entirely away: 17.00 measured → 15.10 against a 15.05 expectation",
	near(h.shrunkSd, 15.1, 0.02) && near(h.expected, 15.05, 0.02), `${h.shrunkSd} / ${h.expected}`)

const p = spreadOf(P, PIT, "pitching", { minimum: 3 })
t("the three real pitcher-days price to 14, 29.5, 40.1",
	JSON.stringify(P.map(l => scoreStats(l, PIT, "pitching").points).sort((a, b) => a - b)) ===
		JSON.stringify([14, 29.5, 40.1]))
t("their median is the middle one, 29.5", near(p.median, 29.5))
t("their p90 interpolates 80% of the way from 29.5 to 40.1 → 37.98", near(p.p90, 37.98))

// ---------------------------------------------------------------------------
// 2. THE REFUSALS. A summary below the minimum is a p90 that is one game wearing a
// statistician's name, so the module returns null rather than serving it.
// ---------------------------------------------------------------------------
t(`nothing is returned below ${MINIMUM_APPEARANCES} appearances`,
	spreadOf(H, BAT, "hitting") === null && spreadOf(P, PIT, "pitching") === null)
t("a caller can lower the minimum, and that is a decision taken in the open",
	spreadOf(H, BAT, "hitting", { minimum: 5 }) !== null)
t("one line has no spread to measure and is refused even at minimum 1",
	spreadOf([H[0]], BAT, "hitting", { minimum: 1 }) === null)
t("exactly the minimum is enough; one short is not",
	spreadOf(H.concat(H), BAT, "hitting", { minimum: 10 }) !== null &&
		spreadOf(H.concat(H.slice(1)), BAT, "hitting", { minimum: 10 }) === null)

// ---------------------------------------------------------------------------
// 3. COHORTS. The rule is share of APPEARANCES made as starts, summed across lines
// rather than counted line by line, because a doubleheader arrives as one row.
// ---------------------------------------------------------------------------
t("a batting group is always hitters", cohortOf(H, "hitting") === "hitters")
t("the fixture's three pitchers are 2 starts in 3 appearances — 0.67, below the 0.8 " +
	"share, so they read as RP, the cohort a swingman is folded into",
	cohortOf(P, "pitching") === "RP")
t("all starts is SP", cohortOf([{ gamesPlayed: 1, gamesStarted: 1 }], "pitching") === "SP")
t("no starts is RP", cohortOf([{ gamesPlayed: 1, gamesStarted: 0 }], "pitching") === "RP")
t(`the boundary is inclusive at ${START_SHARE}`,
	cohortOf([{ gamesPlayed: 5, gamesStarted: 4 }], "pitching") === "SP" &&
		cohortOf([{ gamesPlayed: 5, gamesStarted: 3 }], "pitching") === "RP")
// the doubleheader case, which is the only place summing and counting disagree:
// two rows, one of them a two-game day carrying a single start
t("a doubleheader row counts its games, not its row — 1 start in 3 appearances is RP",
	cohortOf([{ gamesPlayed: 2, gamesStarted: 1 }, { gamesPlayed: 1, gamesStarted: 0 }],
		"pitching") === "RP")
t("a pitcher with no gamesPlayed field at all falls to RP rather than dividing by zero",
	cohortOf([{ strikeOuts: 3 }], "pitching") === "RP")

// ---------------------------------------------------------------------------
// 4. QUANTILES. R type 7 / numpy default, which is what every figure in spread.ts's
// comment was computed with. Asserted on integers so the expected values are
// checkable by hand rather than by running this file.
// ---------------------------------------------------------------------------
// ten lines each worth exactly one run (1.9 points) times a multiplier 0..9, so the
// priced series is 0, 1.9, 3.8 … 17.1 and every quantile is arithmetic
const ramp = Array.from({ length: 10 }, (_, i) => ({ gamesPlayed: 1, runs: i }))
const r = spreadOf(ramp, BAT, "hitting", { cohort: "hitters" })
t("a ramp of ten prices to 0 … 17.1", near(r.mean, 8.55) && near(r.p25, 4.28, 0.01))
t("median of an even count interpolates the two middle values: (7.6 + 9.5) / 2 = 8.55",
	near(r.median, 8.55))
// This line first asserted `p90 === 17.1`, on the reasoning that ten values put the
// 90th percentile on the tenth. That is what a naive n × p gives and it is wrong for
// type 7, which uses (n − 1) × p = 8.1 — so the answer is a tenth of the way from the
// 9th value to the 10th, 15.2 + 0.1 × 1.9 = 15.39. The old assertion is recorded here
// because the off-by-one it embodies is the single easiest mistake to make against
// this definition, and a reader who expects 17.1 should find out why they are wrong
// from the test rather than from a board.
t("p90 of ten values sits at h = (10 − 1) × 0.9 = 8.1, a tenth above the 9th value: 15.39",
	near(r.p90, 15.39))
t("a flat series has zero spread and a null-free relative of 0",
	(() => {
		const flat = spreadOf(Array.from({ length: 12 }, () => ({ gamesPlayed: 1, runs: 2 })),
			BAT, "hitting")
		return flat.sd === 0 && flat.relative === 0 && flat.p25 === flat.p90
	})())
// a reliever can genuinely average below zero in this league — H −1.3, ER −3, BB −1.3
// against OUT 1 and K 3 — and a ratio to a negative mean flips sign on a rounding
// error, so it is refused rather than reported
const bad = spreadOf(Array.from({ length: 12 }, (_, i) => ({
	gamesPlayed: 1, outs: 1, hits: 2, earnedRuns: i % 3, baseOnBalls: 1
})), PIT, "pitching")
t("a negative mean gives a null relative spread rather than a sign-flipping ratio",
	bad.mean < 0 && bad.relative === null, `mean ${bad.mean}, relative ${bad.relative}`)

// ---------------------------------------------------------------------------
// 5. SEPARATES. The only comparison the module offers, and it is about the
// measurements rather than about the players. The two pairs below are real 2026
// starters from the 15–18 points-per-start band; their sds and start counts are
// quoted from the measurement harness at the foot of this file.
//
// The first pair is the one that makes the whole idea LOOK like a lever: p90 41.88
// against 26.11, which reads as a decisive difference and is not one.
// ---------------------------------------------------------------------------
const measured = (sd, appearances) => ({
	cohort: "SP", sd, appearances,
	error: Number(((SAMPLING_ERROR.SP * sd) / Math.sqrt(appearances)).toFixed(2))
})
const jones = measured(17.23, 17)      // Jared Jones, mean 17.08, p90 41.88
const young = measured(11.52, 24)      // Brandon Young, mean 17.46, p90 26.11
const jump = measured(20.93, 19)       // Gage Jump, the band's widest by sd
const thornton = measured(11.26, 12)   // Zac Thornton, the band's narrowest by sd
t("the pair whose p90s look decisive (41.88 vs 26.11) does NOT separate on sd: " +
	"a 5.71 gap against a 5.94 threshold", separates(jones, young) === false)
t("the band's true extremes do separate: a 9.67 gap against 7.17",
	separates(jump, thornton) === true)
t("separation is symmetric", separates(jump, thornton) === separates(thornton, jump))
t("a player never separates from himself", separates(jones, jones) === false)
t("more starts is a tighter error bar: the same sd over 60 starts separates from " +
	"Young where it does not over 17",
	separates(measured(17.23, 60), young) === true && separates(jones, young) === false)

// ---------------------------------------------------------------------------
// 6. THE PUBLISHED COEFFICIENTS. Not re-derivable offline — they came from 736 live
// reads — so what is asserted here is that they are the numbers the comment claims
// and that they are internally consistent. `--measure` re-derives them for real.
// ---------------------------------------------------------------------------
t("LEVEL_FIT is the pooled 2025+2026 fit written in the comment",
	LEVEL_FIT.hitters.slope === 0.648 && LEVEL_FIT.SP.slope === 0.011 &&
		LEVEL_FIT.RP.slope === 0.066)
t("a starter's spread does not scale with his level, and the fit says so: R² 0.001 " +
	"against 0.734 for hitters", LEVEL_FIT.SP.r2 < 0.01 && LEVEL_FIT.hitters.r2 > 0.7)
t("RELIABILITY_K is large enough that no real season reaches half signal",
	140 / (140 + RELIABILITY_K.hitters) < 0.5 && 33 / (33 + RELIABILITY_K.SP) < 0.5 &&
		70 / (70 + RELIABILITY_K.RP) < 0.5)
t("a full hitter season is 40% signal and a full starter season 28%, as the comment says",
	near(140 / (140 + RELIABILITY_K.hitters), 0.4, 0.005) &&
		near(30 / (30 + RELIABILITY_K.SP), 0.275, 0.005))
t("the bootstrap sampling constants bracket the Gaussian 0.707 rather than assuming it",
	SAMPLING_ERROR.hitters > 0.707 && SAMPLING_ERROR.SP < 0.707)
t("COHORT_SHAPE keeps its quantiles in order for every cohort",
	Object.values(COHORT_SHAPE).every(c => c.p25 <= c.median && c.median <= c.p75 && c.p75 <= c.p90))
t("the three animals are genuinely different: a starter's median day is more than " +
	"three times a hitter's and his p90 two and a half times",
	COHORT_SHAPE.SP.median / COHORT_SHAPE.hitters.median > 3 &&
		COHORT_SHAPE.SP.p90 / COHORT_SHAPE.hitters.p90 > 2.5)

// ---------------------------------------------------------------------------
// 7. PURITY. The module must not reach for a snapshot, a clock or a board — the
// corpus it was measured on is 736 live reads no test may make, so the only way it
// stays checkable is by being handed everything it uses.
// ---------------------------------------------------------------------------
const src = readFileSync("src/engine/spread.ts", "utf8")
const body = src.slice(src.indexOf("export type Cohort"))
t("spread.ts imports nothing but a type and the scoring it is handed",
	[...src.matchAll(/^import .*?from "(.+?)"/gm)].map(m => m[1]).every(
		s => s === "../data/statsapi.ts" || s === "./points.ts"))
t("and reads no clock, no file and no network",
	!/Date\.now|new Date|readFileSync|fetch\(/.test(body))
t("the same lines in a different order give the same summary",
	JSON.stringify(spreadOf([...H].reverse(), BAT, "hitting", { minimum: 5 })) ===
		JSON.stringify(h))
// Grepping the file for "rank" catches its own comments arguing against ranking,
// which is the opposite of a finding. So the check is on what the module actually
// hands back and hands out: no field that could be sorted on as a verdict, and no
// exported name that invites one.
t("no field of a summary is a score, a rank or a verdict",
	Object.keys(h).every(k => !/rank|score|value|verdict|grade/i.test(k)), Object.keys(h).join(","))
t("the module exports measurements and one comparison, and nothing that orders players",
	[...body.matchAll(/^export const (\w+)/gm)].map(m => m[1]).every(
		n => !/rank|sort|best|pick|order|prefer/i.test(n)))

console.log(`\n${pass} passed, ${fail} failed`)

// ===========================================================================
// THE MEASUREMENT HARNESS — `node test/spread.mjs --measure`
//
// Re-derives every number in spread.ts's comment from MLB's own record. 736 reads on
// a cold cache (172 days × 2 sides for 2026, 196 × 2 for 2025), a few seconds on a
// warm one: it goes through src/backtest/cache.ts, which is keyed by the URL string
// and shared with the backtest, so the two never fetch the same day twice.
//
// It is opt-in because a test suite must not make 736 network calls, and it is here
// rather than in a scratch file because a measurement nobody can re-run is a number
// nobody can check. Every figure in the module's comment can be read off this output.
// ===========================================================================
if (process.argv.includes("--measure")) {
	const { cachedFetch } = await import("../src/backtest/cache.ts")
	const iso = d => d.toISOString().slice(0, 10)
	const days = (y, from, to) => {
		const out = []
		for (let d = new Date(from); d <= new Date(to); d = new Date(d.getTime() + 86400_000))
			out.push(iso(d))
		return out
	}
	// 2026 stops on the 7th — the day BEFORE data/snapshot.json's capturedAt — so
	// nothing measured here is a day the committed capture had not seen.
	const CORPUS = {
		2026: days(2026, "2026-03-20", "2026-09-07"),
		2025: days(2025, "2025-03-20", "2025-10-01")
	}
	const q = (s, p) => {
		const hh = (s.length - 1) * p, lo = Math.floor(hh), hi = Math.ceil(hh)
		return s[lo] + (hh - lo) * (s[hi] - s[lo])
	}
	const mean = a => a.reduce((x, y) => x + y, 0) / a.length
	const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) }
	const fit = (y, x) => {
		const mx = mean(x), my = mean(y)
		const b = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / x.reduce((s, v) => s + (v - mx) ** 2, 0)
		const a = my - b * mx
		const sse = y.reduce((s, v, i) => s + (v - (a + b * x[i])) ** 2, 0)
		const sst = y.reduce((s, v) => s + (v - my) ** 2, 0)
		return { a, b, r2: 1 - sse / sst, rmse: Math.sqrt(sse / (y.length - 2)) }
	}
	const resid = (y, x) => { const f = fit(y, x); return y.map((v, i) => v - (f.a + f.b * x[i])) }
	const corr = (x, y) => {
		const mx = mean(x), my = mean(y)
		return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) /
			Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0))
	}
	const season = async year => {
		const by = new Map()
		let rows = 0, doubles = 0
		for (const date of CORPUS[year])
			for (const group of ["hitting", "pitching"]) {
				const body = JSON.parse(await cachedFetch(windowStatsUrl(year, group, date, date)))
				for (const pl of mapPlayerSeasons(body.stats?.flatMap(b => b.splits) ?? [], group)) {
					rows++
					if ((pl.stats.gamesPlayed ?? 0) > 1) doubles++
					const key = `${pl.id}:${group}`
					const held = by.get(key) ?? by.set(key, {
						name: pl.name, group, lines: [], played: 0, started: 0
					}).get(key)
					held.lines.push(pl.stats)
					held.played += pl.stats.gamesPlayed ?? 0
					held.started += pl.stats.gamesStarted ?? 0
				}
			}
		const out = []
		for (const p of by.values()) {
			const cohort = p.group === "hitting" ? "hitters"
				: p.played && p.started / p.played >= START_SHARE ? "SP"
				: p.started === 0 ? "RP" : "swing"
			const table = p.group === "hitting" ? BAT : PIT
			// CHRONOLOGICAL, and the sorted copy is separate. Sorting in place here is
			// not a tidy-up, it is a fabricated result: section 3 splits a player's
			// games alternately, and alternating a SORTED series hands each half the
			// interleaved order statistics of the other. The half-to-half correlation
			// of the sd then came back 0.65–0.84 instead of 0.12–0.21 — a reliability
			// four times the real one, and every k derived from it (25, 4, 6 against
			// the true 210, 79, 171) said a spread was knowable from a handful of
			// games. Caught only because the numbers disagreed with the module's.
			const pts = p.lines.map(l => scoreStats(l, table, p.group).points)
			const ordered = [...pts].sort((a, b) => a - b)
			out.push({ ...p, cohort, pts, n: pts.length, mean: mean(pts), sd: pts.length > 1 ? sd(pts) : 0,
				med: q(ordered, 0.5), p25: q(ordered, 0.25), p75: q(ordered, 0.75), p90: q(ordered, 0.9) })
		}
		console.log(`${year}: ${CORPUS[year].length} days, ${rows} player-days, ${by.size} players, ` +
			`${doubles} doubleheader rows (${(100 * doubles / rows).toFixed(2)}%)`)
		return out
	}
	const MIN = { hitters: 20, SP: 10, RP: 20, swing: 20 }
	const corpus = { 2025: await season(2025), 2026: await season(2026) }

	console.log("\n1. THE THREE ANIMALS (2026, across-player medians)")
	console.log("   cohort   players  days  mean median   p25   p75   p90    sd  sd/mean")
	for (const c of ["hitters", "SP", "RP", "swing"]) {
		const g = corpus[2026].filter(r => r.cohort === c && r.n >= MIN[c])
		const m = k => q(g.map(r => r[k]).sort((a, b) => a - b), 0.5)
		console.log(`   ${c.padEnd(8)} ${String(g.length).padStart(6)} ${m("n").toFixed(0).padStart(5)} ` +
			[m("mean"), m("med"), m("p25"), m("p75"), m("p90"), m("sd"), m("sd") / m("mean")]
				.map(v => v.toFixed(2).padStart(6)).join(""))
	}

	console.log("\n2. LEVEL_FIT — sd on mean, one row per player, pooled over both seasons")
	for (const c of ["hitters", "SP", "RP"]) {
		const g = [...corpus[2025], ...corpus[2026]].filter(r => r.cohort === c && r.n >= MIN[c])
		const f = fit(g.map(r => r.sd), g.map(r => r.mean))
		console.log(`   ${c.padEnd(8)} n ${String(g.length).padStart(5)}  sd ≈ ${f.a.toFixed(3)} + ` +
			`${f.b.toFixed(3)} × mean   R² ${f.r2.toFixed(3)}   rmse ${f.rmse.toFixed(2)}` +
			`   [module: ${LEVEL_FIT[c].intercept} + ${LEVEL_FIT[c].slope}, R² ${LEVEL_FIT[c].r2}]`)
	}

	console.log("\n3. RELIABILITY_K — alternating-day split halves, level removed from each half")
	for (const c of ["hitters", "SP", "RP"]) {
		const ks = []
		for (const year of [2025, 2026]) {
			const g = corpus[year].filter(r => r.cohort === c && r.n >= (c === "SP" ? 16 : 30))
			const A = g.map(r => r.pts.filter((_, i) => i % 2 === 0))
			const B = g.map(r => r.pts.filter((_, i) => i % 2 === 1))
			const rHalf = corr(resid(A.map(sd), A.map(mean)), resid(B.map(sd), B.map(mean)))
			const nHalf = q(A.map(a => a.length).sort((x, y) => x - y), 0.5)
			const full = 2 * rHalf / (1 + rHalf)
			const k = nHalf * 2 * (1 - full) / full
			ks.push(k)
			console.log(`   ${c.padEnd(8)} ${year}: half-to-half r ${rHalf.toFixed(3)} at ${nHalf} per half` +
				` → full-sample reliability ${full.toFixed(3)} → k ${k.toFixed(0)}`)
		}
		console.log(`   ${c.padEnd(8)} k averaged over the two seasons: ${mean(ks).toFixed(0)}` +
			`   [module: ${RELIABILITY_K[c]}]`)
	}

	console.log("\n4. SAMPLING_ERROR — 200 bootstrap resamples of each player's own games")
	let seed = 7
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
	for (const c of ["hitters", "SP", "RP"]) {
		const cs = []
		for (const year of [2025, 2026])
			for (const r of corpus[year].filter(x => x.cohort === c && x.n >= MIN[c])) {
				const boots = []
				for (let i = 0; i < 200; i++)
					boots.push(sd(Array.from({ length: r.n }, () => r.pts[Math.floor(rnd() * r.n)])))
				cs.push(sd(boots) * Math.sqrt(r.n) / r.sd)
			}
		cs.sort((a, b) => a - b)
		console.log(`   ${c.padEnd(8)} c median ${q(cs, 0.5).toFixed(3)} (quartiles ` +
			`${q(cs, 0.25).toFixed(3)}–${q(cs, 0.75).toFixed(3)}, ${cs.length} player-seasons)` +
			`   [module: ${SAMPLING_ERROR[c]}; Gaussian would be 0.707]`)
	}

	// The null result, which is the most important output here: shuffle the days
	// between players at the same level and see whether the real spread of p90s is
	// any wider than chance. Seeded, so the p-values reproduce exactly.
	// The null, and the most important thing this harness prints. Take the players at
	// one projected level, pool their days, deal them back out at random keeping each
	// man's game count, and ask whether the real between-player dispersion of a spread
	// statistic is any wider than a shuffle produces. Seeded, so the p-values below
	// reproduce to the digit; another seed moves them by about ±0.02.
	console.log("\n5. THE NULL — 4,000 shuffles per band, players kept at their own game counts")
	console.log("   band               players     p90: obs  chance     p       sd: obs  chance     p")
	for (const [c, lo, hi] of [["SP", 15, 18], ["SP", 10, 13], ["SP", 20, 24],
		["hitters", 5, 6.5], ["hitters", 7, 9], ["RP", 3.5, 4.5], ["RP", 5, 7]]) {
		const band = corpus[2026].filter(r => r.cohort === c && r.n >= MIN[c] && r.mean >= lo && r.mean < hi)
		const pool = band.flatMap(r => r.pts)
		// r.p90 and not q(r.pts, …): `pts` is chronological, and a quantile of an
		// unsorted series is a number with no meaning at all
		const obs = { p90: sd(band.map(r => r.p90)), sd: sd(band.map(r => r.sd)) }
		const ge = { p90: 0, sd: 0 }
		const nulls = { p90: [], sd: [] }
		seed = 20260917
		for (let it = 0; it < 4000; it++) {
			const deck = pool.slice()
			for (let i = deck.length - 1; i > 0; i--) {
				const j = Math.floor(rnd() * (i + 1))
				;[deck[i], deck[j]] = [deck[j], deck[i]]
			}
			let at = 0
			const dealt = band.map(r => {
				const s = deck.slice(at, at + r.n).sort((a, b) => a - b)
				at += r.n
				return s
			})
			for (const stat of ["p90", "sd"]) {
				const d = sd(dealt.map(s => stat === "p90" ? q(s, 0.9) : sd(s)))
				nulls[stat].push(d)
				if (d >= obs[stat]) ge[stat]++
			}
		}
		const cell = stat => {
			nulls[stat].sort((a, b) => a - b)
			return `${obs[stat].toFixed(2).padStart(9)} ${q(nulls[stat], 0.5).toFixed(2).padStart(7)} ` +
				`${((ge[stat] + 1) / 4001).toFixed(3).padStart(6)}`
		}
		console.log(`   ${`${c} ${lo}–${hi}`.padEnd(18)} ${String(band.length).padStart(5)}  ${cell("p90")}  ${cell("sd")}`)
	}
	console.log("\n   The p90 columns are the null result this module is built around: not one")
	console.log("   band beats chance, which is why no function in spread.ts compares two p90s.")
	console.log("   The sd columns are the weak signal it does admit — over chance in six of")
	console.log("   the seven bands, and never by much.")
}

process.exit(fail === 0 ? 0 : 1)
