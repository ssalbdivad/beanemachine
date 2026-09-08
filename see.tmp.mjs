import { chromium } from "playwright-core"
const b = await chromium.launch({args:["--no-sandbox"]})
const p = await b.newPage({ viewport:{width:1100,height:1400} })
p.on("pageerror", e=>console.log("PAGEERROR:", e.message.slice(0,300)))
p.on("dialog", async d => { await d.accept() })
await p.goto(process.env.BASE, { waitUntil:"networkidle", timeout:60000 })
await p.waitForTimeout(800)
const link = await p.$("text=Use my league instead"); if (link) { await link.click(); await p.waitForTimeout(600) }
await p.waitForSelector("input[type=file]", { state:"attached", timeout:15000 })
await p.setInputFiles('input[type=file]', process.env.FILE)
await p.waitForTimeout(2500)
const back = await p.$("text=RECOMMENDATIONS"); if (back) { await back.click(); await p.waitForTimeout(2500) }
const d = await p.$(".decide")
console.log(d ? (await d.innerText()) : "!! no .decide on the page")
await b.close()
