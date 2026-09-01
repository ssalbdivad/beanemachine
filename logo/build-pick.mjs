import { readFileSync, writeFileSync } from "node:fs"
const marks = JSON.parse(readFileSync("logo/finalists.json", "utf8"))

const NOTES = {
  "billy": ["Billy", "The recommendation. Official Mets insignia, and a half-ellipse brim springing from the single point where the dome meets the base line."],
  "brim-short": ["Short brim", "Same construction, smaller radius. Stubbier; the cap reads slightly more like a beanie."],
  "brim-long": ["Long brim", "Reaches to x=112. More silhouette and more asymmetry to balance in a square avatar."],
  "brim-longest": ["Longest brim", "Reaches x=118. Dramatic, and starts to look like it belongs to a larger head."],
  "brim-shallow": ["Shallow brim", "Flatter ellipse. Sleeker and closer to a flat-brim cap."],
  "brim-deep": ["Deep brim", "Larger minor radius, so the brim droops more. The most broken-in of the set."],
  "brim-overlap": ["Overlapping brim", "Springs from x=70 instead of the dome's end, so it crosses into the crown rather than touching at a point. Shown to make the difference visible."],
  "ny-16": ["Smaller insignia", "More blue around the mark. Billy dominates; the NY starts losing its shape when shrunk."],
  "ny-20": ["Larger insignia", "Fills more of the crown. Clearest read of the monogram."],
  "ny-22": ["Largest insignia", "As big as the crown takes. Loud, and pulls focus off the face."]
}
const ORDER = Object.keys(marks)
const VB = "0 -6 116 82"

const card = k => `
      <button class="cand" data-k="${k}" type="button" aria-pressed="${k === ORDER[0]}">
        <span class="sizes">
          <svg viewBox="${VB}" width="80" height="80" aria-hidden="true">${marks[k]}</svg>
          <span class="row2">
            <svg viewBox="${VB}" width="26" height="26" aria-hidden="true">${marks[k]}</svg>
            <svg viewBox="${VB}" width="16" height="16" aria-hidden="true">${marks[k]}</svg>
          </span>
        </span>
        <span class="meta">
          <span class="cname">${NOTES[k][0]}</span>
          <code>${k}</code>
          <span class="cnote">${NOTES[k][1]}</span>
        </span>
      </button>`

writeFileSync("logo/pick.html", `<title>Beanbot Identity</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --paper:#f6f3ea; --surface:#fffefa; --sunken:#ede8da;
  --ink:#15181b; --body:#3e4146; --faint:#8d8679;
  --rule:#e2dccd; --rule-2:#cdc5b3;
  --acc:#2c7a57; --acc-soft:#e4efe9; --lens:#eaf3ee; --glint:#ffffff;
  --mets-blue:#002d72; --mets-orange:#ff5910;
  --shadow:0 1px 2px rgba(21,24,27,.05), 0 6px 22px rgba(21,24,27,.06);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#111316; --surface:#181b20; --sunken:#21252b;
    --ink:#ece9e2; --body:#c1bdb5; --faint:#7b756c;
    --rule:#272b32; --rule-2:#394047;
    --acc:#5cbe8f; --acc-soft:#152720; --lens:#1d3129; --glint:#dff0e7;
    --mets-blue:#1b4d99; --mets-orange:#ff6b2c;
    --shadow:0 1px 2px rgba(0,0,0,.35), 0 6px 22px rgba(0,0,0,.3);
  }
}
:root[data-theme="dark"]{
  --paper:#111316; --surface:#181b20; --sunken:#21252b;
  --ink:#ece9e2; --body:#c1bdb5; --faint:#7b756c;
  --rule:#272b32; --rule-2:#394047;
  --acc:#5cbe8f; --acc-soft:#152720; --lens:#1d3129; --glint:#dff0e7;
    --mets-blue:#1b4d99; --mets-orange:#ff6b2c;
  --shadow:0 1px 2px rgba(0,0,0,.35), 0 6px 22px rgba(0,0,0,.3);
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--paper); color:var(--body);
  font:16px/1.6 "Public Sans",ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.page{max-width:1020px;margin:0 auto;padding:52px 26px 84px;display:flex;flex-direction:column;gap:40px}
.eyebrow{
  font-family:"IBM Plex Mono",ui-monospace,monospace;
  font-size:11.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--faint);margin:0;
}
h1{
  font-family:"Bricolage Grotesque",ui-sans-serif,sans-serif;
  font-weight:800;font-size:clamp(33px,5.2vw,50px);line-height:1.02;letter-spacing:-.032em;
  color:var(--ink);margin:10px 0 0;text-wrap:balance;
}
.lede{max-width:60ch;margin:15px 0 0;font-size:17px}
.lede b{color:var(--ink);font-weight:600}

.pitch{
  display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:34px;align-items:center;
  background:var(--surface);border:1px solid var(--rule);border-radius:16px;
  padding:30px 32px;box-shadow:var(--shadow);
}
@media(max-width:780px){.pitch{grid-template-columns:1fr}}
.stage{display:flex;flex-direction:column;align-items:center;gap:18px}
.stage .big{width:100%;display:grid;place-items:center;background:var(--sunken);border-radius:14px;padding:18px}
.lockup{display:flex;align-items:center;gap:10px}
.lockup .word{
  font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:25px;
  letter-spacing:-.03em;color:var(--ink);
}
.lockup .word i{font-style:normal;color:var(--acc)}
.tiny{display:flex;align-items:center;gap:13px;color:var(--faint)}
.tiny span{font-family:"IBM Plex Mono",monospace;font-size:10.5px}

h2{
  font-family:"Bricolage Grotesque",sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.022em;color:var(--ink);margin:0 0 8px;
}
.anat{list-style:none;margin:18px 0 0;padding:0;display:flex;flex-direction:column;gap:11px}
.anat li{display:flex;gap:12px;align-items:baseline;font-size:14.5px}
.anat b{color:var(--ink);font-weight:600;flex:none;min-width:74px}
.anat em{font-style:normal;color:var(--acc);font-weight:600}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:13px}
.cand{
  display:grid;grid-template-columns:auto minmax(0,1fr);gap:15px;align-items:center;text-align:left;
  background:var(--surface);border:1px solid var(--rule);border-radius:12px;
  padding:15px;cursor:pointer;font:inherit;color:inherit;
  transition:border-color .14s, background .14s;
}
.cand:hover{border-color:var(--rule-2)}
.cand[aria-pressed="true"]{border-color:var(--acc);background:var(--acc-soft)}
.cand:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.sizes{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none}\n.sizes .row2{display:flex;align-items:center;gap:8px}
.meta{display:flex;flex-direction:column;gap:3px;min-width:0}
.cname{font-weight:600;color:var(--ink);font-size:14.5px}
.cand code{font-family:"IBM Plex Mono",monospace;font-size:10px;color:var(--faint)}
.cnote{font-size:12.5px;line-height:1.45}

.foot{border-top:1px solid var(--rule);padding-top:20px;font-size:14.5px;max-width:62ch}
.foot code{
  font-family:"IBM Plex Mono",monospace;font-size:13px;background:var(--sunken);
  padding:1px 6px;border-radius:5px;color:var(--ink);
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="page">
  <header>
    <p class="eyebrow">Identity study · 294 candidates · round 19</p>
    <h1>The real insignia, one clean brim</h1>
    <p class="lede">The hand-drawn monograms are gone — across four rounds none of them held up, because the interlock is the recognisable part and it doesn't survive simplification. Billy wears the <b>official cap insignia</b>. The brim is a full <b>half-ellipse, upside down</b> relative to the dome, springing from the single point where the dome's outline meets the base line: no tuck, no overlap, one contact point.</p>
  </header>

  <section class="pitch">
    <div class="stage">
      <div class="big"><svg id="hero" viewBox="${VB}" width="180" height="180" aria-label="Selected mark"></svg></div>
      <div class="lockup">
        <svg id="lock" viewBox="${VB}" width="32" height="32" aria-hidden="true"></svg>
        <span class="word">beane<i>machine</i></span>
      </div>
      <div class="tiny">
        <svg id="t32" viewBox="${VB}" width="32" height="32" aria-hidden="true"></svg><span>32</span>
        <svg id="t20" viewBox="${VB}" width="20" height="20" aria-hidden="true"></svg><span>20</span>
        <svg id="t16" viewBox="${VB}" width="16" height="16" aria-hidden="true"></svg><span>16</span>
      </div>
    </div>
    <div>
      <h2 id="hname"></h2>
      <p id="hnote" style="margin:0;font-size:15px"></p>
      <ul class="anat">
        <li><b>Brim</b><span>Half-ellipse from <em>(74, 31)</em> to <em>(106, 31)</em>, curving down while the dome curves up. Compare <em>brim-overlap</em> below, which crosses into the crown instead — that's the disjointed look.</span></li>
        <li><b>Insignia</b><span>The official mark, placed by its measured bounding box. It's the real trademark, so it's right for a personal league tool and wrong for merch.</span></li>
        <li><b>Temples</b><span>The arms hooking back to the head — the one cue that makes the specs read as <em>glasses</em>.</span></li>
        <li><b>Smile</b><span>Lens bottoms at 57.9, smile at 61. Still clear.</span></li>
      </ul>
    </div>
  </section>

  <section>
    <p class="eyebrow" style="margin-bottom:13px">Click any one to load it into the lockup and the small sizes</p>
    <div class="grid">${ORDER.map(card).join("")}</div>
  </section>

  <p class="foot">Tell me the code under the one you want — say <code>brim-long</code> — and I'll cut it as the real asset: SVG plus favicon, wired into beanecounter's header (the default is already in there). Or tell me what to change about it (longer brim, bigger insignia, flatter curve) and I'll run another pass.</p>
</div>

<script>
const MARKS = ${JSON.stringify(marks)}
const NOTES = ${JSON.stringify(NOTES)}
const ids = ["hero", "lock", "t32", "t20", "t16"]
const select = k => {
  for (const id of ids) document.getElementById(id).innerHTML = MARKS[k]
  document.getElementById("hname").textContent = NOTES[k][0]
  document.getElementById("hnote").textContent = NOTES[k][1]
  for (const b of document.querySelectorAll(".cand"))
    b.setAttribute("aria-pressed", String(b.dataset.k === k))
  try { localStorage.setItem("beanemachine-mark", k) } catch {}
}
for (const b of document.querySelectorAll(".cand"))
  b.addEventListener("click", () => select(b.dataset.k))
let start = ${JSON.stringify(ORDER[0])}
try { const s = localStorage.getItem("beanemachine-mark"); if (s && MARKS[s]) start = s } catch {}
select(start)
</script>`)
console.log("built logo/pick.html")
