/**
 * ONE RECORD PER PLATFORM, AND IT HAS TO AGREE WITH THE CODE IT REPLACES.
 *
 * `src/data/platforms.ts` moves four facts about Yahoo — which hosts are its, what a URL is,
 * where the ids sit, which pages one press should fetch — out of the reader and into a
 * descriptor, so that a second platform is a record rather than a second copy of the reader.
 *
 * A refactor like that is only safe if it is provably the same answer, so the first half of
 * this file asserts the descriptor against `src/data/extension.ts`'s own functions on a table
 * of URLs, including every shape that has ever been got wrong here: a settings page read as a
 * team, a season number read as a league, a rival's roster read as the reader's own.
 *
 * The second half is about the descriptor itself — what one press asks for, what the sweep
 * builds, and the one platform that is in this file in order to be refused.
 */
import {
	YAHOO,
	SLEEPER,
	PLATFORMS,
	platformOf,
	readerMatches
} from "../src/data/platforms.ts"
import { pageKind, leagueIdFrom, teamIdFrom, sportFrom } from "../src/data/extension.ts"

let pass = 0,
	fail = 0
const t = (n, ok, x = "") => {
	ok ? pass++ : fail++
	console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`)
}

/* ── the descriptor says what the reader said ──────────────────────────────────────────
   Every URL shape this project has actually read, plus the three it has been wrong about. */
const URLS = [
	"https://baseball.fantasysports.yahoo.com/b1/228947",
	"https://baseball.fantasysports.yahoo.com/b1/228947/8",
	"https://baseball.fantasysports.yahoo.com/b1/228947/settings",
	"https://baseball.fantasysports.yahoo.com/b1/228947/players?status=A&pos=SP&count=0",
	"https://baseball.fantasysports.yahoo.com/b1/228947/matchup?week=24",
	"https://baseball.fantasysports.yahoo.com/b1/228947/positioneligibility",
	"https://baseball.fantasysports.yahoo.com/b1/228947/draftresults",
	"https://football.fantasysports.yahoo.com/f1/112233/4",
	"https://baseball.fantasysports.yahoo.com/2024/b1/228947",
	"https://beanemachine.com/",
	"not a url at all"
]

for (const url of URLS) {
	const at = YAHOO.at(url)
	t(`the descriptor and the reader call ${url.slice(0, 58)} the same page`,
		at.kind === pageKind(url), `${at.kind} vs ${pageKind(url)}`)
	t(`…and find the same league in it`,
		at.leagueId === leagueIdFrom(url) || (!YAHOO.owns(url) && at.leagueId === null),
		`${at.leagueId} vs ${leagueIdFrom(url)}`)
	t(`…and the same team`,
		at.teamId === teamIdFrom(url) || (!YAHOO.owns(url) && at.teamId === null),
		`${at.teamId} vs ${teamIdFrom(url)}`)
	t(`…and the same sport`,
		at.sport === sportFrom(url) || (!YAHOO.owns(url) && at.sport === null),
		`${at.sport} vs ${sportFrom(url)}`)
}

/* The three that have been got wrong, asserted by name rather than only by agreement — if
   both sides regress together the agreement above still passes. */
t("a settings page is not a team page",
	YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/settings").kind === "settings")
t("a rival's roster carries his team id, which is what makes it refusable",
	YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/9").teamId === "9")
t("a season in the path is not the league",
	YAHOO.at("https://baseball.fantasysports.yahoo.com/2024/b1/228947").leagueId === "228947")
t("and a football league is still a football league",
	YAHOO.at("https://football.fantasysports.yahoo.com/f1/112233/4").sport === "football")

/* ── what one press asks for ───────────────────────────────────────────────────────────── */
{
	const onTeam = YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/8")
	const want = YAHOO.onePress(onTeam)
	/* WAS "the settings and the matchup". The eligibility page is the third, and it moved
	   because `League.eligibility` was null for every league any browser has ever read: the
	   thresholds live on `/positioneligibility` alone, the Node importer has read them off it
	   for as long as it has existed, and no press ever asked for it. */
	t("standing on his team, one press asks for the settings, the eligibility and the matchup",
		want.map(f => f.kind).sort().join(",") === "eligibility,matchup,settings",
		JSON.stringify(want.map(f => f.kind)))
	t("and never for the page he is already standing on",
		!want.some(f => f.kind === onTeam.kind), JSON.stringify(want.map(f => f.url)))
	t("as text, because the paste parsers take what a reader would have copied",
		want.every(f => f.as === "text"), JSON.stringify(want.map(f => f.as)))
	t("and every URL is his own league's",
		want.every(f => f.url.includes("/b1/228947/")), JSON.stringify(want.map(f => f.url)))

	const onSettings = YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/settings")
	const fromSettings = YAHOO.onePress(onSettings)
	t("standing on the settings page, it asks for the rest and not for settings again",
		fromSettings.map(f => f.kind).join(",") === "eligibility,matchup",
		JSON.stringify(fromSettings.map(f => f.kind)))

	t("a page with no league in it asks for nothing at all",
		YAHOO.onePress(YAHOO.at("https://beanemachine.com/")).length === 0)

	/*
	   ONE PRESS BRINGS BACK HIS TEAM FROM ANYWHERE IN HIS LEAGUE.

	   Measured on this descriptor before the change, on every URL shape Yahoo serves: not one
	   of them asked for a team page. `at.teamId` is non-null only on `/b1/<league>/<team>`,
	   and the same condition then excluded that page for being the one he was standing on, so
	   the two halves cancelled and the roster — the page the whole board is built out of —
	   was never among the pages one press fetched. A reader pressing from the players page,
	   which is where a manager spends his week, got his scoring and his matchup and no team.
	*/
	for (const [where, url] of [
		["the players page", "https://baseball.fantasysports.yahoo.com/b1/228947/players?status=A&pos=SP&count=0"],
		["the league home", "https://baseball.fantasysports.yahoo.com/b1/228947"],
		["the settings page", "https://baseball.fantasysports.yahoo.com/b1/228947/settings"],
		["a rival's roster", "https://baseball.fantasysports.yahoo.com/b1/228947/9"]
	]) {
		const plan = YAHOO.onePress(YAHOO.at(url), { teamId: "8" })
		t(`standing on ${where}, one press fetches his own team`,
			plan[0]?.kind === "team" && plan[0]?.url.endsWith("/b1/228947/8"),
			JSON.stringify(plan.map(f => f.url)))
	}
	/* And on his OWN team page it is still not fetched, because the content script is
	   standing on it and hands it over without costing Yahoo a request. */
	t("standing on his own team, it is the one page not fetched",
		!YAHOO.onePress(YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/8"), { teamId: "8" })
			.some(f => f.kind === "team"))
	/* Nothing invented where nothing is known: a browser that has never read his team page
	   has no id to send, and a press from a page whose URL names no team asks for what it
	   can rather than guessing at a team number. */
	t("and with no team known anywhere, no team page is asked for",
		!YAHOO.onePress(YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/players?pos=C"))
			.some(f => f.kind === "team"))

	/* `as` was declared, set on every page here and read by nothing — see the note on
	   `Fetchable`. The fetcher branches on it now, so every page one press asks for has to
	   say which form it wants. */
	t("every page one press asks for says how it should cross the wire",
		YAHOO.onePress(YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947"), { teamId: "8" })
			.every(f => f.as === "text" || f.as === "html" || f.as === "json"))
}

/* ── the page the thresholds live on ───────────────────────────────────────────────────── */
t("the eligibility page is a page of its own and not a players page",
	YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/positioneligibility").kind === "eligibility",
	YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/positioneligibility").kind)
t("and it is not read as a team page either",
	pageKind("https://baseball.fantasysports.yahoo.com/b1/228947/positioneligibility") === "eligibility")

/* ── the sweep ─────────────────────────────────────────────────────────────────────────── */
{
	const POS = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP"]
	const at = YAHOO.at("https://baseball.fantasysports.yahoo.com/b1/228947/8")
	const pages = YAHOO.sweep(at, POS)
	t("the sweep is one page per position, and no more", pages.length === POS.length, String(pages.length))
	t("each asks for a different position",
		new Set(pages.map(p => new URL(p.url).searchParams.get("pos"))).size === POS.length)
	/* `count` is an OFFSET, not a page size. Asking for 25 serves rows 25-49 and hides the top
	   25 free agents at every position — a season-long bug this assertion exists to prevent
	   from returning through a descriptor. */
	t("and for the TOP of each list, because count is an offset",
		pages.every(p => new URL(p.url).searchParams.get("count") === "0"),
		JSON.stringify(pages.map(p => new URL(p.url).searchParams.get("count"))))
	t("only free agents, not every player in the league",
		pages.every(p => new URL(p.url).searchParams.get("status") === "A"))
	t("as HTML, because the player id is in an attribute and does not survive innerText",
		pages.every(p => p.as === "html"))
}

/* ── the platform that is here to be refused ───────────────────────────────────────────── */
t("Sleeper needs no reader at all, because its API answers any page",
	SLEEPER.needsReader === false)
t("so it asks for no host permission",
	SLEEPER.matches.length === 0)
t("and the manifest is written from the platforms that DO need one",
	readerMatches().length > 0 && readerMatches().every(m => !/sleeper/i.test(m)),
	readerMatches().join(" "))
/*
   HTTPS ONLY IN THE BUILD A READER INSTALLS.
   
   This list is what the content script is injected into. Yahoo answers over plaintext http
   with a 200 rather than a redirect, so `*://` — which is what this was — let the reader run
   on a page a network could have written, on the host whose cookies the same script then
   sends with every fetch it makes. The plaintext form exists for one caller: the extension
   suite, which serves a fake Yahoo over http on 127.0.0.1 and points the browser's resolver
   at it. Same bargain as `appMatches(dev)`, struck in the same place.
*/
t("a shipped reader is injected over https and nothing else",
	readerMatches().every(m => m.startsWith("https://")), readerMatches().join(" "))
t("the dev build adds the plaintext form, and adds nothing else",
	readerMatches(true).length === readerMatches().length * 2 &&
		readerMatches().every(m => readerMatches(true).includes(m)) &&
		readerMatches(true).filter(m => m.startsWith("http://")).length === readerMatches().length,
	readerMatches(true).join(" "))
t("and the two lists name the same hosts",
	new Set(readerMatches(true).map(m => m.replace(/^https?:/, ""))).size ===
		new Set(readerMatches().map(m => m.replace(/^https?:/, ""))).size)
t("every platform that needs a reader names the hosts it reads",
	PLATFORMS.filter(p => p.needsReader).every(p => p.matches.length > 0))
t("and a URL is owned by at most one of them",
	URLS.every(u => PLATFORMS.filter(p => p.owns(u)).length <= 1))
t("platformOf finds Yahoo and nothing else for a Yahoo URL",
	platformOf("https://baseball.fantasysports.yahoo.com/b1/228947")?.id === "yahoo")
t("and nothing at all for this app's own page",
	platformOf("https://beanemachine.com/") === null)

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
