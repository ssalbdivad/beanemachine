// Verifies the GitHub Pages build: no backend, leagues seeded from the committed
// asset into this browser's storage, editing and saving working exactly as they do
// with a server behind them, and importing explaining why it alone still can't.
import { chromium } from "playwright-core"
// The build's base is relative, so preview serves it at the root and the same
// artifact would work just as well under /beanemachine/ or at a custom domain's
// apex — which is the property this suite is checking on behalf of.
const BASE = process.env.STATIC_BASE ?? "http://127.0.0.1:4173/"
const b = await chromium.launch({ args: ["--no-sandbox"] })
const p = await b.newPage({ viewport:{width:1280,height:1000} })
/**
 * A hosted static build has no API behind it, and that is the whole subject of this
 * suite — so it is enforced here rather than assumed of the machine.
 *
 * It used to be assumed, and only held by accident: the build's base was
 * `/beanemachine/`, so the mode probe asked for `/beanemachine/api/health`, which
 * missed Vite's `/api` proxy prefix and fell through to the SPA handler. Once the
 * base became relative the probe asked for `/api/health`, the proxy matched, and a
 * dev API server that happened to be running on this machine answered 200 — so the
 * page came up in SERVER mode and every static-only assertion below failed. The
 * suite was measuring what else was running, not what it was built to test.
 */
await p.route("**/api/**", r => r.abort())
const errs = []
p.on("pageerror", e => errs.push(String(e)))
await p.goto(BASE, { waitUntil:"networkidle" })
// The board is the default view and must render with NO server. A synchronous
// throw in the static-mode guard once killed the whole render here.
await p.waitForSelector(".board-row", { timeout: 25000 })
let pass=0, fail=0
const t=(n,ok,x="")=>{ok?pass++:fail++; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":"  "+x}`)}
t("no page errors", errs.length===0, errs.join(" | "))
t("the board renders with no server", (await p.$$eval(".board-row", n=>n.length)) > 50)
t("free-agents toggle is disabled rather than failing",
  await p.$eval(".toggle input", e => e.disabled))
t("Billy's pick renders", await p.locator(".card.pick").isVisible())
// now switch to the config editor for the remaining assertions
await p.click(".views button:nth-child(2)")
await p.waitForSelector(".grid section.card .rows", { timeout: 15000 })
t("static banner shown", await p.locator(".static-note").isVisible())
const note = await p.locator(".static-note").textContent()
t("banner names importing as the only thing needing the server",
  /import/i.test(note) && /saving/i.test(note), note)
const codes = await p.$$eval(".grid section:nth-of-type(1) .code", n=>n.map(e=>e.textContent))
const vals = await p.$$eval(".grid section:nth-of-type(1) input.val", n=>n.map(e=>e.value))
t("scoring seeded from the committed asset", vals[codes.indexOf("HR")]==="10.4", vals.join(","))
t("the seed was stored, not just rendered",
  await p.evaluate(() => localStorage.getItem("beanemachine:config") !== null))
t("roster totals render", (await p.$$eval(".tot b", n=>n.map(e=>e.textContent))).join("/")==="18/5/4/27")
t("the config can be taken out as a file", await p.locator('.bar button:text-is("Download")').isEnabled())
const hr = p.locator(".grid section:nth-of-type(1) input.val").nth(codes.indexOf("HR"))
await hr.fill("9.9"); await hr.blur(); await p.waitForTimeout(250)
t("editing works with no server", await p.locator(".savebar").evaluate(e=>e.classList.contains("on")))

// saving is no longer the thing that needs a backend — it writes this browser
await p.click(".savebar button.primary")
await p.waitForSelector(".toast")
t("saving works with no server", (await p.locator(".toast").textContent()).includes("Saved"))
t("the save landed in browser storage", await p.evaluate(() =>
  JSON.parse(localStorage.getItem("beanemachine:config")).leagues["yahoo:228947"].scoring.batting.HR === 9.9))
await p.reload({ waitUntil:"networkidle" })
await p.click(".views button:nth-child(2)")
await p.waitForSelector(".grid section.card .rows", { timeout: 15000 })
const kept = await p.$$eval(".grid section:nth-of-type(1) input.val", n=>n.map(e=>e.value))
t("the edit survives a reload with no server", kept[codes.indexOf("HR")]==="9.9", kept.join(","))
await p.fill('input[type=text]', "https://baseball.fantasysports.yahoo.com/b1/228947/8")
await p.click(".bar button.primary")
await p.waitForSelector(".toast", { timeout: 10000 })
const msg = await p.locator(".toast").textContent()
t("import explains it needs the server", /static build|local server/i.test(msg), msg)
await b.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail?1:0)
