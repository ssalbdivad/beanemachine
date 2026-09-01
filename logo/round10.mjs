// Round 10: rebuild the NY against measured reference proportions.
//
// Measured from the official insignia (575 box):
//   glyph 341 x 499  -> aspect 0.68 (TALL, not wide — my earlier one was 1.39)
//   stem width ~42   -> 8.4% of glyph height (mine was ~24%: three times too heavy)
//   terminals flare to ~120 (≈2.8x stem) — the flared serifs are the recognisable part
//   Y tail centred, descending well below the N's feet (N ends ~70%, tail runs to 100%)
//
// Reconstructed in a 0..68 x 0..100 box so those ratios hold, then scaled onto the cap.
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

/* ---------- NY rebuilt to the measured ratios ---------- */
// stem: stroke weight as a fraction of glyph height (reference 0.084)
// flare: how much the terminals widen (reference ~2.8x; simplified here as a cap bar)
const NYref = ({ stem = 8.4, flare = 1.0, nStems = [12, 50], yArms = [30, 64], conv = 48, tail = 100 } = {}) => {
  const [nl, nr] = nStems, [yl, yr] = yArms
  const f = stem * 1.35 * flare      // half-width of a flared terminal
  const bar = (x, y) => flare > 0 ? P(`M${x - f} ${y} H${x + f}`, stem, ORANGE) : ""
  return `
  <g>
    ${P(`M${nl} 0 V70`, stem, ORANGE)}
    ${P(`M${nl} 0 L${nr} 70`, stem, ORANGE)}
    ${P(`M${nr} 0 V70`, stem, ORANGE)}
    ${P(`M${yl} 0 L${(yl + yr) / 2} ${conv}`, stem, ORANGE)}
    ${P(`M${yr} 0 L${(yl + yr) / 2} ${conv}`, stem, ORANGE)}
    ${P(`M${(yl + yr) / 2} ${conv} V${tail}`, stem, ORANGE)}
    ${bar(nl, 0)}${bar(nr, 0)}${bar(yr, 0)}
    ${bar(nl, 70)}${bar(nr, 70)}${bar((yl + yr) / 2, tail)}
  </g>`
}
// place: h = target height in cap units, keeping the 0.68 aspect
const placeNY = (cx, cy, h, o = {}) => {
  const s = h / 100
  return `<g transform="translate(${cx - (68 * s) / 2} ${cy - h / 2}) scale(${s})">${NYref(o)}</g>`
}

/* ---------- side-by-side against the real thing ---------- */
const refTile = size =>
  `<rect x="0" y="0" width="${size}" height="${size}" fill="${BLUE}"/>` +
  `<g transform="translate(0 0) scale(${size / 575})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
const mineTile = (size, o = {}) =>
  `<rect x="0" y="0" width="${size}" height="${size}" fill="${BLUE}"/>` +
  placeNY(size / 2, size / 2, size * 0.87, o)

add("REFERENCE", refTile(120), "the official insignia, for comparison")
add("mine-default", mineTile(120), "measured ratios · flare 1.0")
add("mine-noflare", mineTile(120, { flare: 0 }), "no flared terminals")
add("mine-flare-heavy", mineTile(120, { flare: 1.5 }), "heavier flares")
add("mine-thin", mineTile(120, { stem: 6.5 }), "thinner stems")
add("mine-thick", mineTile(120, { stem: 11 }), "thicker stems (small-size legibility)")
add("mine-narrow", mineTile(120, { nStems: [14, 46], yArms: [28, 60] }), "narrower")
add("mine-widetail", mineTile(120, { conv: 42, tail: 100 }), "arms converge higher")

/* ---------- on the cap ---------- */
const CX = 40, HL = 10, HR = 70, HT = 20, HB = 68, CAP_BASE = 31
const EY = 46, LR = 12, LX = 27, RX = 53
const apex = k => (CAP_BASE * 2 + 6 * k) / 8
const head = () => rr(HL, HT, HR - HL, HB - HT, 15)
const smile = (y = 59, w = 7) => P(`M${CX - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)
const specs = () => `
  ${P(`M${LX - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${RX + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(LX, EY, LR, 3.8, LENS, ACC)}${ci(RX, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${LX + LR} ${EY - 1} h${RX - LX - 2 * LR}`, 3.4, ACC)}
  ${dot(LX, EY + 1, 4)}${dot(RX, EY + 1, 4)}
  ${glint(LX, EY, LR)}${glint(RX, EY, LR)}`
const crown = k => `M6 ${CAP_BASE} C 6 ${k}, 74 ${k}, 74 ${CAP_BASE} Z`
const brim = "M69 26 C 92 25, 110 31, 104 39.5 C 89 43.5, 72 37.5, 63 32.5 Z"
const cap = (k, nyH, o = {}) =>
  `${F(crown(k), BLUE)}${F(brim, BLUE)}${placeNY(CX, (apex(k) + CAP_BASE) / 2 + 1, nyH, o)}`
const bot = m => `${head()}${specs()}${smile()}${m}`

for (const [k, h] of [[-10, 20], [-14, 23], [-18, 26]])
  add(`cap-k${k}-ny${h}`, bot(cap(k, h)), `crown control ${k} (apex ${apex(k).toFixed(1)}) · NY ${h} tall`)
add("cap-thick", bot(cap(-14, 23, { stem: 11 })), "thicker stems for small sizes")
add("cap-noflare", bot(cap(-14, 23, { flare: 0 })), "no flares")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 ${n.includes("REFERENCE") || n.includes("mine") ? "120 120" : "112 80"}" width="${n.includes("REFERENCE") || n.includes("mine") ? 150 : 168}" height="${n.includes("REFERENCE") || n.includes("mine") ? 150 : 120}">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 ${n.includes("REFERENCE") || n.includes("mine") ? "120 120" : "112 80"}" width="40" height="${n.includes("REFERENCE") || n.includes("mine") ? 40 : 29}">${body}</svg>
      <svg viewBox="0 0 ${n.includes("REFERENCE") || n.includes("mine") ? "120 120" : "112 80"}" width="22" height="${n.includes("REFERENCE") || n.includes("mine") ? 22 : 16}">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet10.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff;--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:10px 4px}
.small{display:flex;align-items:center;gap:10px}
figcaption{font-size:10px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:9px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
console.log(`round 10: ${c.length} tiles`)
