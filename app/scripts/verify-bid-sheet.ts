/**
 * Generate a Bid Process Sheet outside the browser and check it end to end.
 *
 *   node scripts/verify-bid-sheet.ts [out.xlsx]
 *
 * Three checks, and the first is the one that matters:
 *
 *   1. ROUND TRIP. Re-import the generated workbook with the same reader the app
 *      uses on an uploaded file, and assert it rebuilds the same project with no
 *      warnings. The writer fills only the sheet's input cells and lets its own
 *      formulas produce the columns the importer checks against, so this is what
 *      proves the two halves agree — including that the formulas' cached values
 *      were updated, which Excel would hide by recalculating on open.
 *
 *   2. ZIP PARITY. The generated file has the same parts as the template, and
 *      every part the writer does not own is byte-identical. This is the check
 *      that would have caught reaching for a spreadsheet library instead: doing
 *      this with ExcelJS destroys 98 of the workbook's 128 parts.
 *
 *   3. The BoQ quantities land on the rows their SAP codes name.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

import {
  planLocation, buildDrivers, buildDriversFor, runRulesOverLocations, columnsOf,
  DEFAULT_DECLARATIONS,
} from '../../demo/src/engine.ts'
import { assemble } from '../../demo/src/boq.ts'
import { importProject, loadRules, buildPartIndex } from '../../demo/src/node-io.ts'
import { importProjectFromBuffer } from '../../demo/src/import.ts'
import { buildBidProcessSheet } from '../src/export-bid-sheet.ts'
import { blankAnswers } from '../src/questionnaire.ts'

const BASE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATE = join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
const OUT = process.argv[2] ?? join(BASE, 'app', 'BidProcessSheet.xlsx')

const fail: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}`)
  if (!ok) fail.push(what)
}

// --- generate ---------------------------------------------------------------
const d = DEFAULT_DECLARATIONS
const project = importProject(TEMPLATE)
const plans = project.locations.map((l) => planLocation(l, d))
const { resolved } = runRulesOverLocations(
  loadRules(join(BASE, 'Rule Map', 'rules.seed.json')),
  columnsOf(plans).map((p) => buildDriversFor(p, d, project.cableSource)),
  buildDrivers(project, plans, d), d,
)
const lines = assemble(resolved, [])

const partIndex = buildPartIndex(join(BASE, 'Part Catalogue', 'parts.json'))
const template = readFileSync(TEMPLATE)
const { bytes, warnings } = await buildBidProcessSheet(template, {
  project, declarations: d, lines, answers: blankAnswers(),
  partKeyOf: (code) => partIndex.get(code),
})
writeFileSync(OUT, Buffer.from(bytes))
console.log(`\nwrote ${OUT} — ${(bytes.byteLength / 1024).toFixed(0)} KB`)
for (const w of warnings) console.log(`  \x1b[33m!\x1b[0m ${w}`)

// --- 1. round trip ----------------------------------------------------------
console.log('\n\x1b[1mround trip\x1b[0m')
const back = importProjectFromBuffer(new Uint8Array(bytes), 'generated')
check(back.totals.dp === project.totals.dp,
  `detection points ${back.totals.dp} = ${project.totals.dp}`)
check(back.totals.ts === project.totals.ts,
  `track sections ${back.totals.ts} = ${project.totals.ts}`)
check(back.totals.locations === project.totals.locations,
  `locations ${back.totals.locations} = ${project.totals.locations}`)
check(back.warnings.length === 0,
  `re-imports with no warnings${back.warnings.length ? ': ' + back.warnings[0] : ''}`)
const shape = (p: typeof project) => JSON.stringify({
  locations: p.locations.map((l) => ({
    name: l.name, scope: l.scope, sections: l.sections, totalDp: l.totalDp,
  })),
})
check(shape(back) === shape(project), 'every location, section and count survives')

// --- 2. zip parity ----------------------------------------------------------
console.log('\n\x1b[1mzip parity\x1b[0m')
const a = await JSZip.loadAsync(template)
const b = await JSZip.loadAsync(bytes)
const aNames = Object.keys(a.files).filter((n) => !a.files[n]!.dir).sort()
const bNames = Object.keys(b.files).filter((n) => !b.files[n]!.dir).sort()
check(aNames.length === bNames.length && aNames.every((n, i) => n === bNames[i]),
  `${bNames.length} parts, same as the template's ${aNames.length}`)

const OWNED = /worksheets\/sheet[3789]\.xml|ctrlProps\/|xl\/workbook\.xml|calcChain/
let same = 0
const differing: string[] = []
for (const n of aNames) {
  if (OWNED.test(n)) continue
  const x = await a.file(n)!.async('uint8array')
  const y = await b.file(n)!.async('uint8array')
  if (x.length === y.length && x.every((v, i) => v === y[i])) same++
  else differing.push(n)
}
check(differing.length === 0,
  `${same} untouched parts byte-identical${differing.length ? '; differs: ' + differing.slice(0, 4).join(', ') : ''}`)
check(bNames.filter((n) => n.includes('ctrlProps')).length === 62, '62 checkboxes preserved')
check(bNames.filter((n) => n.endsWith('.vml')).length === 2, 'both VML drawings preserved')
check(bNames.filter((n) => n.includes('printerSettings')).length === 8, '8 printer settings preserved')
check(bNames.filter((n) => n.includes('media/')).length === 12, '12 images preserved')

// --- 3. the BoQ -------------------------------------------------------------
console.log('\n\x1b[1mBoQ\x1b[0m')
const XLSX = await import('xlsx')
const wb = XLSX.read(bytes, { type: 'buffer' })
const ws = wb.Sheets['10.  BOQ']!
const cellOf = (addr: string) => (ws[addr] as { v?: unknown } | undefined)?.v
const byPart = new Map(lines.filter((l) => l.partKey).map((l) => [l.partKey!, l]))
let matched = 0
let blanked = 0
let wrong = 0
for (let r = 3; r <= 43; r++) {
  const raw = cellOf(`C${r}`)
  if (raw == null) continue
  // The template's codes and the rules' codes are different code systems, so
  // both go through the part index — exactly as the writer does.
  const line = byPart.get(partIndex.get(typeof raw === 'number' ? String(raw) : String(raw).trim()) ?? '')
  const got = cellOf(`E${r}`)
  if (!line) { if (got === undefined) blanked++; continue }
  if (line.main === null) { if (got === undefined) blanked++; else wrong++ } else if (got === line.main) matched++
  else wrong++
}
check(matched >= 18, `${matched} quantities landed on the right row`)
check(wrong === 0, `${wrong} row(s) hold a quantity that is not the generated one`)
check(blanked > 0, `${blanked} row(s) written empty rather than zero`)
check(cellOf('E27') === undefined || typeof cellOf('E27') === 'number', 'wiring row is numeric or blank')

console.log()
if (fail.length) {
  console.log(`\x1b[31m${fail.length} check(s) failed\x1b[0m\n`)
  process.exit(1)
}
console.log('\x1b[32mall checks passed\x1b[0m\n')
