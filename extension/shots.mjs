/**
 * THE LISTING'S SCREENSHOTS, TAKEN FROM THE RUNNING SITE.
 *
 * A store wants at least one 1280x800 image and it is the first thing anybody looks at. Mocking
 * them would mean a listing that shows something the site does not do — the exact failure this
 * project spends its comments preventing — so these are captures of the published build.
 *
 * A real team is seeded from the committed capture first, because the published seed carries no
 * league (deliberately: see the note in vite.config.ts) and an empty shell shows nothing about
 * what the add-on is for. The seed is written into the BROWSER, never into the repository.
 *
 * Wants the preview running: `npm run build && npm run preview`, which serves dist on 4173.
 */
import { chromium } from "playwright-core"
import { readFileSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const BASE = process.env.BASE ?? "http://127.0.0.1:4173"
const out = resolve(root, "dist-ext", "store")
mkdirSync(out, { recursive: true })

const cfg = JSON.parse(readFileSync(resolve(root, "scoring.json"), "utf8"))
const snap = JSON.parse(readFileSync(resolve(root, "data/snapshot.json"), "utf8"))

/** Ten men anybody would recognise, so the screens read as a real team at a glance. */
const WANT = [
	"Aaron Judge", "Cal Raleigh", "Ben Rice", "Ketel Marte", "Bobby Witt Jr.",
	"Kyle Tucker", "Corbin Carroll", "Tarik Skubal", "Paul Skenes", "Emmanuel Clase"
]
const roster = []
for (const p of snap.players ?? [])
	if (WANT.includes(p.name))
		roster.push(`${p.id}:${p.group ?? (p.position === "P" ? "pitching" : "hitting")}`)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(([c, team]) => {
	localStorage.setItem("beanemachine:config", JSON.stringify(c))
	if (team.length) localStorage.setItem("beanemachine:roster", JSON.stringify({ "yahoo:228947": team }))
}, [cfg, roster])

await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.waitForSelector("nav button", { timeout: 30000 })
await page.waitForTimeout(3500)
await page.screenshot({ path: resolve(out, "1-tonight.png") })

await page.click("nav button:nth-child(2)")
await page.waitForSelector(".board-row", { timeout: 20000 })
await page.waitForTimeout(1500)
await page.screenshot({ path: resolve(out, "2-pickups.png") })

await page.click("nav button:nth-child(3)")
await page.waitForTimeout(2000)
await page.screenshot({ path: resolve(out, "3-my-league.png") })

/**
 * THE FOURTH SHOT IS THE WALKTHROUGH, AND IT IS ONLY UPLOADABLE HALF THE TIME.
 *
 * `IN_STORE` in src/client/Connect.tsx is `false` while no listing exists, and the sheet then
 * renders the sideload route: "turn on Developer mode", "press Load unpacked", "choose the
 * folder from step 1". That is the correct screen for the reader the site is serving today
 * and it is a screenshot the Chrome Web Store will not accept on a listing — a listing may not
 * instruct a reader to install from outside the Web Store, and this one would do it in four
 * numbered steps with an arrow pointing at the button.
 *
 * So the shot is taken, read, and written only if it is the store walkthrough. It is not
 * hardcoded off `IN_STORE`: that constant is compiled into the bundle this script is
 * photographing, so reading the rendered WORDS is the only check that cannot go stale against
 * a flag somebody flipped. When it is the sideload screen, nothing is written and the run says
 * so — which is the loud absence, in the place where a silent one would put an unusable image
 * in front of a reviewer.
 */
await page.click(".connect-offer button")
await page.waitForSelector(".dock-sheet .connect", { timeout: 15000 })
await page.waitForTimeout(800)
const walkthrough = (await page.textContent(".dock-sheet .connect")) ?? ""
const sideload = /Developer mode|Load unpacked|Load Temporary Add-on/i.exec(walkthrough)
if (sideload)
	console.log(
		`NOT written: 4-walkthrough.png. The sheet is showing the sideload route ` +
			`("${sideload[0]}"), which a Chrome Web Store listing may not contain. Flip IN_STORE ` +
			`in src/client/Connect.tsx once a listing exists and run this again for the fourth shot.`
	)
else await page.screenshot({ path: resolve(out, "4-walkthrough.png") })

console.log(`${roster.length} men seeded; wrote ${readdirSync(out).join(", ")} to dist-ext/store`)
await browser.close()
