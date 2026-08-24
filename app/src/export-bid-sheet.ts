/**
 * The whole handover artefact, not one sheet of it.
 *
 * Takes the Bid Process Sheet as a template and writes this project into it:
 * the DP/TS table, the BoQ, and the questionnaire answers the tool can stand
 * behind. Everything else — the eligibility conditions, the customer
 * requirements register, the pre-bid query sheet, the checklist, the template
 * revision log — passes through byte-identical, because none of it carries a
 * single answer belonging to the tender the template came from.
 *
 * FOUR TABS CARRY PROJECT DATA AND THEY ARE ALL REWRITTEN
 *
 *   `16.DP TS details`   the locations
 *   `10.  BOQ`           the bill of quantities
 *   `10. BoQ`  (hidden)  an older, superseded BoQ — cleared, never carried
 *   `4. Project Questionnairre`   the answers
 *
 * The DP/TS sheet is written by filling only its INPUT cells. Its own formulas
 * do the rest: `K5 = G5+I5`, `T5 = P5+R5`, `V5 = T5`, and `SUM` down row 16.
 * Those are the very columns `demo/src/import.ts` reads back as a consistency
 * check, so import and export agree by construction rather than by two copies
 * of the same arithmetic. Their cached values are updated alongside, because
 * Excel recalculates on open but SheetJS reads the cache — and re-importing the
 * generated file is how this module is tested.
 */
import * as XLSX from 'xlsx'
import {
  Workbook, patchSheet, restyle, setChecked, forceFullCalc,
  type SheetEdits,
} from './xlsx-patch.ts'
import type { BoqLine, Declarations, Project } from './pipeline.ts'
import { type Answers, answersFor, CONTROL_STYLE } from './questionnaire.ts'

const DP_TS = '16.DP TS details'
const BOQ = '10.  BOQ'
const OLD_BOQ = '10. BoQ'
const QUESTIONNAIRE = '4. Project Questionnairre'

/** The template's two blocks are ten rows each, and rows cannot be inserted. */
const FIRST_ROW = 5
const LAST_ROW = 14
const CAPACITY = LAST_ROW - FIRST_ROW + 1

const num = (value: number) => ({ kind: 'number', value }) as const
const text = (value: string) => ({ kind: 'text', value }) as const
const blank = () => ({ kind: 'blank' }) as const

export type BidSheetInput = {
  project: Project
  declarations: Declarations
  lines: BoqLine[]
  answers: Answers
  /**
   * Resolve a SAP code to a catalogue part key.
   *
   * The BoQ's rows and the generated lines do NOT share a code system. The
   * template writes `24422` for the rail deflector and `17390` for the rack —
   * AT Sales Cloud and RDSO numbers — where the rules carry the IN Sales Cloud
   * `101950` and `100049`. Matching on the raw code finds six of forty-one.
   * Both sides go through the part index instead, which is the same crosswalk
   * the diff against the submitted BoQ already uses, aliases included.
   */
  partKeyOf: (code: string) => string | undefined
}

export type BidSheetResult = { bytes: ArrayBuffer; warnings: string[] }

/**
 * `16.DP TS details` — the Yard block in E:L, the ABS block in N:W.
 *
 * The addresses are exactly the ones the importer reads. `K/L`, `T/U` and `V/W`
 * are formulas, so only their caches are touched here.
 */
function dpTsEdits(project: Project): { edits: SheetEdits; warnings: string[] } {
  const edits: SheetEdits = {}
  const warnings: string[] = []
  const yard = project.locations.filter((l) => l.scope === 'YARD')
  const abs = project.locations.filter((l) => l.scope === 'ABS')

  for (const [what, list] of [['Yard', yard], ['ABS', abs]] as const) {
    if (list.length > CAPACITY) {
      warnings.push(
        `${list.length} ${what} locations but the sheet's block holds ${CAPACITY} rows; `
        + `the last ${list.length - CAPACITY} are not written. The BoQ still books all of them.`,
      )
    }
  }

  // --- Yard: F name, G/H down, I/J up, K/L the sheet's own sums -------------
  yard.slice(0, CAPACITY).forEach((l, i) => {
    const r = FIRST_ROW + i
    edits[`F${r}`] = text(l.name)
    edits[`G${r}`] = num(l.dn.dp)
    edits[`H${r}`] = num(l.dn.ts)
    edits[`I${r}`] = num(l.up.dp)
    edits[`J${r}`] = num(l.up.ts)
    edits[`K${r}`] = num(l.dn.dp + l.up.dp)
    edits[`L${r}`] = num(l.dn.ts + l.up.ts)
  })

  // --- ABS: one ROW PER SECTION, which is how the sheet records them --------
  //
  // Durgapura and Sanganer each sit on two block sections and appear twice, and
  // the importer merges them back by name. Writing one row per section is what
  // makes that round trip: collapse them to one row and the per-section split
  // — the thing that makes their rack count three rather than two — is lost.
  const absRows = abs.flatMap((l) => l.sections.map((s) => ({ l, s })))
  if (absRows.length > CAPACITY) {
    warnings.push(
      `${absRows.length} ABS block-section rows but the sheet holds ${CAPACITY}; `
      + `the last ${absRows.length - CAPACITY} are not written.`,
    )
  }
  absRows.slice(0, CAPACITY).forEach(({ l, s }, i) => {
    const r = FIRST_ROW + i
    const mainDp = s.dn.dp + s.up.dp
    const mainTs = s.dn.ts + s.up.ts
    edits[`N${r}`] = text(s.name || l.name)
    edits[`O${r}`] = text(l.name)
    edits[`P${r}`] = num(s.dn.dp)
    edits[`Q${r}`] = num(s.dn.ts)
    edits[`R${r}`] = num(s.up.dp)
    edits[`S${r}`] = num(s.up.ts)
    edits[`T${r}`] = num(mainDp)
    edits[`U${r}`] = num(mainTs)
    edits[`V${r}`] = num(mainDp)
    edits[`W${r}`] = num(mainTs)
  })

  // --- rows the project does not use ---------------------------------------
  for (let r = FIRST_ROW + yard.length; r <= LAST_ROW; r++) {
    for (const c of ['F', 'G', 'H', 'I', 'J', 'K', 'L']) edits[`${c}${r}`] = blank()
  }
  for (let r = FIRST_ROW + absRows.length; r <= LAST_ROW; r++) {
    for (const c of ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W']) edits[`${c}${r}`] = blank()
  }

  // --- row 16, the sheet's own totals --------------------------------------
  const sum = (list: typeof yard, f: (l: typeof yard[number]) => number) =>
    list.reduce((a, l) => a + f(l), 0)
  edits['G16'] = num(sum(yard, (l) => l.dn.dp))
  edits['H16'] = num(sum(yard, (l) => l.dn.ts))
  edits['I16'] = num(sum(yard, (l) => l.up.dp))
  edits['J16'] = num(sum(yard, (l) => l.up.ts))
  edits['K16'] = num(sum(yard, (l) => l.dn.dp + l.up.dp))
  edits['L16'] = num(sum(yard, (l) => l.dn.ts + l.up.ts))
  const absMainDp = sum(abs, (l) => l.dn.dp + l.up.dp)
  const absMainTs = sum(abs, (l) => l.dn.ts + l.up.ts)
  edits['P16'] = num(sum(abs, (l) => l.dn.dp))
  edits['Q16'] = num(sum(abs, (l) => l.dn.ts))
  edits['R16'] = num(sum(abs, (l) => l.up.dp))
  edits['S16'] = num(sum(abs, (l) => l.up.ts))
  edits['T16'] = num(absMainDp)
  edits['U16'] = num(absMainTs)
  edits['V16'] = num(absMainDp)
  edits['W16'] = num(absMainTs)

  // --- the summary block, which the importer reads back as a check ---------
  const yardDp = sum(yard, (l) => l.totalDp)
  const yardTs = sum(yard, (l) => l.totalTs)
  edits['O22'] = num(project.totals.dp - yardDp)
  edits['O23'] = num(project.totals.ts - yardTs)
  edits['O24'] = num(yardDp)
  edits['O25'] = num(yardTs)
  edits['O26'] = num(project.totals.dp)
  edits['O27'] = num(project.totals.ts)
  // The template types this one by hand, and gets it wrong — it says 18 where
  // its own blocks hold 20 rows. The tool knows the real answer.
  edits['O28'] = num(project.totals.locations)

  // --- the reference tender's own margin note ------------------------------
  edits['E13'] = blank()

  return { edits, warnings }
}

/** `10.  BOQ` — fill the table's rows, matching on catalogue part rather than code. */
function boqEdits(
  lines: BoqLine[],
  codeRow: Map<string, number>,
  partKeyOf: (code: string) => string | undefined,
): { edits: SheetEdits; warnings: string[] } {
  const edits: SheetEdits = {}
  const warnings: string[] = []
  const byPart = new Map<string, BoqLine>()
  for (const l of lines) if (l.partKey) byPart.set(l.partKey, l)

  const used = new Set<string>()
  for (const [code, r] of codeRow) {
    const key = partKeyOf(code)
    const line = key ? byPart.get(key) : undefined
    if (!line) {
      // A row the template carries and this project does not produce. Blanked
      // rather than left holding another tender's number.
      edits[`E${r}`] = blank()
      edits[`F${r}`] = blank()
      continue
    }
    used.add(key!)
    // Blank stays blank. A line no rule could produce writes an empty cell,
    // never a zero — a zero in a BoQ reads as a real answer of "none required".
    edits[`E${r}`] = line.main === null ? blank() : num(line.main)
    edits[`F${r}`] = num(line.spare)
  }

  const extra = [...byPart.values()].filter((l) => l.partKey && !used.has(l.partKey))
  if (extra.length) {
    warnings.push(
      `${extra.length} generated line(s) have no row in the template's BoQ table `
      + `and are not written: ${extra.slice(0, 6).map((l) => l.code ?? l.ruleId).join(', ')}`
      + `${extra.length > 6 ? ' and more' : ''}.`,
    )
  }
  return { edits, warnings }
}

/**
 * The SAP code on every row of the template's BoQ table, and the row it is on.
 *
 * Read with SheetJS rather than off the XML, because the codes are a mixture:
 * most are numbers, some are shared strings, and one is the string
 * "101375+102299+102300" — three codes concatenated into a single line item.
 * The same reader already handles that when the submitted BoQ is imported.
 */
function readCodeRows(template: ArrayBuffer | Uint8Array): Map<string, number> {
  const wb = XLSX.read(template, { type: 'buffer' })
  const ws = wb.Sheets[BOQ]
  const out = new Map<string, number>()
  if (!ws) return out
  for (let r = 3; r <= 60; r++) {
    const c = ws[`C${r}`] as { v?: unknown } | undefined
    if (c?.v == null) continue
    const code = typeof c.v === 'number' ? String(c.v) : String(c.v).trim()
    if (code) out.set(code, r)
  }
  return out
}

/**
 * Write a project into the Bid Process Sheet.
 *
 * `template` is the workbook's own bytes. Nothing is copied out of it into the
 * repository — it is read, patched and handed back.
 */
export async function buildBidProcessSheet(
  template: ArrayBuffer | Uint8Array,
  input: BidSheetInput,
): Promise<BidSheetResult> {
  const wb = await Workbook.open(template)
  const warnings: string[] = []

  // --- the locations -------------------------------------------------------
  const dpTsPart = await wb.sheetPart(DP_TS)
  const dpTs = dpTsEdits(input.project)
  warnings.push(...dpTs.warnings)
  await wb.edit(dpTsPart, (xml) => {
    const patched = patchSheet(xml, dpTs.edits)
    warnings.push(...patched.warnings)
    // Row 13 is set in red in the template, beside the "To Match the Quantity"
    // note that says its numbers were adjusted to make the totals land. Neither
    // belongs to a new project.
    return restyle(
      patched.xml,
      ['F', 'G', 'H', 'I', 'J', 'K', 'L'].map((c) => `${c}13`),
      '68',
    )
  })

  // --- the BoQ -------------------------------------------------------------
  const boqPart = await wb.sheetPart(BOQ)
  const codeRows = readCodeRows(template)
  await wb.edit(boqPart, (xml) => {
    const boq = boqEdits(input.lines, codeRows, input.partKeyOf)
    warnings.push(...boq.warnings)
    const patched = patchSheet(xml, boq.edits)
    warnings.push(...patched.warnings)
    return patched.xml
  })

  // --- the superseded BoQ, cleared ----------------------------------------
  //
  // It is hidden, it disagrees with the sheet that shipped, and it holds another
  // project's figures. Carrying it would ship those inside the file.
  const oldPart = await wb.sheetPart(OLD_BOQ)
  await wb.edit(oldPart, (xml) => {
    const edits: SheetEdits = {}
    for (const m of xml.matchAll(/<c r="(D\d+)"[^>]*>[\s\S]*?<\/c>/g)) {
      if (!/t="s"/.test(m[0])) edits[m[1]!] = blank()
    }
    return patchSheet(xml, edits).xml
  })

  // --- the questionnaire ---------------------------------------------------
  const qPart = await wb.sheetPart(QUESTIONNAIRE)
  const answers = answersFor(input.project, input.declarations, input.answers)
  await wb.edit(qPart, (xml) => patchSheet(xml, answers.cells).xml)
  for (const [part, checked] of answers.controls) {
    await wb.edit(part, (xml) => setChecked(xml, checked))
  }

  await wb.edit('xl/workbook.xml', forceFullCalc)
  return { bytes: await wb.toBytes(), warnings }
}

export { CONTROL_STYLE }
