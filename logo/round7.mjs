// Round 7: fix the cap. Round 6's crown sat too low (ate the forehead, shoved the
// specs onto the mouth) and the front brim read as a beret. Lower crown, side brim,
// taller head, and only one orange accent so the cap doesn't shout over the specs.
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

const CX = 40, HL = 10, HR = 70, HT = 16, HB = 64
const EY = 42, LR = 12, LX = 27, RX = 53

const head = () => rr(HL, HT, HR - HL, HB - HT, 15)
const smile = (y = 55, w = 7) => P(`M${CX - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)
const specs = (fr = ACC) => `
  ${P(`M${LX - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, fr)}${P(`M${RX + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, fr)}
  ${ci(LX, EY, LR, 3.8, LENS, fr)}${ci(RX, EY, LR, 3.8, LENS, fr)}
  ${P(`M${LX + LR} ${EY - 1} h${RX - LX - 2 * LR}`, 3.4, fr)}
  ${dot(LX, EY + 1, 4)}${dot(RX, EY + 1, 4)}
  ${glint(LX, EY, LR)}${glint(RX, EY, LR)}`

/* --- caps: crown height × brim direction --- */
const crown = h => `M8 27 C 8 ${h}, 72 ${h}, 72 27 Z`
const brims = {
  right: "M69 26 C 83 25, 90 28, 87 31 C 79 32.5, 71 30.5, 66 28.5 Z",
  left:  "M11 26 C -3 25, -10 28, -7 31 C 1 32.5, 9 30.5, 14 28.5 Z",
  none:  null
}
const emblems = {
  // a tiny beanball on the front panel — the identity's own mark, worn as a logo
  bean: `${ci(CX, 17.5, 5.6, 2.6, "none", ORANGE)}${P(`M${CX} 12 C ${CX - 4.8} 14.5, ${CX + 4.8} 20.5, ${CX} 23`, 2.4, ORANGE)}`,
  dot:  `${dot(CX, 17.5, 4.8, ORANGE)}`,
  seam: `${P(`M${CX - 5} 20 C ${CX - 1.5} 14.5, ${CX + 1.5} 14.5, ${CX + 5} 20`, 3, ORANGE)}`,
  none: ""
}
const cap = (h, brimKey, emblem, { button = BLUE, antenna = false } = {}) => `
  ${antenna ? P("M62 14 l7 -7", 3.2) + dot(70.5, 5.5, 3.2, ORANGE) : ""}
  ${F(crown(h), BLUE)}
  ${brims[brimKey] ? F(brims[brimKey], BLUE) : ""}
  ${emblems[emblem]}
  ${button === "none" ? "" : dot(CX, 8.5, 2.8, button === BLUE ? INK : button)}`

const bot = (capMarkup, fr = ACC) => `${head()}${specs(fr)}${smile()}${capMarkup}`

/* crown height sweep, side brim */
for (const [i, h] of [6, 9, 12].entries())
  add(`crown-${["tall", "mid", "low"][i]}`, bot(cap(h, "right", "bean")), `crown height ${["tall", "mid", "low"][i]} · bean emblem`)

/* emblem sweep at the best crown */
for (const ek of ["bean", "dot", "seam", "none"])
  add(`emblem-${ek}`, bot(cap(9, "right", ek)), `mid crown · ${ek} emblem`)

/* brim direction */
add("brim-left", bot(cap(9, "left", "bean")), "brim swept left")
add("brim-none", bot(cap(9, "none", "bean")), "no brim (beanie read)")

/* antenna poking out from under the cap */
add("antenna-side", bot(cap(9, "right", "bean", { antenna: true })), "antenna out the side")

/* frame colour under a blue cap */
add("inkspecs", bot(cap(9, "right", "bean"), INK), "ink frames, green kept for the bean")
add("inkspecs-dot", bot(cap(9, "right", "dot"), INK), "ink frames · dot emblem")

/* orange button on top */
add("orange-button", bot(cap(9, "right", "bean", { button: ORANGE })), "orange button")
add("no-button", bot(cap(9, "right", "bean", { button: "none" })), "no button")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 96 76" width="140" height="111">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 96 76" width="36" height="28">${body}</svg>
      <svg viewBox="0 0 96 76" width="24" height="19">${body}</svg>
      <svg viewBox="0 0 96 76" width="17" height="13">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet7.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff;--mets-blue:#002d72;--mets-orange:#ff5910}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:10px 4px}
.small{display:flex;align-items:center;gap:10px}
figcaption{font-size:9.5px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:8.5px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates7.json", JSON.stringify(c, null, 1))
console.log(`round 7: ${c.length} variants`)
