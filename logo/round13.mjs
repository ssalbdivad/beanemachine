// Round 13: geometric brim (straight edges, clean vertices) + fix the smile/lens collision.
//
// Collision was real: lens bottom sat at 46+12+1.9 = 59.9 and the smile started at 59.
// Fixed by lifting the eyeline, trimming the lens radius, dropping the smile and
// lengthening the head — so there's clear air between the specs and the mouth.
import { readFileSync, writeFileSync } from "node:fs"
const REF = JSON.parse(readFileSync("logo/reference-ny.json", "utf8"))
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const rr = (x, y, w, h, r, sw, fill, col) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw, fill, col) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`

const CX = 40, HL = 10, HR = 70, HT = 20, BASE = 31, K = -14
// re-laid-out face: cap base 31 · lens 34..56 · smile 61..65 · head bottom 71
const HB = 71, EY = 45, LR = 11, SMILE_Y = 61
const apex = (BASE * 2 + 6 * K) / 8
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const insignia = (cx, cy, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(cx - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(cy - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

// The dome ends at its bottom-right corner (74, BASE). Every brim below leaves from
// that exact vertex in a straight line, so the join is one clean corner, and returns
// to the base line at `tuck` — another clean corner. No curves, no blend.
const brims = {
  wedge:   t => `L 105 36 L ${t} ${BASE}`,                       // single point
  bevel:   t => `L 104 34 L 100.5 39.5 L ${t} ${BASE}`,          // cut tip
  square:  t => `L 104 33.5 L 104 39 L ${t} ${BASE}`,            // squared end
  chisel:  t => `L 105 35 L 103 39.5 L ${t} ${BASE}`,            // narrow cut
  slab:    t => `L 103 32.5 L 103 39.5 L ${t} ${BASE}`           // flat parallel slab
}
const capPath = (kind, tuck) => `M6 ${BASE} C 6 ${K}, 74 ${K}, 74 ${BASE} ${brims[kind](tuck)} L 6 ${BASE} Z`
const cap = (kind, tuck, join, nyH = 18) =>
  `<path d="${capPath(kind, tuck)}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="${join}" stroke-miterlimit="6" stroke-linecap="${join === "miter" ? "butt" : "round"}"/>` +
  insignia(CX, (apex + BASE) / 2 + 0.5, nyH)

const face = () => `
  ${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
  ${P(`M${27 - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${53 + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(27, EY, LR, 3.8, LENS, ACC)}${ci(53, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${27 + LR} ${EY - 1} h${53 - 27 - 2 * LR}`, 3.4, ACC)}
  ${dot(27, EY + 1, 3.8)}${dot(53, EY + 1, 3.8)}
  ${P(`M${27 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${53 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${CX - 7} ${SMILE_Y} q7 5 14 0`, 3.4, INK)}`
const bot = (kind, { tuck = 64, join = "round", ny = 18 } = {}) => `${face()}${cap(kind, tuck, join, ny)}`

for (const k of Object.keys(brims))
  add(`${k}`, bot(k), `${k} brim · round joins`)
for (const k of ["wedge", "bevel", "slab"])
  add(`${k}-miter`, bot(k, { join: "miter" }), `${k} · mitred joins (sharpest)`)
for (const t of [70, 58, 52])
  add(`bevel-tuck${t}`, bot("bevel", { tuck: t }), `bevel · rejoins base at x=${t}`)
add("bevel-ny20", bot("bevel", { ny: 20 }), "bevel · insignia 20")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="4 -6 106 82" width="182" height="141">${body}</svg>
    <div class="small">
      <svg viewBox="4 -6 106 82" width="48" height="37">${body}</svg>
      <svg viewBox="4 -6 106 82" width="28" height="22">${body}</svg>
      <svg viewBox="4 -6 106 82" width="19" height="15">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet13.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates13.json", JSON.stringify(c, null, 1))
console.log(`round 13: ${c.length} variants · lens bottom ${EY + LR + 1.9} · smile top ${SMILE_Y} · gap ${(SMILE_Y - (EY + LR + 1.9)).toFixed(1)}`)
