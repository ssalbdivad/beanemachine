// Round 9: the NY was overflowing the crown because I placed it against the control
// point, not the curve's real apex. For this cubic the apex is (60 + 6k)/8, not k.
// Compute the crown's true interior and fit the monogram inside it.
import { writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"
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

const CAP_BASE = 31
const apex = k => (CAP_BASE * 2 + 6 * k) / 8   // cubic midpoint for P1y=P2y=k

const NY = ({ sw = 4.4, yGap = 10, tail = 8, splay = 7.5 } = {}) => `
  <g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M0 0 V18"/><path d="M0 0 L10 18"/><path d="M10 0 V18"/>
    <path d="M${yGap} 0 L${yGap + splay} 10"/>
    <path d="M${yGap + splay * 2} 0 L${yGap + splay} 10"/>
    <path d="M${yGap + splay} 10 V${10 + tail}"/>
  </g>`
const placeNY = (cx, cy, h, o = {}) => {
  const gap = o.yGap ?? 10, splay = o.splay ?? 7.5, tail = o.tail ?? 8, sw = o.sw ?? 4.4
  const w = gap + splay * 2, ht = 10 + tail
  const s = h / ht
  // half the stroke sticks out past the path bounds on every side
  return `<g transform="translate(${cx - (w * s) / 2} ${cy - (ht * s) / 2}) scale(${s})">${NY(o)}</g>`
}

const CX = 40, HL = 10, HR = 70, HT = 20, HB = 68
const EY = 46, LR = 12, LX = 27, RX = 53
const head = () => rr(HL, HT, HR - HL, HB - HT, 15)
const smile = (y = 59, w = 7) => P(`M${CX - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)
const specs = (fr = ACC) => `
  ${P(`M${LX - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, fr)}${P(`M${RX + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, fr)}
  ${ci(LX, EY, LR, 3.8, LENS, fr)}${ci(RX, EY, LR, 3.8, LENS, fr)}
  ${P(`M${LX + LR} ${EY - 1} h${RX - LX - 2 * LR}`, 3.4, fr)}
  ${dot(LX, EY + 1, 4)}${dot(RX, EY + 1, 4)}
  ${glint(LX, EY, LR)}${glint(RX, EY, LR)}`

const crown = k => `M6 ${CAP_BASE} C 6 ${k}, 74 ${k}, 74 ${CAP_BASE} Z`
const brims = {
  big:  "M69 27 C 89 26, 103 31, 98 37.5 C 86 40.5, 72 36.5, 64 32.5 Z",
  huge: "M69 26 C 92 25, 110 31, 104 39.5 C 89 43.5, 72 37.5, 63 32.5 Z"
}
// fit the monogram between the crown's true apex and its base, with padding
const cap = (k, brimKey, { pad = 4, o = {} } = {}) => {
  const top = apex(k) + pad, bottom = CAP_BASE - pad
  const h = bottom - top
  return `${F(crown(k), BLUE)}${F(brims[brimKey], BLUE)}${placeNY(CX, (top + bottom) / 2, h, o)}`
}
const bot = m => `${head()}${specs()}${smile()}${m}`

for (const k of [-8, -4, 0])
  add(`crown${k}`, bot(cap(k, "big")), `crown control ${k} → apex ${apex(k).toFixed(1)} · NY auto-fitted`)
for (const pad of [2, 4, 6])
  add(`pad-${pad}`, bot(cap(-6, "big", { pad })), `padding ${pad} inside crown`)
add("huge-brim", bot(cap(-6, "huge")), "huge brim")
add("ny-wide", bot(cap(-6, "big", { o: { yGap: 12, splay: 8 } })), "wider Y, less overlap")
add("ny-tight", bot(cap(-6, "big", { o: { yGap: 8 } })), "tighter interlock")
add("ny-bold", bot(cap(-6, "big", { o: { sw: 5.2 } })), "heavier monogram")
add("ny-shorttail", bot(cap(-6, "big", { o: { tail: 5 } })), "shorter Y tail")
add("huge-wide", bot(cap(-6, "huge", { o: { yGap: 12, splay: 8 } })), "huge brim + wide NY")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 112 80" width="164" height="117">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 112 80" width="44" height="31">${body}</svg>
      <svg viewBox="0 0 112 80" width="28" height="20">${body}</svg>
      <svg viewBox="0 0 112 80" width="19" height="14">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet9.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates9.json", JSON.stringify(c, null, 1))
console.log(`round 9: ${c.length} variants · apex(-6)=${apex(-6).toFixed(1)}`)
