// Round 11: use the real insignia path rather than imitating it, and test the "010" face.
//
// On the NY: hand-rebuilding it produced slab-serif letterforms that read as a
// different typeface entirely. The real mark has bulbous ball-serifs and woven,
// curved strokes. A cap is a real object in this illustration, so wearing the real
// embroidered mark is more coherent than a near-miss redraw.
//
// On "010": the lenses only read as zeros when they're empty rings, and the bar only
// reads as a one when it spans the lens height — which displaces the bridge. So the
// gag costs pupils and bridge. Variants below isolate exactly that trade.
import { readFileSync, writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"
const REF = JSON.parse(readFileSync("logo/reference-ny.json", "utf8"))
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const F = (d, fill, stroke = INK, w = 3.4) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`
const rr = (x, y, w, h, r, sw = 3.8, fill = "none", col = INK) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw = 3.8, fill = "none", col = INK) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`

// real insignia bbox inside its 575 box, measured: x 116.9 y 37.5 w 341.1 h 500
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const realNY = (cx, cy, h) => {
  const s = h / NY_BB.h
  const tx = cx - s * (NY_BB.x + NY_BB.w / 2)
  const ty = cy - s * (NY_BB.y + NY_BB.h / 2)
  return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

const CX = 40, HL = 10, HR = 70, HT = 20, HB = 68, CAP_BASE = 31
const EY = 46, LR = 12, LX = 27, RX = 53
const apex = k => (CAP_BASE * 2 + 6 * k) / 8
const head = () => rr(HL, HT, HR - HL, HB - HT, 15)
const smile = (y = 59, w = 7) => P(`M${CX - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)
const crown = k => `M6 ${CAP_BASE} C 6 ${k}, 74 ${k}, 74 ${CAP_BASE} Z`
const brim = "M69 26 C 92 25, 110 31, 104 39.5 C 89 43.5, 72 37.5, 63 32.5 Z"
const cap = (k, nyH) => `${F(crown(k), BLUE)}${F(brim, BLUE)}${realNY(CX, (apex(k) + CAP_BASE) / 2 + 1, nyH)}`

// nose: null | "short" (below the bridge) | "tall" (spans the lenses, replaces bridge) | "one" (with a flag)
const specs = ({ nose = null, pupils = "full", bridge = true } = {}) => {
  const pr = pupils === "full" ? 4 : pupils === "small" ? 2.6 : 0
  const py = pupils === "small" ? EY - 2 : EY + 1
  const noseD =
    nose === "short" ? P(`M${CX} ${EY + 1} V${EY + 8}`, 3.4, INK)
    : nose === "tall" ? P(`M${CX} ${EY - 10} V${EY + 10}`, 4, INK)
    : nose === "one" ? P(`M${CX - 3.4} ${EY - 6.5} L${CX} ${EY - 10} V${EY + 10}`, 4, INK)
    : ""
  return `
  ${P(`M${LX - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${RX + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(LX, EY, LR, 3.8, LENS, ACC)}${ci(RX, EY, LR, 3.8, LENS, ACC)}
  ${bridge ? P(`M${LX + LR} ${EY - 1} h${RX - LX - 2 * LR}`, 3.4, ACC) : ""}
  ${pr ? dot(LX, py, pr) + dot(RX, py, pr) : ""}
  ${glint(LX, EY, LR)}${glint(RX, EY, LR)}
  ${noseD}`
}
const bot = (o = {}, k = -14, nyH = 23) => `${head()}${specs(o)}${smile(o.nose ? 61 : 59)}${cap(k, nyH)}`

/* A. the real insignia, sized on the cap */
for (const [k, h] of [[-10, 20], [-14, 23], [-18, 26]])
  add(`real-ny-${h}`, bot({}, k, h), `real insignia · NY ${h} tall · apex ${apex(k).toFixed(1)}`)

/* B. the 010 question */
add("010-none", bot({}), "baseline: no nose (current)")
add("010-short", bot({ nose: "short" }), "short nose under the bridge — cute, barely reads as 1")
add("010-tall-pupils", bot({ nose: "tall", bridge: false }), "tall bar, pupils kept — 0s fight the eyes")
add("010-tall-nopupils", bot({ nose: "tall", pupils: "none", bridge: false }), "tall bar, NO pupils — strongest 010, coldest face")
add("010-tall-smallpupils", bot({ nose: "tall", pupils: "small", bridge: false }), "tall bar, small high pupils — the compromise")
add("010-one-nopupils", bot({ nose: "one", pupils: "none", bridge: false }), "bar with a 1's flag, no pupils")
add("010-one-smallpupils", bot({ nose: "one", pupils: "small", bridge: false }), "1 with flag + small pupils")
add("010-tall-keepbridge", bot({ nose: "tall", pupils: "small" }), "bar AND bridge — clutter check")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 112 80" width="176" height="126">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 112 80" width="46" height="33">${body}</svg>
      <svg viewBox="0 0 112 80" width="28" height="20">${body}</svg>
      <svg viewBox="0 0 112 80" width="19" height="14">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet11.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff;--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:10px 4px}
.small{display:flex;align-items:center;gap:10px}
figcaption{font-size:10px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:9px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates11.json", JSON.stringify(c, null, 1))
console.log(`round 11: ${c.length} variants`)
