import { chromium } from "playwright-core"
const b = await chromium.launch({args:["--no-sandbox"]})
const p = await b.newPage({ viewport:{width:1280,height:1100} })
const errs=[]; p.on("pageerror",e=>errs.push(e.message.slice(0,120)))
await p.goto(process.env.BASE, { waitUntil:"networkidle" })
await p.waitForSelector(".decide",{timeout:30000})
// the exact path the card now sends a visitor down
await p.click(".decide-cta"); await p.waitForTimeout(1500)
console.log("=== WHERE THE BUTTON LANDS ===")
console.log((await p.$eval("main, body", e=>e.innerText)).slice(0,900))
console.log("\nsearch box present:", !!(await p.$("[data-ctl=own-search]")))
await b.close()
