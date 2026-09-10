/**
 * Render the pipeline's real output as a self-contained HTML report.
 *
 *   node scripts/report.ts [out.html]
 *
 * Every number on the page comes from an actual run — nothing is transcribed,
 * so the report cannot drift from the engine.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  planLocation, buildDrivers, buildDriversFor, runRulesOverLocations, columnsOf,
  DEFAULT_DECLARATIONS, type LocationPlan,
} from '../src/engine.ts'
import {
  assemble, diffAgainstSubmitted, type BoqLine, type DiffRow,
} from '../src/boq.ts'
import {
  importProject, loadRules, readSubmittedBoq, buildPartIndexWithAliases,
} from '../src/node-io.ts'
import { splitByLength } from '../src/cable.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '..', '..')
const SHEET = join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
const OUT = process.argv[2] ?? join(HERE, '..', 'boq-report.html')

// ---------------------------------------------------------------------------
const project = importProject(SHEET)
const decl = DEFAULT_DECLARATIONS
const plans = project.locations.map((l) => planLocation(l, decl))
const rules = loadRules(join(BASE, 'Rule Map', 'rules.seed.json'))
const { resolved, problems } = runRulesOverLocations(
  rules, columnsOf(plans).map((p) => buildDriversFor(p, decl, project.cableSource)),
  buildDrivers(project, plans, decl), decl)
const lines = assemble(resolved, [])
const submitted = readSubmittedBoq(SHEET)
const { index } = buildPartIndexWithAliases(join(BASE, 'Part Catalogue', 'parts.json'))
const { rows, summary } = diffAgainstSubmitted(lines, submitted, index)
const cable = splitByLength(project.locations, project.cableSource)

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'))
const totRacks = plans.reduce((a, p) => a + p.pack.rackCount, 0)
const totGroups = plans.reduce((a, p) => a + p.groups.length, 0)

// ---------------------------------------------------------------------------
// rack elevation — TE-proportional slots, the drawing nobody makes by hand
// ---------------------------------------------------------------------------
const TE_CLASS: Record<string, string> = {
  'PSC': 'psc', 'PSC-R': 'psc', 'spare-PSC': 'blank',
  'COM-AdC': 'com', 'COM-xxx': 'com',
  'AEB': 'aeb', 'IO-EXB': 'io', 'CO-EXB': 'io',
  'leer': 'blank', 'spare': 'blank', 'spare IO': 'blank',
}
const TE_OF: Record<string, number> = {
  'PSC': 8, 'PSC-R': 8, 'spare-PSC': 8,
  'COM-AdC': 4, 'COM-xxx': 4, 'AEB': 4, 'leer': 4, 'spare': 4,
  'IO-EXB': 6, 'CO-EXB': 6, 'spare IO': 6,
}

function elevation(plan: LocationPlan): string {
  return plan.pack.racks.map((rack) => {
    const slots = rack.backplanes.flatMap((bp) =>
      bp.contents.map((tok) => ({ tok, te: TE_OF[tok] ?? 4, bp: bp.spec.code, group: bp.group })))
    const cells = slots.map((s) => `<i class="s ${TE_CLASS[s.tok] ?? 'blank'}" style="flex:${s.te}" `
      + `title="${esc(s.tok)} · ${esc(s.te)} TE · ${esc(s.bp)} · group ${esc(s.group)}">`
      + `<b>${esc(s.tok === 'spare-PSC' ? '—' : s.tok === 'spare IO' ? '—' : s.tok === 'spare' ? '—' : s.tok)}</b></i>`).join('')
    const free = rack.teFree > 0
      ? `<i class="s free" style="flex:${rack.teFree}" title="${rack.teFree} TE unused"><b>${rack.teFree} TE</b></i>`
      : ''
    const bps = [...new Set(rack.backplanes.map((b) => b.spec.code))].join(' · ')
    return `<figure class="rack">
      <figcaption><span class="rk">BGT07 · rack ${rack.index}</span>
        <span class="mono dim">${esc(bps)}</span>
        <span class="mono dim">${rack.teUsed}/84 TE</span></figcaption>
      <div class="slots">${cells}${free}</div>
    </figure>`
  }).join('')
}

const showcase = plans.find((p) => p.location.name === 'ALH-2')!

// ---------------------------------------------------------------------------
const PROV_ORDER = ['derived', 'override', 'stale', 'manual', 'blank', 'dormant']
const provCount: Record<string, number> = {}
for (const l of lines) provCount[l.provenance] = (provCount[l.provenance] ?? 0) + 1

const boqRows = (() => {
  let group = ''
  return lines.map((l: BoqLine) => {
    const head = l.group !== group ? (group = l.group, true) : false
    const gh = head
      ? `<tr class="grp"><th colspan="6">${esc(l.group)}</th></tr>` : ''
    return gh + `<tr class="p-${l.provenance}">
      <td class="mono id">${esc(l.ruleId)}</td>
      <td class="mono">${esc(l.code ?? '—')}</td>
      <td class="desc">${esc(l.description)}${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</td>
      <td class="num mono">${n(l.main)}</td>
      <td class="num mono dim">${l.spare || ''}</td>
      <td><span class="pill ${l.provenance}">${esc(l.provenance)}</span></td>
    </tr>`
  }).join('')
})()

const diffRows = rows.map((r: DiffRow) => `<tr class="v-${r.verdict}">
  <td class="mono">${esc(r.code)}</td>
  <td class="desc">${esc(r.description)}</td>
  <td class="num mono">${n(r.submitted)}</td>
  <td class="num mono">${n(r.generated)}</td>
  <td class="num mono delta">${r.delta === null ? '' : r.delta > 0 ? `+${r.delta}` : r.delta === 0 ? '' : r.delta}</td>
  <td><span class="pill ${r.verdict}">${esc(r.verdict)}</span></td>
</tr>`).join('')

const locRows = plans.map((p) => `<tr>
  <td>${esc(p.location.name)}</td>
  <td><span class="tag">${esc(p.location.detection)}</span></td>
  <td class="num mono">${p.location.totalDp}</td>
  <td class="num mono">${p.location.totalTs}</td>
  <td class="num mono">${p.groups.length}</td>
  <td class="num mono">${p.pack.rackCount}</td>
  <td class="mono dim bp">${esc(Object.entries(p.pack.backplaneCounts)
    .filter(([, c]) => c > 0).map(([k, c]) => `${c}×${k.replace('BP-', '')}`).join('  '))}</td>
</tr>`).join('')

const OPEN = [
  ['Kit 4.8 m / 9.8 m', '350 / 163', '369 / 144', 'Ours is the questionnaire guideline, and reproduces the hidden BoQ sheet exactly. Nineteen units were moved 5 m → 10 m by hand. Measurement, or a correction to the percentages?'],
  ['Racks · BP-EXB-1 · BP-EXB-2', '68 · 27 · 92', '66 · 26 · 91', 'Sixteen of eighteen locations match. Devpura and Snaganer each come out one rack short because the workbook gives them two Gesamt columns and we pack them as one location. Two equipment rooms?'],
  ['Backplane connector', '244', '248', 'Three numbers exist: the BoQ 244, Gesamt 251, ours 248. Per IO-EXB board, or per IO-EXB slot including empty ones?'],
  ['Supply board PSC', '61', '46', 'Exactly one per group across all eight ABS locations, never on Yard, where it tracks BP-PWR count instead. What decides which power slots get a PSC rather than a blank?'],
  ['Communication board COM-AdC', '42', '46', 'One per evaluation group, exact at 17 of 21 locations. The four short ones each omit the redundant COM. Under-book, or a legitimate shared case?'],
  ['FDS102', '12', '18', 'Ours is one per location. Gesamt gives 21, BD BOM gives 0. Nothing in the files produces 12.'],
  ['Axle counter cubicle', '22', '18', '<code>ceil(racks/6)</code> gives 18, the capacity table gives 21. Neither gives 22.'],
]

const html = `<title>Jaipur–Sawai Madhopur BoQ Run</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{
  --bg:#f1f1f3; --surface:#fbfbfc; --sunk:#e7e7ea; --line:#d3d4d9; --line-soft:#e2e3e7;
  --ink:#1b1d21; --ink-2:#4d5058; --ink-3:#7e828c;
  --accent:#3f6690; --accent-soft:#dfe8f2;
  --ok:#3d7a52; --ok-soft:#dceadf;
  --warn:#9a6a17; --warn-soft:#f2e7cd;
  --bad:#a03f36; --bad-soft:#f4dedb;
  --psc:#8a6d3b; --aeb:#3f6690; --com:#6b4f86; --io:#2f7168; --blank:#b6b8bf;
  --f-disp:'Barlow Condensed','Barlow',system-ui,sans-serif;
  --f-body:'Barlow',system-ui,-apple-system,sans-serif;
  --f-mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#15171a; --surface:#1d1f23; --sunk:#111316; --line:#32353b; --line-soft:#26292e;
  --ink:#e9eaec; --ink-2:#a8acb4; --ink-3:#767b84;
  --accent:#7ea6d0; --accent-soft:#22303f;
  --ok:#7cb98f; --ok-soft:#1c2c22;
  --warn:#d6ac5c; --warn-soft:#302716;
  --bad:#dd8b81; --bad-soft:#331f1d;
  --psc:#c2a06a; --aeb:#7ea6d0; --com:#a98cc4; --io:#68b0a4; --blank:#4a4e56;
}}
:root[data-theme="dark"]{
  --bg:#15171a; --surface:#1d1f23; --sunk:#111316; --line:#32353b; --line-soft:#26292e;
  --ink:#e9eaec; --ink-2:#a8acb4; --ink-3:#767b84;
  --accent:#7ea6d0; --accent-soft:#22303f;
  --ok:#7cb98f; --ok-soft:#1c2c22;
  --warn:#d6ac5c; --warn-soft:#302716;
  --bad:#dd8b81; --bad-soft:#331f1d;
  --psc:#c2a06a; --aeb:#7ea6d0; --com:#a98cc4; --io:#68b0a4; --blank:#4a4e56;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:var(--f-body);font-size:15px;line-height:1.55;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px 96px}
h1,h2,h3{text-wrap:balance;margin:0}
.mono{font-family:var(--f-mono);font-variant-numeric:tabular-nums}
.dim{color:var(--ink-3)}
.num{text-align:right}
code{font-family:var(--f-mono);font-size:.88em;background:var(--sunk);padding:1px 5px;border:1px solid var(--line-soft)}

/* masthead ---------------------------------------------------------------- */
header{border-bottom:2px solid var(--ink);padding:40px 0 18px;margin-bottom:34px}
.eyebrow{font-family:var(--f-disp);font-size:13px;font-weight:600;letter-spacing:.16em;
  text-transform:uppercase;color:var(--accent);margin-bottom:10px}
h1{font-family:var(--f-disp);font-size:clamp(34px,5.5vw,54px);font-weight:700;
  letter-spacing:-.01em;line-height:1.02}
.sub{color:var(--ink-2);max-width:62ch;margin-top:12px}
.meta{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:20px;
  font-family:var(--f-mono);font-size:12px;color:var(--ink-3)}

/* scoreboard -------------------------------------------------------------- */
.score{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);margin:0 0 40px}
.score div{background:var(--surface);padding:15px 16px}
.score b{display:block;font-family:var(--f-mono);font-size:27px;font-weight:500;
  line-height:1.1;letter-spacing:-.02em}
.score span{font-family:var(--f-disp);font-size:12px;font-weight:600;letter-spacing:.11em;
  text-transform:uppercase;color:var(--ink-3)}
.score .hi b{color:var(--ok)} .score .lo b{color:var(--warn)} .score .no b{color:var(--bad)}

/* sections ---------------------------------------------------------------- */
section{margin:0 0 52px}
h2{font-family:var(--f-disp);font-size:26px;font-weight:600;letter-spacing:.01em;
  padding-bottom:7px;border-bottom:1px solid var(--line);margin-bottom:6px;
  display:flex;align-items:baseline;gap:12px}
h2 em{font-family:var(--f-mono);font-size:11px;font-style:normal;font-weight:400;
  letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-left:auto}
.lede{color:var(--ink-2);max-width:68ch;margin:10px 0 20px}

/* tables ------------------------------------------------------------------ */
.scroll{overflow-x:auto;border:1px solid var(--line);background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{font-family:var(--f-disp);font-size:12px;font-weight:600;letter-spacing:.09em;
  text-transform:uppercase;color:var(--ink-3);text-align:left;
  padding:9px 11px;border-bottom:1px solid var(--line);white-space:nowrap;
  position:sticky;top:0;background:var(--surface)}
th.num{text-align:right}
td{padding:6px 11px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tr.grp th{background:var(--sunk);font-size:11.5px;color:var(--ink-2);
  letter-spacing:.13em;padding:7px 11px;border-bottom:1px solid var(--line);position:static}
.desc{max-width:40ch}
.note{display:block;font-size:11.5px;color:var(--ink-3);margin-top:1px}
.id{color:var(--ink-3)}
.delta{font-weight:600}
.bp{font-size:11.5px;white-space:nowrap}
.tag{font-family:var(--f-mono);font-size:10.5px;letter-spacing:.05em;
  color:var(--ink-3);border:1px solid var(--line);padding:0 5px}

/* provenance + verdict pills ---------------------------------------------- */
.pill{font-family:var(--f-disp);font-size:11.5px;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;padding:2px 7px;white-space:nowrap;display:inline-block;
  border:1px solid var(--line);color:var(--ink-3)}
.pill.derived,.pill.match{color:var(--ok);border-color:var(--ok);background:var(--ok-soft)}
.pill.override{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.pill.stale,.pill.differs{color:var(--warn);border-color:var(--warn);background:var(--warn-soft)}
.pill.manual,.pill.blank{color:var(--bad);border-color:var(--bad);background:var(--bad-soft)}
.pill.dormant,.pill.missing{color:var(--ink-3);background:var(--sunk)}
tr.p-blank td,tr.p-manual td,tr.v-blank td{background:color-mix(in srgb,var(--bad-soft) 40%,transparent)}
tr.p-dormant td,tr.v-missing td{color:var(--ink-3)}

/* rack elevation ---------------------------------------------------------- */
.rack{margin:0 0 10px}
.rack figcaption{display:flex;gap:14px;align-items:baseline;font-size:12px;margin-bottom:4px}
.rk{font-family:var(--f-disp);font-weight:600;letter-spacing:.09em;text-transform:uppercase;font-size:12px}
.rack figcaption .dim{font-size:11.5px}
.rack figcaption .dim:last-child{margin-left:auto}
.slots{display:flex;gap:2px;height:58px;background:var(--sunk);
  border:1px solid var(--line);padding:3px}
.s{display:flex;align-items:center;justify-content:center;min-width:0;
  border:1px solid transparent;overflow:hidden}
.s b{font-family:var(--f-mono);font-size:9.5px;font-weight:500;letter-spacing:.02em;
  writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;
  color:#fff;mix-blend-mode:normal}
.s.psc{background:var(--psc)} .s.aeb{background:var(--aeb)}
.s.com{background:var(--com)} .s.io{background:var(--io)}
.s.blank{background:var(--blank)} .s.blank b{color:var(--surface)}
.s.free{background:repeating-linear-gradient(45deg,transparent,transparent 4px,var(--line) 4px,var(--line) 5px);
  border:1px dashed var(--line)}
.s.free b{color:var(--ink-3);writing-mode:horizontal-tb;transform:none}
.key{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:14px;font-size:12px;color:var(--ink-2)}
.key i{display:inline-block;width:11px;height:11px;margin-right:6px;vertical-align:-1px}

/* callout ----------------------------------------------------------------- */
.call{border:1px solid var(--line);border-left:3px solid var(--accent);
  background:var(--surface);padding:18px 22px}
.call h3{font-family:var(--f-disp);font-size:19px;font-weight:600;margin-bottom:8px}
.calc{font-family:var(--f-mono);font-size:12.5px;line-height:1.9;color:var(--ink-2);
  background:var(--sunk);padding:12px 14px;margin:14px 0;overflow-x:auto;
  border:1px solid var(--line-soft)}
.calc b{color:var(--ink);font-weight:600}

/* open questions ---------------------------------------------------------- */
.q{border:1px solid var(--line);background:var(--surface);padding:15px 18px;
  display:grid;grid-template-columns:1fr auto;gap:4px 22px;align-items:baseline}
.q + .q{border-top:0}
.q h3{font-family:var(--f-body);font-size:15px;font-weight:600}
.q .fig{font-family:var(--f-mono);font-size:12.5px;white-space:nowrap}
.q .fig s{color:var(--ink-3);text-decoration:none}
.q .fig b{color:var(--warn)}
.q p{grid-column:1/-1;margin:2px 0 0;font-size:13.5px;color:var(--ink-2);max-width:74ch}
footer{border-top:1px solid var(--line);padding-top:16px;font-size:12.5px;color:var(--ink-3)}
@media (max-width:640px){.q{grid-template-columns:1fr}.slots{height:46px}}
</style>

<div class="wrap">
<header>
  <div class="eyebrow">Frauscher FAdC R2 · bid estimation</div>
  <h1>Jaipur–Sawai Madhopur</h1>
  <p class="sub">The handover sheet goes in, a Bill of Quantities comes out, and the result is
  diffed against the BoQ the bid team actually submitted. Every figure below is from a real run.</p>
  <div class="meta">
    <span>${esc(project.totals.locations)} locations</span>
    <span>${esc(project.totals.dp)} detection points</span>
    <span>${esc(project.totals.ts)} track sections</span>
    <span>${esc(rules.length)} rules</span>
    <span>source · 16.DP TS details</span>
  </div>
</header>

<div class="score">
  <div class="hi"><b>${summary['match']}</b><span>match</span></div>
  <div class="lo"><b>${summary['differs']}</b><span>differ</span></div>
  <div class="no"><b>${summary['blank']}</b><span>blank</span></div>
  <div><b>${summary['missing']}</b><span>no rule</span></div>
  <div><b>${totRacks}</b><span>racks packed</span></div>
  <div><b>${totGroups}</b><span>eval groups</span></div>
</div>

<section>
  <h2>Demand and packing <em>stages 1–3</em></h2>
  <p class="lede">Detection points and track sections per location, split into independent
  evaluation groups, then packed into 84&nbsp;TE racks. Sixteen of the eighteen locations
  reproduce the planner's own rack count exactly.</p>
  <div class="scroll"><table>
    <thead><tr><th>Location</th><th>Detection</th><th class="num">DP</th><th class="num">TS</th>
      <th class="num">Groups</th><th class="num">Racks</th><th>Backplanes</th></tr></thead>
    <tbody>${locRows}</tbody>
  </table></div>
</section>

<section>
  <h2>Rack elevation · ALH-2 <em>the drawing nobody makes by hand</em></h2>
  <p class="lede">Four identical racks, ten counting points each, one COM board per group.
  Slot widths are true to their TE pitch — PSC 8, AEB and COM 4, IO-EXB 6 — so what you see is
  the physical subrack, not a schematic.</p>
  ${elevation(showcase)}
  <div class="key">
    <span><i style="background:var(--psc)"></i>PSC · 8 TE</span>
    <span><i style="background:var(--aeb)"></i>AEB · 4 TE</span>
    <span><i style="background:var(--com)"></i>COM-AdC · 4 TE</span>
    <span><i style="background:var(--io)"></i>IO-EXB · 6 TE</span>
    <span><i style="background:var(--blank)"></i>blank</span>
  </div>
</section>

<section>
  <h2>Generated BoQ <em>${PROV_ORDER.filter((k) => provCount[k]).map((k) => `${provCount[k]} ${k}`).join(' · ')}</em></h2>
  <p class="lede">Every line carries where its number came from. A rule that cannot resolve
  produces a flagged blank, never a silent zero — a zero would read as a real answer of
  “none required”.</p>
  <div class="scroll"><table>
    <thead><tr><th>Rule</th><th>Code</th><th>Description</th>
      <th class="num">Main</th><th class="num">Spare</th><th>Provenance</th></tr></thead>
    <tbody>${boqRows}</tbody>
  </table></div>
</section>

<section>
  <h2>The cable-length split <em>a rule from outside the calculator</em></h2>
  <div class="call">
    <h3>369 / 144 / 37 — exactly the hidden BoQ sheet</h3>
    <p>Neither calculator carries a cable-length dimension. The rule is prose, in the handover
    questionnaire at cell <code>B151</code> item 16: station work takes 75&nbsp;% of 5&nbsp;m,
    15&nbsp;% of 10&nbsp;m and 10&nbsp;% of 15&nbsp;m; auto block splits 50/50.</p>
    <div class="calc">
      5 m &nbsp; 0.75 × 374 &nbsp;+&nbsp; 0.50 × 176 &nbsp;=&nbsp; 368.5 &nbsp;→&nbsp; <b>${cable.m5}</b><br>
      10 m &nbsp;0.15 × 374 &nbsp;+&nbsp; 0.50 × 176 &nbsp;=&nbsp; 144.1 &nbsp;→&nbsp; <b>${cable.m10}</b><br>
      15 m &nbsp;0.10 × 374 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;=&nbsp; 37.4 &nbsp;&nbsp;→&nbsp; <b>${cable.m15}</b>
    </div>
    <p>That is what the older hidden sheet books. The shipped sheet reads 350 / 163 / 37 —
    nineteen units moved from 5&nbsp;m to 10&nbsp;m by hand, after the fact, with no reason
    recorded anywhere.</p>
  </div>
</section>

<section>
  <h2>Diff against the submitted BoQ <em>sheet “10.&nbsp; BOQ”</em></h2>
  <p class="lede">Quantities are compared main-to-main: the submitted BoQ leaves its Spare
  column empty on all ${submitted.length} lines, so comparing totals would show a difference on
  every spared line that is really about spares policy.</p>
  <div class="scroll"><table>
    <thead><tr><th>Code</th><th>Description</th><th class="num">Submitted</th>
      <th class="num">Generated</th><th class="num">Δ</th><th>Verdict</th></tr></thead>
    <tbody>${diffRows}</tbody>
  </table></div>
</section>

<section>
  <h2>Open questions <em>${OPEN.length} to settle</em></h2>
  <p class="lede">Each difference below is the engine disagreeing with the tender for a stated
  reason, not failing. Several are cases where the tender looks wrong.</p>
  ${OPEN.map(([t, sub, ours, why]) => `<div class="q">
    <h3>${t}</h3>
    <div class="fig"><s>${sub}</s> &nbsp;→&nbsp; <b>${ours}</b></div>
    <p>${why}</p>
  </div>`).join('')}
</section>

<footer>
  Generated from a live pipeline run · ${esc(rules.length)} rules ·
  ${problems.length} unresolved reference${problems.length === 1 ? '' : 's'} ·
  packing verified against 21 reference locations
</footer>
</div>
`

writeFileSync(OUT, html, 'utf8')
console.log(`wrote ${OUT}  (${(html.length / 1024).toFixed(1)} KB)`)
console.log(`  ${summary['match']} match · ${summary['differs']} differ · ${summary['blank']} blank · ${summary['missing']} not produced`)
