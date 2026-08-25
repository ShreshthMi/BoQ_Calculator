/**
 * Generate the BD/BRC calculators outside the browser and check them.
 *
 *   node scripts/verify-brc.ts [outDir]
 *
 * Five checks, and the second is the one that matters:
 *
 *   1. ZIP PARITY. 151 of the template's 152 parts, with `xl/calcChain.xml`
 *      named as the one deliberate removal, `vbaProject.bin` byte-identical,
 *      and every part the writer does not own byte-identical. This is the check
 *      that would have caught reaching for a spreadsheet library: doing this
 *      with ExcelJS destroys most of the workbook while reporting success.
 *
 *   2. THE GRID RECONCILES. Re-read the generated file, parse the drawn grid,
 *      and recompute what the sheet's own COUNTIF band will make of it — then
 *      assert that equals what the pipeline packed. Everything the writer puts
 *      in the grid is a LITERAL, so this needs no recalculation, which is the
 *      only reason a generated workbook can be checked at all before Excel has
 *      opened it.
 *
 *   3. THE SENTINEL INVARIANT. No sheet carries a real name in `A2` without a
 *      drawn grid, and a location sheet is visible exactly when it is populated.
 *      A sheet with a name and no grid is not merely empty: `Gesamt` would read
 *      the template's own scaffolding and absorb 8 PSC and 4 racks of hardware
 *      that does not exist.
 *
 *   4. PROVENANCE. Every one of the 141 BD BOM part rows carries a mark, every
 *      mark is one of the eight words, and the marks agree with the quantities —
 *      nothing marked `no rule` holds a number, nothing marked `derived` is
 *      blank. That pair is what keeps the marking honest rather than decorative.
 *
 *   5. NOTHING THE TEMPLATE OWNS WAS WRITTEN. The TE-width chain, the LB-EXB
 *      row, the Pos. prefix sums and row 3 come back byte-for-byte as formulas.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

import {
  planLocation, buildDrivers, buildDriversFor, runRulesOverLocations, columnsOf,
  parseRules, DEFAULT_DECLARATIONS, type LocationPlan,
} from '../../demo/src/engine.ts'
import { importProject, loadRules } from '../../demo/src/node-io.ts'
import { buildProject, toInput, setRoomCount } from '../../demo/src/project.ts'
import { buildGrid, tallyGrid, BLOCK0, PERIOD, LIVE_BLOCKS, ROW, COL_RACK, COL_FIRST, COL_LAST }
  from '../../packer/src/grid.ts'
import { colName } from '../src/xlsx-patch.ts'
import { buildBrcPair, ROW_MARKS, type PartRow, type RowMark } from '../src/export-brc.ts'

const BASE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATE = join(BASE, 'BOM CAL', 'ABS V.1_2025-BRC with BD BOM.xlsm')
const INPUT = join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
const OUTDIR = process.argv[2] ?? join(BASE, 'app')

/** Row offsets the template owns outright — the Pos. sums, the TE chain, LB-EXB. */
const TEMPLATE_OFFSETS = [0, 3, 12]

const fail: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}`)
  if (!ok) fail.push(what)
}

// --- generate ---------------------------------------------------------------
const d = DEFAULT_DECLARATIONS
const project = importProject(INPUT)
const plans = project.locations.map((l) => planLocation(l, d))
const rules = parseRules({ rules: loadRules(join(BASE, 'Rule Map', 'rules.seed.json')) })
const parts = (JSON.parse(
  readFileSync(join(BASE, 'Part Catalogue', 'parts.json'), 'utf8'),
) as { parts: PartRow[] }).parts

// The rules still have to run, because a generated workbook that disagrees with
// the tool's own BoQ would be the first thing to catch.
runRulesOverLocations(
  rules,
  columnsOf(plans).map((p) => buildDriversFor(p, d, project.cableSource)),
  buildDrivers(project, plans, d), d,
)

const template = readFileSync(TEMPLATE)
const books = await buildBrcPair(template, { project, declarations: d, plans, rules, parts })

mkdirSync(OUTDIR, { recursive: true })
for (const { scope, result } of books) {
  const out = join(OUTDIR, `BRC-${scope}.xlsm`)
  writeFileSync(out, Buffer.from(result.bytes))
  console.log(`\nwrote ${out} — ${(result.bytes.byteLength / 1024 / 1024).toFixed(2)} MB`)
  for (const w of result.warnings) console.log(`  \x1b[33m!\x1b[0m ${w}`)
}

const SHEETS = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0'))

for (const { scope, result } of books) {
  console.log(`\n\x1b[1m${scope}\x1b[0m`)
  const bytes = result.bytes
  const columns = columnsOf(plans.filter((p) => p.location.scope === scope))

  // --- 1. zip parity -------------------------------------------------------
  console.log('\n  \x1b[1mzip parity\x1b[0m')
  const a = await JSZip.loadAsync(template)
  const b = await JSZip.loadAsync(bytes)
  const an = Object.keys(a.files).filter((n) => !a.files[n]!.dir).sort()
  const bn = Object.keys(b.files).filter((n) => !b.files[n]!.dir).sort()
  const missing = an.filter((n) => !bn.includes(n))
  check(bn.length === an.length - 1 && missing.length === 1
    && missing[0] === 'xl/calcChain.xml',
  `${bn.length} parts, ${an.length} in the template — only calcChain removed`)

  // sheet1 = Revision, sheet2..31 = the location sheets, sheet32 = Gesamt,
  // sheet34 = BD BOM. Everything else must come out exactly as it went in.
  const OWNED = new RegExp(
    'xl/worksheets/sheet([1-9]|[12][0-9]|3[0-2]|34)\\.xml$|xl/workbook\\.xml$'
    + '|xl/_rels/workbook\\.xml\\.rels$|\\[Content_Types\\]\\.xml$|calcChain',
  )
  let same = 0
  const differing: string[] = []
  for (const n of bn) {
    if (OWNED.test(n)) continue
    const x = await a.file(n)!.async('uint8array')
    const y = await b.file(n)!.async('uint8array')
    if (x.length === y.length && x.every((v, i) => v === y[i])) same++
    else differing.push(n)
  }
  check(differing.length === 0,
    `${same} untouched parts byte-identical${differing.length ? '; differs: ' + differing.slice(0, 4).join(', ') : ''}`)
  const va = await a.file('xl/vbaProject.bin')!.async('uint8array')
  const vb = await b.file('xl/vbaProject.bin')!.async('uint8array')
  check(va.length === vb.length && va.every((v, i) => v === vb[i]), 'vbaProject.bin byte-identical')
  check(bn.filter((n) => n.includes('printerSettings')).length === 38, '38 printer settings preserved')
  check(bn.filter((n) => n.endsWith('.vml')).length === 7, '7 VML drawings preserved')
  check(bn.filter((n) => n.includes('media/')).length === 3, '3 images preserved')
  check(bn.filter((n) => n.includes('externalLinks/')).length === 2, 'the external link preserved')

  const relsXml = await b.file('xl/_rels/workbook.xml.rels')!.async('string')
  const ctXml = await b.file('[Content_Types].xml')!.async('string')
  check(!relsXml.includes('calcChain') && !ctXml.includes('calcChain'),
    'the calcChain relationship and content type went with it')
  const wbXml = await b.file('xl/workbook.xml')!.async('string')
  check(/fullCalcOnLoad="1"/.test(wbXml), 'fullCalcOnLoad is set')

  // --- 2. the grid reconciles ---------------------------------------------
  console.log('\n  \x1b[1mgrid\x1b[0m')
  const read = XLSX.read(bytes, { type: 'buffer' })
  const cellOf = (sheet: string, addr: string): unknown =>
    (read.Sheets[sheet]?.[addr] as { v?: unknown } | undefined)?.v

  const mismatches: string[] = []
  const truncated: string[] = []
  const drawnTotal: Record<string, number> = {}
  columns.forEach((plan, i) => {
    const sheet = SHEETS[i]!
    const grid = buildGrid(plan.pack, plan.groups, plan.location.name)
    const want = tallyGrid(grid)
    const got = tallyDrawn(read.Sheets[sheet] as Record<string, { v?: unknown }>)
    for (const [k, v] of Object.entries(got)) drawnTotal[k] = (drawnTotal[k] ?? 0) + v
    if (grid.dropped.length) truncated.push(plan.location.name)
    // The file must say exactly what the grid says. A location whose racks did
    // not fit is short on both sides equally — that shortfall is accounted for
    // separately below, and is never allowed to be silent.
    for (const key of ['racks', 'aeb', 'ioExb', 'comAdc', 'pscTotal', 'sparePsc',
      'spare', 'spareIo', 'trackSections', 'connector',
      'BP-PWR-4', 'BP-PWR-8', 'BP-EXB-1', 'BP-EXB-2', 'BP-EXB-4']) {
      if ((want[key] ?? 0) !== (got[key] ?? 0)) {
        mismatches.push(`${sheet} ${plan.location.name}: ${key} drew ${got[key] ?? 0}, grid says ${want[key] ?? 0}`)
      }
    }
  })
  check(mismatches.length === 0,
    `${columns.length} column(s) written exactly as drawn${mismatches.length ? ': ' + mismatches.slice(0, 3).join('; ') : ''}`)

  // What the pack booked, against what the page could hold. Any gap has to be
  // fully explained by a rack the sheet has no block for — and the tool has to
  // have said so out loud.
  const drivers = buildDrivers(project, plans.filter((p) => p.location.scope === scope), d)
  const gaps: string[] = []
  for (const [label, drawn, packed] of [
    ['evaluation boards', drawnTotal.aeb, drivers.AEB],
    ['I/O boards', drawnTotal.ioExb, drivers.IO_EXB],
    ['racks', drawnTotal.racks, drivers.racks],
    ['power supplies', drawnTotal.pscTotal, drivers.PSC],
    ['COM boards', drawnTotal.comAdc, drivers.COM_ADC],
  ] as [string, number, number][]) {
    if (drawn === packed) { check(true, `${drawn} ${label} drawn = ${packed} packed`); continue }
    gaps.push(`${label} ${drawn} of ${packed}`)
  }
  if (gaps.length) {
    check(truncated.length > 0,
      `short by ${gaps.join(', ')} — accounted for by ${truncated.length} location(s) `
      + `over the four-rack ceiling: ${truncated.join(', ')}`)
    check(result.warnings.some((w) => /packs into \d+ racks/.test(w)),
      'the shortfall was reported, not swallowed')
  }

  // --- 3. the sentinel invariant ------------------------------------------
  console.log('\n  \x1b[1msentinel\x1b[0m')
  let phantom = 0
  let wrongState = 0
  SHEETS.forEach((sheet, i) => {
    const name = String(cellOf(sheet, 'A2') ?? '')
    const populated = i < columns.length
    const drawn = tallyDrawn(read.Sheets[sheet] as Record<string, { v?: unknown }>)
    const isSentinel = /^Tabelle \d+$/.test(name)
    if (!isSentinel && drawn.racks === 0) phantom++
    if (isSentinel && drawn.racks > 0) phantom++
    const hidden = new RegExp(`<sheet[^>]*name="${sheet}"[^>]*state="hidden"`).test(wbXml)
    if (hidden === populated) wrongState++
  })
  check(phantom === 0, `${phantom} sheet(s) carry a name without a grid, or a grid without a name`)
  check(wrongState === 0, `${wrongState} sheet(s) hidden when populated, or shown when not`)
  check(SHEETS.slice(columns.length).every((s) =>
    String(cellOf(s, 'A2')) === `Tabelle ${Number(s)}`),
  'every unused sheet is back on its own sentinel')

  // --- 4. provenance ------------------------------------------------------
  console.log('\n  \x1b[1mprovenance\x1b[0m')
  const bd = read.Sheets['BD BOM'] as Record<string, { v?: unknown; f?: unknown }>
  const marked = parts.filter((p) => bd[`AL${p.source_row}`]?.v != null)
  check(marked.length === parts.length, `${marked.length} of ${parts.length} part rows carry a mark`)
  const bad = parts.filter((p) => !ROW_MARKS.includes(String(bd[`AL${p.source_row}`]?.v) as RowMark))
  check(bad.length === 0, `every mark is one of the ${ROW_MARKS.length} words`)
  const noWhy = parts.filter((p) => !String(bd[`AM${p.source_row}`]?.v ?? '').trim())
  check(noWhy.length === 0, `${parts.length - noWhy.length} rows say where the number comes from`)

  const qtyOf = (row: number) => bd[`H${row}`]?.v
  const hasFormula = (row: number) => bd[`H${row}`]?.f != null
  const lying = parts.filter((p) => {
    const mark = String(bd[`AL${p.source_row}`]?.v)
    if (mark === 'no rule' || mark === 'manual' || mark === 'dormant') {
      return qtyOf(p.source_row) != null || hasFormula(p.source_row)
    }
    return false
  })
  check(lying.length === 0,
    `${lying.length} row(s) marked as having no rule yet carrying a quantity`)
  const silent = parts.filter((p) => {
    const mark = String(bd[`AL${p.source_row}`]?.v)
    return (mark === 'derived' || mark === 'wired by tool' || mark === 'corrected by tool')
      && !hasFormula(p.source_row)
  })
  check(silent.length === 0, `${silent.length} row(s) marked derived yet holding no formula`)
  check(String(bd['H43']?.f) === 'Gesamt!C41',
    `row 43 reads Gesamt's connector count, not the I/O board row (${String(bd['H43']?.f)})`)
  console.log('       ' + ROW_MARKS.map((m) => `${m}: ${result.marks[m]}`).join(' · '))

  // --- 5. the template's own rows are untouched ---------------------------
  //
  // Asserted against the TEMPLATE rather than against a list of addresses,
  // because which cells carry a formula varies by sheet: a sheet the template
  // shipped populated has fewer than a pristine one. The claim that matters is
  // that the writer removed none of them and changed none of them.
  console.log('\n  \x1b[1mtemplate rows\x1b[0m')
  const before = XLSX.read(template, { type: 'buffer' })
  const lost: string[] = []
  const changed: string[] = []
  for (const sheet of SHEETS) {
    const was = before.Sheets[sheet] as Record<string, { f?: unknown }> | undefined
    const now = read.Sheets[sheet] as Record<string, { f?: unknown }> | undefined
    if (!was || !now) continue
    const addrs: string[] = []
    for (let blk = 0; blk < LIVE_BLOCKS; blk++) {
      const base = BLOCK0 + blk * PERIOD
      for (let c = COL_RACK; c <= COL_LAST; c++) {
        for (const off of TEMPLATE_OFFSETS) addrs.push(`${colName(c)}${base + off}`)
      }
      // the per-block COUNTIF band, which is what row 3 sums
      for (const col of ['AC', 'AF', 'AG', 'AH', 'AI', 'AK', 'AM', 'AT', 'AV', 'BB', 'BC', 'BE']) {
        addrs.push(`${col}${base + 3}`)
      }
    }
    for (const col of ['AF', 'AG', 'AH', 'AK', 'AL', 'AO', 'BJ', 'BK', 'BL']) addrs.push(`${col}3`)
    for (const row of [14, 17, 18, 21, 22, 45, 46]) addrs.push(`B${row}`)
    for (const a of addrs) {
      const f0 = was[a]?.f
      const f1 = now[a]?.f
      if (f0 != null && f1 == null) lost.push(`${sheet}!${a}`)
      else if (f0 != null && String(f0) !== String(f1)) changed.push(`${sheet}!${a}`)
    }
  }
  check(lost.length === 0,
    `no template formula removed${lost.length ? `; lost ${lost.length}: ${lost.slice(0, 4).join(', ')}` : ''}`)
  check(changed.length === 0,
    `no template formula rewritten${changed.length ? `; changed ${changed.length}: ${changed.slice(0, 4).join(', ')}` : ''}`)
  check(String((read.Sheets['Gesamt'] as Record<string, { f?: unknown }>)['C4']?.f) === "'01'!$A2",
    'Gesamt still reads the location name off the sheet')
}

// --- the configuration the tender actually shipped ---------------------------
//
// Three Yard stations put their down and up lines in separate equipment rooms,
// which is exactly why 18 rows of input sheet become 21 location sheets in the
// calculators. Declared, nothing overflows the four-rack ceiling — so the run
// above is not a limitation of the writer, it is the input being under-declared.
console.log('\n\x1b[1mwith the equipment rooms declared\x1b[0m')
const SPLIT = new Set(['Devpura', 'Snaganer', 'Durgapura'])
const declared = buildProject({
  ...toInput(project),
  locations: toInput(project).locations.map((l) =>
    (l.scope === 'YARD' && SPLIT.has(l.name) ? setRoomCount(l, 2) : l)),
})
const declaredPlans = declared.locations.map((l) => planLocation(l, d))
const pair = await buildBrcPair(template, {
  project: declared, declarations: d, plans: declaredPlans, rules, parts,
})
for (const { scope, result } of pair) {
  const cols = columnsOf(declaredPlans.filter((p) => p.location.scope === scope))
  const over = result.warnings.filter((w) => /packs into \d+ racks/.test(w))
  check(over.length === 0,
    `${scope}: ${cols.length} column(s), none over the four-rack ceiling`)
  const drivers = buildDrivers(declared, declaredPlans.filter((p) => p.location.scope === scope), d)
  const wb = XLSX.read(result.bytes, { type: 'buffer' })
  const drawn = cols.reduce((acc, _p, i) => {
    const t = tallyDrawn(wb.Sheets[SHEETS[i]!] as Record<string, { v?: unknown }>)
    for (const [k, v] of Object.entries(t)) acc[k] = (acc[k] ?? 0) + v
    return acc
  }, {} as Record<string, number>)
  check(drawn.aeb === drivers.AEB && drawn.ioExb === drivers.IO_EXB
    && drawn.racks === drivers.racks,
  `${scope}: every board and rack reaches the page — `
    + `${drawn.aeb} AEB, ${drawn.ioExb} IO, ${drawn.racks} racks`)
}
check(columnsOf(declaredPlans).length === 21,
  `${columnsOf(declaredPlans).length} evaluation columns, as the calculators carry 21 sheets`)

console.log()
if (fail.length) {
  console.log(`\x1b[31m${fail.length} check(s) failed\x1b[0m\n`)
  process.exit(1)
}
console.log('\x1b[32mall checks passed\x1b[0m\n')

/**
 * What the sheet's own COUNTIF band will report, computed from the drawn
 * literals rather than from a cached value Excel has not refreshed yet.
 */
function tallyDrawn(ws: Record<string, { v?: unknown }> | undefined): Record<string, number> {
  const out: Record<string, number> = {
    racks: 0, aeb: 0, ioExb: 0, psc: 0, pscR: 0, comAdc: 0, comXxx: 0,
    spare: 0, spareIo: 0, sparePsc: 0, leer: 0, coExb: 0, trackSections: 0,
    'BP-PWR-0': 0, 'BP-PWR-4': 0, 'BP-PWR-8': 0,
    'BP-EXB-1': 0, 'BP-EXB-2': 0, 'BP-EXB-4': 0,
  }
  if (!ws) return out
  const KEY: Record<string, string> = {
    'AEB': 'aeb', 'IO-EXB': 'ioExb', 'PSC': 'psc', 'PSC-R': 'pscR',
    'COM-AdC': 'comAdc', 'COM-xxx': 'comXxx', 'CO-EXB': 'coExb',
    'leer': 'leer', 'spare': 'spare', 'spare IO': 'spareIo', 'spare-PSC': 'sparePsc',
  }
  const at = (addr: string): string => {
    const v = ws[addr]?.v
    return v == null ? '' : String(v).trim()
  }
  for (let blk = 0; blk < LIVE_BLOCKS; blk++) {
    const base = BLOCK0 + blk * PERIOD
    if (at(`${colName(COL_RACK)}${base + ROW.header}`) === 'BGT07') out.racks++
    for (let c = COL_FIRST; c <= COL_LAST; c++) {
      const col = colName(c)
      const code = at(`${col}${base + ROW.header}`)
      if (code in out) out[code]!++
      const board = at(`${col}${base + ROW.token}`)
      const k = KEY[board]
      if (k) out[k]!++
      for (const off of [ROW.fma1, ROW.fma2]) {
        if (at(`${col}${base + off}`) !== '') out.trackSections!++
      }
    }
  }
  out.pscTotal = out.psc! + out.pscR!
  out.connector = out['BP-EXB-1']! + out['BP-EXB-2']! * 2 + out['BP-EXB-4']! * 4
  return out
}
