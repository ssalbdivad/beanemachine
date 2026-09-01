// Round 12: cap as ONE path (crown + brim share an outline, so there is no seam
// where they meet), and a smaller insignia so the robot carries the mark.
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

const CX = 40, HL = 10, HR = 70, HT = 20, HB = 68, BASE = 31, K = -14
const EY = 46, LR = 12, LX = 27, RX = 53
const apex = k => (BASE * 2 + 6 * k) / 8
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const realNY = (cx, cy, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(cx - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(cy - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

// One continuous outline: left base → dome → over the brim → back under it → base.
// `tuck` is where the brim's underside rejoins the base line (further left = more
// deeply tucked under the crown, so it reads as one moulded piece).
const capPath = ({ tip = [103.5, 36], reach = 89, drop = 41.5, tuck = 66, k = K } = {}) => `
  M6 ${BASE}
  C 6 ${k}, 74 ${k}, 74 ${BASE}
  C ${reach} ${BASE - 0.5}, ${tip[0] - 1.5} ${BASE + 1}, ${tip[0]} ${tip[1]}
  C ${tip[0] - 4.5} ${drop}, ${reach - 9} ${drop - 2.5}, ${tuck} ${BASE}
  L 6 ${BASE} Z`.replace(/\s+/g, " ").trim()

const cap = (nyH, o = {}) =>
  `<path d="${capPath(o)}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>` +
  realNY(CX, (apex(o.k ?? K) + BASE) / 2 + 0.5, nyH)

const face = () => `
  ${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
  ${P(`M${LX - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${RX + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(LX, EY, LR, 3.8, LENS, ACC)}${ci(RX, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${LX + LR} ${EY - 1} h${RX - LX - 2 * LR}`, 3.4, ACC)}
  ${dot(LX, EY + 1, 4)}${dot(RX, EY + 1, 4)}
  ${P(`M${LX - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${RX - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${CX - 7} 59 q7 5.04 14 0`, 3.4, INK)}`
const bot = (nyH, o = {}) => `${face()}${cap(nyH, o)}`

/* insignia size sweep */
for (const h of [24, 20, 18, 16])
  add(`ny-${h}`, bot(h), `insignia ${h} tall${h === 24 ? " (current)" : ""}`)

/* how deeply the brim tucks under the crown */
for (const tuck of [72, 66, 58, 50])
  add(`tuck-${tuck}`, bot(18, { tuck }), `brim rejoins base at x=${tuck}`)

/* brim reach and droop */
add("brim-long", bot(18, { tip: [110, 36], reach: 93 }), "longer brim")
add("brim-short", bot(18, { tip: [96, 35], reach: 84 }), "shorter brim")
add("brim-flat", bot(18, { tip: [103.5, 33], drop: 38 }), "flatter brim")
add("brim-deep", bot(18, { tip: [103.5, 38], drop: 44 }), "deeper curve")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="4 -6 110 77" width="180" height="126">${body}</svg>
    <div class="small">
      <svg viewBox="4 -6 110 77" width="48" height="34">${body}</svg>
      <svg viewBox="4 -6 110 77" width="28" height="20">${body}</svg>
      <svg viewBox="4 -6 110 77" width="19" height="13">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet12.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates12.json", JSON.stringify(c, null, 1))
console.log(`round 12: ${c.length} variants`)
