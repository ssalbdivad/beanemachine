// Verifies the GitHub Pages build: no backend, config loaded as an asset,
// editing still works, saving downloads, importing explains itself.
import { chromium } from "playwright-core"
const BASE = process.env.STATIC_BASE ?? "http://127.0.0.1:4173/beanemachine/"
const b = await chromium.launch({ args: ["--no-sandbox"] })
const p = await b.newPage({ viewport:{width:1280,height:1000} })
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
const codes = await p.$$eval(".grid section:nth-of-type(1) .code", n=>n.map(e=>e.textContent))
const vals = await p.$$eval(".grid section:nth-of-type(1) input.val", n=>n.map(e=>e.value))
t("scoring loaded from committed asset", vals[codes.indexOf("HR")]==="10.4", vals.join(","))
t("roster totals render", (await p.$$eval(".tot b", n=>n.map(e=>e.textContent))).join("/")==="18/5/4/27")
t("save button offers a download",
  (await p.locator(".savebar button.primary").textContent()).includes("Download"))
const hr = p.locator(".grid section:nth-of-type(1) input.val").nth(codes.indexOf("HR"))
await hr.fill("9.9"); await hr.blur(); await p.waitForTimeout(250)
t("editing works with no server", await p.locator(".savebar").evaluate(e=>e.classList.contains("on")))
await p.fill('input[type=text]', "https://baseball.fantasysports.yahoo.com/b1/228947/8")
await p.click(".bar button.primary")
await p.waitForSelector(".toast", { timeout: 10000 })
const msg = await p.locator(".toast").textContent()
t("import explains it needs the server", /static build|local server/i.test(msg), msg)
await b.close()
console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail?1:0)
