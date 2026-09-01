// Round 18: refine the interlock (round 17 showed inset-12 is the readable structure)
// and drop it onto the half-ellipse cap. The original's other signature is its
// ball-serif terminals — emulated here as discs slightly wider than the stroke,
// which is one node each rather than the reference's curve-heavy outlines.
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

const NY = ({ sw = 7, nL = 10, nR = 58, nH = 70, cy = 45, tail = 95, inset = 12, serif = 0 } = {}) => {
  const mid = (nL + nR) / 2
  const ball = serif ? (x, y) => `<circle cx="${x}" cy="${y}" r="${(sw / 2) * serif}" fill="${ORANGE}"/>` : () => ""
  return `<g stroke="${ORANGE}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M${nL} 0 V${nH}"/><path d="M${nL} 0 L${nR} ${nH}"/><path d="M${nR} 0 V${nH}"/>
    <path d="M${nL + inset} 0 L${mid} ${cy}"/><path d="M${nR - inset} 0 L${mid} ${cy}"/>
    <path d="M${mid} ${cy} V${tail}"/>
  </g>${ball(nL, 0)}${ball(nR, 0)}${ball(nL, nH)}${ball(nR, nH)}${ball(mid, tail)}`
}
const place = (px, py, h, o = {}) => {
  const sw = o.sw ?? 7, nL = o.nL ?? 10, nR = o.nR ?? 58, tail = o.tail ?? 95, serif = o.serif ?? 0
  const pad = serif ? (sw / 2) * serif : sw / 2
  const w = nR - nL + pad * 2, ht = tail + pad * 2
  const s = h / ht
  return `<g transform="translate(${(px - (w * s) / 2 - (nL - pad) * s).toFixed(2)} ${(py - h / 2 + pad * s).toFixed(2)}) scale(${s.toFixed(4)})">${NY(o)}</g>`
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
const halfEllipse = (bx, rx, ry) => `M${bx - rx} ${BASE} A ${rx} ${ry} 0 0 1 ${bx + rx} ${BASE} Z`
const cap = (nyH, o = {}, brim = [62, 42, 8]) => `
  <path d="${halfEllipse(...brim)}" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
  <path d="M6 ${BASE} C 6 ${K}, 74 ${K}, 74 ${BASE} Z" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
  ${place(CX, NY_Y, nyH, o)}`
const face = () => `
  ${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
  ${P(`M${27 - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${53 + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
  ${ci(27, EY, LR, 3.8, LENS, ACC)}${ci(53, EY, LR, 3.8, LENS, ACC)}
  ${P(`M${27 + LR} ${EY - 1} h${53 - 27 - 2 * LR}`, 3.4, ACC)}
  ${dot(27, EY + 1, 3.8)}${dot(53, EY + 1, 3.8)}
  ${P(`M${27 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${53 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
  ${P(`M${CX - 7} ${SMILE_Y} q7 5 14 0`, 3.4, INK)}`
const bot = (nyH, o, brim) => `${face()}${cap(nyH, o, brim)}`

/* serif weight */
for (const serif of [0, 1.5, 2])
  add(`serif-${serif}`, bot(18, { serif }), serif ? `ball serifs ${serif}x stroke` : "no serifs")
/* stroke */
for (const sw of [6, 8])
  add(`sw-${sw}`, bot(18, { sw, serif: 1.6 }), `stroke ${sw} · serifs`)
/* emblem size on the cap */
for (const h of [16, 18, 20])
  add(`h-${h}`, bot(h, { serif: 1.6 }), `emblem ${h} tall`)
/* inset / convergence */
add("inset-8", bot(18, { inset: 8, serif: 1.6 }), "arms start closer to the stems")
add("inset-16", bot(18, { inset: 16, serif: 1.6 }), "arms start further in")
add("conv-50", bot(18, { cy: 50, serif: 1.6 }), "arms converge lower")
/* isolated comparison */
add("cmp-real", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${realNY(40, 40, 64)}`, "original")
add("cmp-serif", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${place(40, 40, 64, { serif: 1.6 })}`, "mine, ball serifs")
add("cmp-plain", `<rect x="0" y="0" width="80" height="80" fill="${BLUE}"/>${place(40, 40, 64)}`, "mine, no serifs")

const isTile = n => n.startsWith("cmp")
const cell = ({ n, body, note }) => {
  const vb = isTile(n) ? "0 0 80 80" : "0 -6 110 82"
  const [w, h] = isTile(n) ? [134, 134] : [178, 133]
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
writeFileSync("logo/sheet18.html", `<!doctype html><meta charset="utf-8">
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
writeFileSync("logo/candidates18.json", JSON.stringify(c, null, 1))
console.log(`round 18: ${c.length} variants`)
