// The deployed API's own behaviour: who may call it, how often, and what it refuses.
//
// These are the properties that only matter once it is PUBLIC. Run on a machine it
// was a localhost convenience, and none of them had a test — the first rate limit
// written here throttled the app's own ordinary navigation and, with no address
// header, throttled every visitor together out of one shared bucket. That was found
// by test/journey.mjs failing intermittently, which is a slow and confusing way to
// discover something this file can state directly.
//
// Nothing here reaches Yahoo: every assertion is about the edge — CORS, the budget,
// input validation — and the two routes that would leave are exercised with input
// that is rejected before any fetch happens.
import app from "../src/api.ts"
import { poolIsPartial } from "../src/client/api.ts"

let pass = 0, fail = 0
const t = (n, ok, x = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`) }

/** Straight at the Hono app — no port, no process, no network. */
const call = (path, { method = "GET", body, headers = {} } = {}) =>
	app.request(path, {
		method,
		headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
		body: body ? JSON.stringify(body) : undefined
	})

// ── who may call it ─────────────────────────────────────────────────────────────
//
// The site and the API are on different origins by necessity: the site is static on
// GitHub Pages and the API cannot be, because reading Yahoo needs a server. So CORS
// is not a detail here, it is the thing that makes the deployment work at all — and
// an allow-list rather than `*`, because this endpoint reads a third party's pages
// on request and should not do that for anybody who asks.
{
	const ours = await call("/api/health", { headers: { Origin: "https://beanemachine.com" } })
	t("the site's own origin is allowed",
		ours.headers.get("access-control-allow-origin") === "https://beanemachine.com",
		String(ours.headers.get("access-control-allow-origin")))

	const theirs = await call("/api/health", { headers: { Origin: "https://evil.example" } })
	t("an unrelated origin is given no allow header at all",
		!theirs.headers.get("access-control-allow-origin"),
		String(theirs.headers.get("access-control-allow-origin")))

	const local = await call("/api/health", { headers: { Origin: "http://localhost:5173" } })
	t("a localhost port is allowed, because that is what `npx vite` serves the client on",
		local.headers.get("access-control-allow-origin") === "http://localhost:5173",
		String(local.headers.get("access-control-allow-origin")))
}

// ── the budget ──────────────────────────────────────────────────────────────────
//
// What is worth protecting is the OUTBOUND scraping, not this process. The first
// version counted every request, including the health probe, and the app's own
// navigation spent it in seconds.
{
	const probes = await Promise.all(
		Array.from({ length: 60 }, () => call("/api/health", { headers: { "x-real-ip": "1.1.1.1" } }))
	)
	t("a health probe never counts against the budget, however often it is asked",
		probes.every(r => r.status === 200),
		String(probes.filter(r => r.status !== 200).length) + " were refused")
}

{
	// a made-up address of its own, so this cannot be spent by another assertion
	const ip = "203.0.113.7"
	const codes = []
	for (let i = 0; i < 30; i++) {
		const r = await call("/api/available", {
			method: "POST",
			body: { leagueId: "not-a-number" },
			headers: { "x-real-ip": ip }
		})
		codes.push(r.status)
	}
	t("a single address is cut off once it has spent its budget",
		codes.includes(429), `saw ${[...new Set(codes)].join(", ")}`)
	t("and it is allowed a usable number of reads first, not a handful",
		codes.indexOf(429) >= 15, `refused after ${codes.indexOf(429)}`)
}

{
	/*
	 * The case that would have been an outage rather than a limit.
	 *
	 * Behind a platform proxy there is an `x-forwarded-for`. Anywhere else there is
	 * not, and bucketing every such request under one "unknown" key turns a per-user
	 * limit into a global one: twenty reads a minute for the whole site, shared, with
	 * the twenty-first visitor refused because of the first twenty.
	 */
	const codes = []
	for (let i = 0; i < 40; i++) {
		const r = await call("/api/available", { method: "POST", body: { leagueId: "not-a-number" } })
		codes.push(r.status)
	}
	t("requests with no address are not all rationed out of one small bucket",
		!codes.includes(429), `${codes.filter(c => c === 429).length} of 40 refused`)
}

// ── what it refuses before reaching anybody else's site ─────────────────────────
{
	const bad = await call("/api/available", {
		method: "POST",
		body: { leagueId: "../../etc/passwd" },
		headers: { "x-real-ip": "198.51.100.9" }
	})
	t("a league id that is not a number is refused before any fetch", bad.status === 400,
		`${bad.status} ${(await bad.text()).slice(0, 90)}`)

	const missing = await call("/api/import", {
		method: "POST",
		body: {},
		headers: { "x-real-ip": "198.51.100.10" }
	})
	t("a request with no url is refused rather than fetched", missing.status >= 400,
		String(missing.status))

	const nonsense = await call("/api/import", {
		method: "POST",
		body: { url: "https://evil.example/internal" },
		headers: { "x-real-ip": "198.51.100.11" }
	})
	const said = await nonsense.text()
	t("a URL that is not a supported league is refused by name, not fetched",
		nonsense.status === 400 && /Unrecognized league URL/.test(said),
		`${nonsense.status} ${said.slice(0, 120)}`)
}

// ── a throttled read is not a free-agent list ───────────────────────────────────
//
// Yahoo throttles by serving an EMPTY PAGE rather than an error, so a sweep that
// asked for nine positions and got one is indistinguishable, in the data, from a
// league with one position's worth of free agents. On 2026-09-09 that reached the
// page as 25 relievers under the words "25 players are actually free", the streaming
// board filtered itself to two rows, and every recommendation in the app came out of
// a ninth of the wire.
//
// An incomplete list is worse than an estimate. An estimate misjudges who is free;
// an incomplete list EXCLUDES men who are, invisibly, because the men it leaves out
// look exactly like men somebody else owns.
{
  const nine = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]
  t("one position out of nine is a throttled read, not a small league",
    poolIsPartial({ positionsRead: ["RP"], positionsRequested: nine }))
  t("and so is a third of them",
    poolIsPartial({ positionsRead: ["RP", "SP", "C"], positionsRequested: nine }))
  t("a complete sweep is used as what it is",
    !poolIsPartial({ positionsRead: nine, positionsRequested: nine }))
  t("and so is one short a position, because a league really can have no free catcher",
    !poolIsPartial({ positionsRead: nine.slice(1), positionsRequested: nine }))
  // An older carried file predates the field. "Cannot tell" is not "incomplete":
  // refusing every carried pool would throw away the exact lists this app's one
  // offline route exists to produce.
  t("a read that does not say what it asked for is not called partial",
    !poolIsPartial({ positionsRead: ["RP"] }))
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
