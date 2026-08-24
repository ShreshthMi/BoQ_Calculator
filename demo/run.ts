/**
 * The demo: input sheet in, BoQ out.
 *
 *   node run.ts                     import, generate, diff against the submitted BoQ
 *   node run.ts --overrides         same, with two overrides applied
 *   node run.ts --bump ALH-2:2      raise a location's DP and show what goes stale
 *
 * Pipeline: import -> demand -> pack -> rules -> overrides -> BoQ -> diff.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  planLocation, buildDrivers, buildDriversFor, runRulesOverLocations, columnsOf,
  DEFAULT_DECLARATIONS, type Declarations, type LocationPlan,
} from './src/engine.ts'
import {
  assemble, diffAgainstSubmitted, type Override, type BoqLine,
} from './src/boq.ts'
import {
  importProject, loadRules, readSubmittedBoq, buildPartIndexWithAliases,
} from './src/node-io.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '..')
const SHEET = join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
const RULES = join(BASE, 'Rule Map', 'rules.seed.json')
const PARTS = join(BASE, 'Part Catalogue', 'parts.json')

const argv = process.argv.slice(2)
const useOverrides = argv.includes('--overrides')
const bumpArg = argv.find((a) => a.startsWith('--bump'))
const bump = bumpArg ? (argv[argv.indexOf(bumpArg) + 1] ?? bumpArg.split('=')[1] ?? '') : ''

const pad = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n)
const rpad = (s: unknown, n: number) => String(s ?? '').padStart(n)
const rule = (n = 108) => console.log('-'.repeat(n))
const q = (v: number | null) => (v === null ? '—' : String(v))

// ---------------------------------------------------------------------------
// 1. import
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mSTAGE 1  import\x1b[0m')
const project = importProject(SHEET)
console.log(`  ${SHEET.split(/[\\/]/).pop()}  ->  sheet '16.DP TS details'`)
console.log(`  ${project.totals.locations} locations · ${project.totals.dp} DP · ${project.totals.ts} TS`)
console.log(`  reconciles with the sheet's own totals (${Object.entries(project.stated)
  .filter(([k]) => k.startsWith('Total DP')).map(([k, v]) => `${k.replace('Total DP ', '')} ${v}`).join(', ')})`)
if (project.warnings.length) {
  for (const w of project.warnings) console.log(`  ! ${w}`)
} else {
  console.log('  no import warnings')
}

// optional: change a DP count, to demonstrate staleness downstream
if (bump) {
  const [name, byRaw] = bump.split(':')
  const by = Number(byRaw ?? 1)
  const loc = project.locations.find((l) => l.name === name)
  if (loc) {
    loc.dn.dp += by; loc.totalDp += by * (loc.detection === 'DUAL' ? 2 : 1)
    project.totals.dp += by * (loc.detection === 'DUAL' ? 2 : 1)
    console.log(`  \x1b[33m~ ${name}: DN DP +${by} (simulating a revised input sheet)\x1b[0m`)
  } else {
    console.log(`  ! no location named ${name}`)
  }
}

// ---------------------------------------------------------------------------
// 2 + 3. demand and packing
// ---------------------------------------------------------------------------
const decl: Declarations = { ...DEFAULT_DECLARATIONS, dataTransmissionIO: 0 }
console.log('\n\x1b[1mSTAGE 2-3  demand and rack packing\x1b[0m')
const plans: LocationPlan[] = project.locations.map((l) => planLocation(l, decl))
rule(96)
console.log(`  ${pad('location', 16)}${pad('det', 7)}${rpad('DP', 5)}${rpad('TS', 5)}${rpad('grp', 5)}${rpad('racks', 7)}  backplanes`)
rule(96)
for (const p of plans) {
  const mix = Object.entries(p.pack.backplaneCounts)
    .filter(([, n]) => n > 0).map(([k, n]) => `${n}x${k.replace('BP-', '')}`).join(' ')
  console.log(`  ${pad(p.location.name, 16)}${pad(p.location.detection, 7)}` +
    `${rpad(p.location.totalDp, 5)}${rpad(p.location.totalTs, 5)}${rpad(p.groups.length, 5)}` +
    `${rpad(p.pack.rackCount, 7)}  ${mix}`)
}
rule(96)
const totRacks = plans.reduce((a, p) => a + p.pack.rackCount, 0)
const totCub = plans.reduce((a, p) => a + p.cubicles.total, 0)
const totCubExcel = plans.reduce((a, p) => a + p.cubicles.excelCount, 0)
console.log(`  ${pad('TOTAL', 16)}${pad('', 7)}${rpad(project.totals.dp, 5)}${rpad(project.totals.ts, 5)}` +
  `${rpad(plans.reduce((a, p) => a + p.groups.length, 0), 5)}${rpad(totRacks, 7)}  ${totCubExcel} cubicles by the workbook formula, ${totCub} by catalogue capacity`)

// ---------------------------------------------------------------------------
// 5. overrides — declared BEFORE the rules run, so dependent rules see the
//    effective quantity. `driverSnapshot` is the derived value as it stood when
//    the override was entered: recorded then, never recomputed now. That is the
//    whole basis on which staleness can be detected at all.
// ---------------------------------------------------------------------------
const overrides: Override[] = useOverrides || bump
  ? [
      {
        partKey: 'BD005', qty: 350, driverSnapshot: 550,
        reason: 'only 350 runs are within 4.8 m; balance splits to the 9.8/14.8 m kits',
        by: 'R. Menon', at: '2026-07-14',
      },
      {
        partKey: 'BD045', qty: 315, driverSnapshot: null,
        reason: 'reset boxes — no rule exists, taken from the interlocking schedule',
        by: 'R. Menon', at: '2026-07-11',
      },
    ]
  : []

// ---------------------------------------------------------------------------
// 4. rules
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mSTAGE 4  rule engine\x1b[0m')
const rules = loadRules(RULES)
const drivers = buildDrivers(project, plans, decl)
// One column per equipment room where any are declared, else one per location.
const perLocation = columnsOf(plans).map((p) => buildDriversFor(p, decl, project.cableSource))
const { resolved, problems } = runRulesOverLocations(
  rules, perLocation, drivers, decl,
  (key) => overrides.find((o) => o.partKey === key)?.qty ?? null,
)
const counts: Record<string, number> = {}
for (const r of resolved.values()) counts[r.status] = (counts[r.status] ?? 0) + 1
console.log(`  ${rules.length} rules evaluated — ` +
  Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '))
if (problems.length) {
  console.log('  problems:')
  for (const p of problems.slice(0, 8)) console.log(`    ! ${p}`)
} else {
  console.log('  no evaluation problems')
}

// ---------------------------------------------------------------------------
// 6. BoQ
// ---------------------------------------------------------------------------
const lines: BoqLine[] = assemble(resolved, overrides)
console.log('\n\x1b[1mSTAGE 6  generated BoQ\x1b[0m')
rule()
console.log(`  ${pad('rule', 6)}${pad('code', 9)}${pad('description', 42)}${rpad('main', 6)}${rpad('spare', 6)}${rpad('total', 7)}  provenance`)
rule()
let group = ''
const MARK: Record<string, string> = {
  derived: '\x1b[32m', override: '\x1b[34m', stale: '\x1b[33m',
  manual: '\x1b[31m', blank: '\x1b[31m', dormant: '\x1b[90m',
}
for (const l of lines) {
  if (l.group !== group) { group = l.group; console.log(`  \x1b[1m${group}\x1b[0m`) }
  const c = MARK[l.provenance] ?? ''
  console.log(`  ${pad(l.ruleId, 6)}${pad(l.code ?? '—', 9)}${pad(l.description, 42)}` +
    `${rpad(q(l.main), 6)}${rpad(l.spare || '', 6)}${rpad(q(l.qty), 7)}  ` +
    `${c}${l.provenance}\x1b[0m${l.note ? ` · ${l.note.slice(0, 40)}` : ''}`)
}
rule()
const prov: Record<string, number> = {}
for (const l of lines) prov[l.provenance] = (prov[l.provenance] ?? 0) + 1
console.log('  ' + Object.entries(prov).map(([k, v]) => `${v} ${k}`).join(' · '))

// ---------------------------------------------------------------------------
// 7. diff against what was actually submitted
// ---------------------------------------------------------------------------
console.log('\n\x1b[1mDIFF  generated vs the submitted BoQ (sheet "10.  BOQ")\x1b[0m')
const submitted = readSubmittedBoq(SHEET)
const { index, aliases } = buildPartIndexWithAliases(PARTS)
for (const a of aliases.applied) {
  console.log(`  [90malias ${a.code} -> ${a.partKey} (code absent from the part master)[0m`)
}
for (const a of aliases.unknownTarget) console.log(`  ! alias ${a.code} targets unknown part ${a.partKey}`)
for (const a of aliases.shadowed) console.log(`  ! alias ${a.code} is now redundant — the catalogue carries it`)
const { rows, summary } = diffAgainstSubmitted(lines, submitted, index)
rule()
console.log(`  ${pad('code', 9)}${pad('description', 44)}${rpad('subm', 7)}${rpad('ours', 7)}${rpad('delta', 7)}  verdict`)
rule()
const V: Record<string, string> = {
  match: '\x1b[32m', differs: '\x1b[33m', blank: '\x1b[31m', missing: '\x1b[90m',
}
for (const r of rows) {
  console.log(`  ${pad(r.code, 9)}${pad(r.description, 44)}${rpad(r.submitted, 7)}` +
    `${rpad(q(r.generated), 7)}${rpad(r.delta === null ? '—' : (r.delta > 0 ? `+${r.delta}` : r.delta), 7)}` +
    `  ${V[r.verdict]}${r.verdict}\x1b[0m`)
}
rule()
// The three trackside kit lines are the interesting case: the guideline in the
// questionnaire reproduces the HIDDEN older BoQ sheet exactly, and the shipped
// sheet differs from it by a hand adjustment nobody wrote down.
const kit = ['102058', '101880', '102428']
  .map((c) => rows.find((r) => r.code === c))
  .filter((r): r is NonNullable<typeof r> => r != null)
if (kit.length === 3) {
  console.log()
  console.log('  \x1b[1mcable-length split\x1b[0m  (questionnaire B151 item 16: station 75/15/10, auto block 50/50)')
  // The hidden older sheet '10. BoQ' books 369 / 144 / 37 — which is what the
  // guideline yields for the sheet AS FILED. Only claim the match when it holds;
  // a revised input moves the derived figures and the claim stops being true.
  const HIDDEN = [369, 144, 37]
  const matchesHidden = kit.every((k, i) => k.generated === HIDDEN[i])
  console.log(`    generated       ${kit.map((k) => k.generated).join(' / ')}` +
    (matchesHidden
      ? '   \x1b[32m= the hidden sheet "10. BoQ" exactly\x1b[0m'
      : `   \x1b[33minput was revised; the sheet as filed gives ${HIDDEN.join(' / ')}\x1b[0m`))
  console.log(`    shipped         ${kit.map((k) => k.submitted).join(' / ')}` +
    (matchesHidden
      ? '   \x1b[33m19 units moved 5 m -> 10 m by hand, recorded nowhere\x1b[0m'
      : ''))
}

console.log()
console.log(`  ${submitted.length} submitted lines — ` +
  `\x1b[32m${summary['match']} match\x1b[0m · ` +
  `\x1b[33m${summary['differs']} differ\x1b[0m · ` +
  `\x1b[31m${summary['blank']} blank\x1b[0m · ` +
  `\x1b[90m${summary['missing']} not produced\x1b[0m`)
console.log()
