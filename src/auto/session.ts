import { existsSync } from "node:fs"
import { chromium, type BrowserContext } from "playwright-core"

/**
 * A logged-in Yahoo session, owned by the user.
 *
 * Credentials are never handled by this code. You log in once, by hand, in a real
 * browser window; Playwright saves the resulting cookies to a local file and reuses
 * them. There is nowhere for a password to be stored, typed or logged.
 */
const STATE = "data/yahoo-session.json"

export const hasSession = (): boolean => existsSync(STATE)

/** Opens a window for you to log into Yahoo, then saves the session. */
export const login = async (): Promise<void> => {
	const browser = await chromium.launch({ headless: false })
	const context = await browser.newContext()
	const page = await context.newPage()
	await page.goto("https://login.yahoo.com/")
	console.log("A browser window is open. Log into Yahoo, then return here.")
	console.log("Waiting for you to reach a fantasy page…")
	await page.waitForURL(/fantasysports\.yahoo\.com/, { timeout: 300_000 })
	await context.storageState({ path: STATE })
	console.log(`Session saved to ${STATE}. It is gitignored; treat it like a password.`)
	await browser.close()
}

export const openSession = async (headless = true): Promise<BrowserContext> => {
	if (!hasSession()) throw new Error(`No saved session. Run: nub src/auto/run.ts --login`)
	const browser = await chromium.launch({ headless })
	return browser.newContext({ storageState: STATE })
}
