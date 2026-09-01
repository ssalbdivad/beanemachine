// Round 16: brim = a genuine half-ellipse (SVG arc, not a hand-rolled polygon), and
// an NY where the N and the Y are BOTH fully drawn and overlap — the previous low-res
// attempt merged the Y's right arm into the N's stem, which deleted the Y.
//
// Real insignia is 341x499 -> 0.68 aspect. A full N (0..30) plus a full Y whose right
// arm reaches x=48 gives 48/72 = 0.67. Same proportion, far fewer nodes.
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

/* ---------- interlocking NY: both letters complete, overlapping ---------- */
// N occupies 0..nW. The Y's left arm starts INSIDE the N (yl < nW) so the strokes
// genuinely cross; its right arm reaches past the N's right edge.
const NY = ({ sw = 9, nW = 30, nH = 60, yl = 18, yr = 48, cx = 33, cy = 32, tail = 72 } = {}) => `
  <g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M0 ${nH} L0 0 L${nW} ${nH} L${nW} 0"/>
    <path d="M${yl} 0 L${cx} ${cy} L${yr} 0"/>
    <path d="M${cx} ${cy} V${tail}"/>
  </g>`
const nyBounds = o => ({ w: (o.yr ?? 48) + (o.sw ?? 9), h: (o.tail ?? 72) + (o.sw ?? 9) })
const placeNY = (px, py, h, o = {}) => {
  const b = nyBounds(o), s = h / b.h, sw = o.sw ?? 9
  return `<g transform="translate(${(px - (b.w * s) / 2 + (sw / 2) * s).toFixed(2)} ${(py - h / 2 + (sw / 2) * s).toFixed(2)}) scale(${s.toFixed(4)})">${NY(o)}</g>`
}
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }
const realNY = (px, py, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(px - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(py - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

const CX = 40, HL = 10, HR = 70, HT = 20, BASE = 31, K = -14
const HB = 71, EY = 45, LR = 11, SMILE_Y = 61
const apex = (BASE * 2 + 6 * K) / 8
const NY_Y = (apex + BASE) / 2 + 0.5

/* ---------- brim: the lower half of an ellipse ---------- */
// centred at (bx, BASE) with radii rx/ry; sweep 1 draws the underside.
const halfEllipse = (bx, rx, ry) =>
  `M${bx - rx} ${BASE} A ${rx} ${ry} 0 0 1 ${bx + rx} ${BASE} Z`
const cap = (brim, nyH = 17, o = {}) => `
  <path d="${brim}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
  <path d="M6 ${BASE} C 6 ${K}, 74 ${K}, 74 ${BASE} Z" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
  ${placeNY(CX, NY_Y, nyH, o)}`

const face = () => `
  ${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
  ${P(`M${27 - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${53 + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(27, EY, LR, 3.8, LENS, ACC)}${ci(53, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${27 + LR} ${EY - 1} h${53 - 27 - 2 * LR}`, 3.4, ACC)}
  ${dot(27, EY + 1, 3.8)}${dot(53, EY + 1, 3.8)}
  ${P(`M${27 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${53 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${CX - 7} ${SMILE_Y} q7 5 14 0`, 3.4, INK)}`
const bot = (brim, nyH, o) => `${face()}${cap(brim, nyH, o)}`

/* brim geometry sweep */
add("ell-right", bot(halfEllipse(62, 42, 8), 17), "half-ellipse centred right of the crown")
add("ell-centre", bot(halfEllipse(40, 44, 8), 17), "centred under the crown (front-facing)")
add("ell-wide", bot(halfEllipse(62, 48, 8), 17), "wider")
add("ell-deep", bot(halfEllipse(62, 42, 11), 17), "deeper")
add("ell-shallow", bot(halfEllipse(62, 42, 6), 17), "shallower")
add("ell-far", bot(halfEllipse(70, 40, 8), 17), "pushed further right")

/* the interlock */
for (const [i, o] of [{ yl: 22, yr: 52, cx: 37 }, { yl: 18, yr: 48, cx: 33 }, { yl: 13, yr: 43, cx: 28 }].entries())
  add(`lock-${["light", "medium", "heavy"][i]}`, bot(halfEllipse(62, 42, 8), 17, o), `overlap ${["light", "medium", "heavy"][i]}`)
for (const sw of [7, 11])
  add(`lock-sw${sw}`, bot(halfEllipse(62, 42, 8), 17, { sw }), `stroke ${sw}`)

/* isolated comparison */
add("cmp-real", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${realNY(40, 40, 62)}`, "original, isolated")
add("cmp-mine", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${placeNY(40, 40, 62)}`, "interlocked low-res, isolated")
add("cmp-heavy", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${placeNY(40, 40, 62, { yl: 13, yr: 43, cx: 28 })}`, "heavy overlap, isolated")

const isTile = n => n.startsWith("cmp")
const cell = ({ n, body, note }) => {
  const vb = isTile(n) ? "0 0 80 80" : "0 -6 110 82"
  const [w, h] = isTile(n) ? [130, 130] : [180, 134]
  return `<figure>
    <svg viewBox="${vb}" width="${w}" height="${h}">${body}</svg>
    <div class="small">
      <svg viewBox="${vb}" width="44" height="${isTile(n) ? 44 : 33}">${body}</svg>
      <svg viewBox="${vb}" width="26" height="${isTile(n) ? 26 : 19}">${body}</svg>
      <svg viewBox="${vb}" width="18" height="${isTile(n) ? 18 : 13}">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`
}
writeFileSync("logo/sheet16.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates16.json", JSON.stringify(c, null, 1))
console.log(`round 16: ${c.length} variants`)
