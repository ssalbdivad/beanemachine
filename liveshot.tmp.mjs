import { chromium } from "playwright-core"
const b = await chromium.launch({args:["--no-sandbox"]})
const p = await b.newPage({ viewport:{width:390,height:1500} })
const errs=[]; p.on("pageerror",e=>errs.push(e.message.slice(0,140)))
p.on("dialog", async d=>{ await d.accept() })
await p.goto("https://beanemachine.com", { waitUntil:"networkidle", timeout:90000 })
await p.waitForSelector(".decide",{timeout:40000})
const link = await p.$("text=Use my league instead"); if (link){ await link.click(); await p.waitForTimeout(800) }
await p.waitForSelector("input[type=file]",{state:"attached",timeout:20000})
await p.setInputFiles('input[type=file]', process.env.FILE)
await p.waitForTimeout(3000)
const back = await p.$("text=RECOMMENDATIONS"); if (back){ await back.click(); await p.waitForTimeout(4000) }
await p.locator(".decide").screenshot({ path:"/home/ssalb/beanemachine/live-phone.png" })
console.log("h-overflow:", await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))
console.log("example note:", !!(await p.$(".example-note")))
console.log("errors:", errs.length?errs.join(" | "):"none")
await b.close()
