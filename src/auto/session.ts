import { existsSync, readFileSync } from "node:fs"
import { chromium, type BrowserContext } from "playwright-core"

/**
 * A logged-in Yahoo session, owned by the user.
 *
 * Credentials are never handled by this code. You log in once, by hand, in a real
 * browser window; Playwright saves the resulting cookies to a local file and reuses
 * them. There is nowhere for a password to be stored, typed or logged.
 */
const STATE = "data/yahoo-session.json"

/**
 * What a step against the live site could not read.
 *
 * Every remote step hands one of these back rather than throwing or quietly
 * returning nothing. "Your roster is empty" and "we could not read your roster"
 * are opposite claims, and a caller that cannot tell them apart will cheerfully
 * report standing pat while it is actually blind.
 */
export interface ReadFailure {
	/** The step that could not complete, e.g. `session` or `roster-table`. */
	step: string
	/** Exactly what could not be read, in the caller's own terms. */
	what: string
	/** The one thing that would fix it, when there is one. */
	fix: string | null
	/** Whatever the underlying error or page actually said. */
	detail?: string
}

export type Read<T> = { ok: true; value: T } | { ok: false; failure: ReadFailure }

export const unread = (
	step: string,
	what: string,
	fix: string | null,
	detail?: string
): { ok: false; failure: ReadFailure } => ({
	ok: false,
	failure: detail === undefined ? { step, what, fix } : { step, what, fix, detail }
})

export const hasSession = (): boolean => existsSync(STATE)

/** Only the part of Playwright's storage state we are willing to assert about. */
interface StoredState {
	cookies?: { name?: string; domain?: string; expires?: number }[]
}

/**
 * Reads the saved session without opening a browser.
 *
 * An expired cookie jar fails in exactly the same way as a missing selector — the
 * roster page comes back as a sign-in wall — so it is worth naming here, before a
 * browser is launched, rather than being reported as a page-shape change later.
 */
export const checkSession = (): Read<{ cookies: number; expires: number | null }> => {
	if (!existsSync(STATE))
		return unread("session", `no saved Yahoo session at ${STATE}`, "run: node src/auto/run.ts --login")
	let parsed: StoredState
	try {
		parsed = JSON.parse(readFileSync(STATE, "utf8"))
	} catch (e) {
		return unread("session", `${STATE} is not readable JSON`, "delete it and run --login again", String(e))
	}
	const cookies = parsed.cookies ?? []
	if (!cookies.length)
		return unread("session", `${STATE} holds no cookies`, "run --login again")
	// Playwright writes -1 for a session cookie, which has no expiry and is still
	// usable; only dated ones can be judged, and only if there are any.
	const dated = cookies.flatMap(c => (typeof c.expires === "number" && c.expires > 0 ? [c.expires] : []))
	const latest = dated.length ? Math.max(...dated) : null
	if (latest !== null && latest * 1000 < Date.now())
		return unread(
			"session",
			`every dated cookie in ${STATE} expired on ${new Date(latest * 1000).toISOString().slice(0, 10)}`,
			"run --login again"
		)
	return { ok: true, value: { cookies: cookies.length, expires: latest } }
}

/** Opens a window for you to log into Yahoo, then saves the session. */
export const login = async (): Promise<Read<string>> => {
	let browser
	try {
		browser = await chromium.launch({ headless: false })
	} catch (e) {
		return unread(
			"browser",
			"Playwright could not launch Chromium",
			"run: npx playwright install chromium",
			String(e)
		)
	}
	const context = await browser.newContext()
	const page = await context.newPage()
	await page.goto("https://login.yahoo.com/")
	console.log("A browser window is open. Log into Yahoo, then return here.")
	console.log("Waiting for you to reach a fantasy page…")
	try {
		await page.waitForURL(/fantasysports\.yahoo\.com/, { timeout: 300_000 })
	} catch {
		await browser.close()
		return unread(
			"session",
			"no fantasy page was reached within five minutes, so nothing was saved",
			"run --login again and navigate to your league once signed in"
		)
	}
	await context.storageState({ path: STATE })
	await browser.close()
	return { ok: true, value: STATE }
}

/**
 * A browser context carrying the saved cookies.
 *
 * Returns the failure rather than throwing, so the caller reports which step went
 * wrong in the same shape as every other unreadable step.
 */
export const openSession = async (
	headless = true
): Promise<Read<{ context: BrowserContext; close: () => Promise<void> }>> => {
	const saved = checkSession()
	if (!saved.ok) return saved
	let browser
	try {
		browser = await chromium.launch({ headless })
	} catch (e) {
		return unread(
			"browser",
			"Playwright could not launch Chromium, so nothing on Yahoo could be read",
			"run: npx playwright install chromium",
			String(e)
		)
	}
	try {
		const context = await browser.newContext({ storageState: STATE })
		return { ok: true, value: { context, close: () => browser.close() } }
	} catch (e) {
		await browser.close()
		return unread("session", `${STATE} was rejected as a Playwright storage state`, "run --login again", String(e))
	}
}
