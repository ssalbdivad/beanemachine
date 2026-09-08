import { chromium } from "playwright-core"
const b = await chromium.launch({args:["--no-sandbox"]})
const p = await b.newPage({ viewport:{width:1100,height:1400} })
p.on("dialog", async d=>{ await d.accept() })
await p.goto(process.env.BASE, { waitUntil:"networkidle" })
await p.waitForSelector(".decide",{timeout:30000})
const link = await p.$("text=Use my league instead"); if (link){ await link.click(); await p.waitForTimeout(700) }
await p.waitForSelector("input[type=file]",{state:"attached",timeout:20000})
await p.setInputFiles('input[type=file]', process.env.FILE)
await p.waitForTimeout(2500)
const back = await p.$("text=RECOMMENDATIONS"); if (back){ await back.click(); await p.waitForTimeout(3000) }
console.log(await p.$eval(".decide", e=>e.innerText))
await b.close()
