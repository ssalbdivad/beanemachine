// Round 19: official insignia restored, and the brim rebuilt as described —
// a full half-ellipse, upside down relative to the crown's dome, meeting the hat
// at the single point where the dome's outline ends (74, BASE). No tucking under,
// no overlap: the crown bulges up, the brim bulges down, they touch at one point.
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
const HB = 71, EY = 45, LR = 11, SMILE_Y = 61
const CROWN_R = 74                       // where the dome's outline meets the base
const apex = (BASE * 2 + 6 * K) / 8
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const realNY = (px, py, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(px - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(py - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

// upside-down half-ellipse springing from the dome's end point
const brimPath = (rx, ry, from = CROWN_R) =>
  `M${from} ${BASE} A ${rx} ${ry} 0 0 1 ${from + 2 * rx} ${BASE} Z`
const crownPath = `M6 ${BASE} C 6 ${K}, 74 ${K}, ${CROWN_R} ${BASE} Z`
const cap = (rx, ry, nyH = 18, from = CROWN_R) => `
  <path d="${brimPath(rx, ry, from)}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
  <path d="${crownPath}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
  ${realNY(CX, (apex + BASE) / 2 + 0.5, nyH)}`
const face = () => `
  ${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
  ${P(`M${27 - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${53 + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(27, EY, LR, 3.8, LENS, ACC)}${ci(53, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${27 + LR} ${EY - 1} h${53 - 27 - 2 * LR}`, 3.4, ACC)}
  ${dot(27, EY + 1, 3.8)}${dot(53, EY + 1, 3.8)}
  ${P(`M${27 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${53 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${CX - 7} ${SMILE_Y} q7 5 14 0`, 3.4, INK)}`
const bot = (rx, ry, nyH = 18, from) => `${face()}${cap(rx, ry, nyH, from)}`

/* brim length */
for (const rx of [13, 16, 19, 22])
  add(`rx-${rx}`, bot(rx, 7.5), `half-ellipse, rx ${rx} (reaches x=${74 + 2 * rx})`)
/* brim depth */
for (const ry of [5, 7.5, 10])
  add(`ry-${ry}`, bot(16, ry), `depth ry ${ry}`)
/* where it springs from */
for (const from of [70, 72])
  add(`from-${from}`, bot(16, 7.5, 18, from), `springs from x=${from} instead of the dome's end`)
/* insignia size */
for (const h of [16, 20, 22])
  add(`ny-${h}`, bot(16, 7.5, h), `insignia ${h} tall`)

const cell = ({ n, body, note }) => `<figure>
    <svg viewBox="0 -6 116 82" width="184" height="130">${body}</svg>
    <div class="small">
      <svg viewBox="0 -6 116 82" width="48" height="34">${body}</svg>
      <svg viewBox="0 -6 116 82" width="28" height="20">${body}</svg>
      <svg viewBox="0 -6 116 82" width="19" height="13">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`
writeFileSync("logo/sheet19.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff;--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:5px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:10px 4px}
.small{display:flex;align-items:center;gap:10px}
figcaption{font-size:10px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:9px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates19.json", JSON.stringify(c, null, 1))
console.log(`round 19: ${c.length} variants · official insignia · half-ellipse brim from (${CROWN_R}, ${BASE})`)
