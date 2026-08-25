/**
 * The BD/BRC calculator, generated.
 *
 * Takes one of the shipped calculators as a template and draws this project into
 * it: the project name, a location sheet per evaluation column with its slot
 * grid, the sentinel restored on every sheet the project does not use, the
 * `Gesamt` declarations, and the `BD BOM` wiring — plus a provenance mark on
 * every one of its 141 part rows.
 *
 * ONE PROJECT MAKES TWO WORKBOOKS, one per scope, because that is what the
 * tender did: the ABS book is `Jaipur-Sheodaspura` (8 locations, 176 DP) and
 * the Yard book is `Jaipur to Sawai` (13 locations, 374 DP) — two halves of one
 * 550-point project. `buildBrcCalculator` writes one of them; `buildBrcPair`
 * writes both.
 *
 * WHY THE SHEET NEEDS SO LITTLE FROM US
 *
 * Almost everything on a location sheet derives. Row 3 is fed by per-block
 * `COUNTIF`s over the token row and the backplane row; `Gesamt` reads row 3;
 * `BD BOM` reads `Gesamt`. So writing two rows of the grid makes the whole
 * 55,000-formula chain say the right thing, and the writer's job is to touch
 * those two rows and nothing else.
 *
 * WHAT IT MAY NOT TOUCH, AND WHY THAT LIST IS SHORT BUT ABSOLUTE
 *
 * `base+0` is a prefix sum, `base+3` the TE-width chain, `base+12` the LB-EXB
 * marker; row 3 and the `AC…EC` helper columns are the aggregation itself. Two
 * of those rows begin with a SHARED FORMULA MASTER — `D59` speaks for `D59:U59`
 * — and overwriting a master leaves its dependents pointing at a formula that no
 * longer exists, which Excel reports as a damaged workbook. `patchSheet` refuses
 * such a write rather than trusting this comment.
 *
 * AND WHY THE CALC CHAIN GOES
 *
 * Unlike the Bid Process Sheet writer, this one replaces formulas with literals
 * — the board-token row is a formula in the template and a typed value in every
 * finished sheet. That leaves `xl/calcChain.xml` naming cells that no longer
 * hold formulas, which is itself a repair prompt. It is dropped, and
 * `fullCalcOnLoad` makes Excel rebuild both it and every cached value on open.
 */
import {
  Workbook, patchSheet, setSheetState, forceFullCalc, colName,
  type CellEdit, type SheetEdits,
} from './xlsx-patch.ts'
import {
  buildGrid, tallyGrid, BLOCK0, PERIOD, LIVE_BLOCKS, ROW, COL_RACK,
  COL_FIRST, COL_LAST, type LocationGrid,
} from '../../packer/src/grid.ts'
import { splitByLength } from '../../demo/src/cable.ts'
import type {
  Declarations, LocationPlan, Project, SeedRule, Scope,
} from './pipeline.ts'

const REVISION = 'Revision'
const GESAMT = 'Gesamt'
const BD_BOM = 'BD BOM'

/** Location sheets, and the `Gesamt` column each one feeds. `'01'` -> `C`. */
const SHEETS = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0'))
const GESAMT_COL = (index: number) => colName(COL_RACK + index)

const num = (value: number) => ({ kind: 'number', value }) as const
const text = (value: string) => ({ kind: 'text', value }) as const
const blank = () => ({ kind: 'blank' }) as const
const formula = (f: string, value: number | string) =>
  ({ kind: 'formula', formula: f, value }) as const

// --- what a BD BOM row's quantity is, and where it came from -----------------

/**
 * The eight words a `BD BOM` row can be marked with.
 *
 * Six are `BoqLine.provenance` verbatim; `wired by tool` and `corrected by tool`
 * exist only here, because only this export can disagree with the shipped
 * calculator in a way that has to be visible inside the file rather than
 * discovered later.
 */
export type RowMark =
  | 'derived' | 'derived · BD BOM' | 'wired by tool' | 'corrected by tool'
  | 'tool literal' | 'manual' | 'dormant' | 'no rule'

export const ROW_MARKS: RowMark[] = [
  'derived', 'derived · BD BOM', 'wired by tool', 'corrected by tool',
  'tool literal', 'manual', 'dormant', 'no rule',
]

export type PartRow = {
  key: string
  source_row: number
  description: string
  driver: { type: string; formula?: string; label?: string }
}

/** One `BD BOM` row, classified. */
type Classified = {
  row: number
  key: string
  mark: RowMark
  why: string
  /** Set where this export wires the row to a `Gesamt` row the file never read. */
  gesamtRow?: number
  /** Set where the quantity is ours rather than the workbook's. */
  literal?: (columnIndex: number) => number | null
}

/** `Gesamt!53 <- '01'!B45 = BK3` -> 53. Rules record their own provenance. */
const gesamtRowOf = (rule: SeedRule): number | null => {
  const m = /^Gesamt!(\d+)/.exec(rule.source ?? '')
  return m ? Number(m[1]) : null
}

/**
 * Decide what every part row is, once.
 *
 * The classification is read out of `parts.json` and `rules.seed.json` rather
 * than tabulated here, so regenerating either keeps this honest instead of
 * quietly wrong.
 */
export function classifyRows(
  parts: PartRow[],
  rules: SeedRule[],
  declarations: Declarations,
  cableOf: (columnIndex: number) => { m5: number | null; m10: number | null; m15: number | null },
): Classified[] {
  const ruleFor = new Map<string, SeedRule>()
  for (const r of rules) {
    if (r.partKey && !ruleFor.has(r.partKey)) ruleFor.set(r.partKey, r)
  }
  // The three cable kits carry no Gesamt row because the workbook has no length
  // dimension at all — the split lives in questionnaire B151 item 16.
  const CABLE: Record<string, (c: ReturnType<typeof cableOf>) => number | null> = {
    K01: (c) => c.m5, K02: (c) => c.m10, K03: (c) => c.m15,
  }
  const off = (c: string | undefined): boolean =>
    c === 'cubiclesEnabled' ? !declarations.cubiclesEnabled
      : c === 'fdsRequired' ? !declarations.fdsRequired
      : c === 'planningIncluded' ? !declarations.planningIncluded
      : c === 'sparesIncluded' ? !declarations.sparesIncluded
      : c === 'powerAbove120W' ? !declarations.powerAbove120W
      : false

  return parts.map((p): Classified => {
    const rule = ruleFor.get(p.key)
    const base = { row: p.source_row, key: p.key }

    // Rows the shipped template already wires. Row 43 is the exception: its
    // formula is `=H42`, which copies the I/O board row instead of the
    // slot-weighted connector count Gesamt already has at row 41.
    if (p.driver.type === 'gesamt') {
      const g = rule ? gesamtRowOf(rule) : null
      return { ...base, mark: 'derived', why: whyDerived(rule, g, p) }
    }
    if (p.driver.type === 'derived_from_parts') {
      if (p.source_row === 43 && rule) {
        const g = gesamtRowOf(rule)
        return {
          ...base, mark: 'corrected by tool', gesamtRow: g ?? 41,
          why: `${rule.id} · shipped file reads ${p.driver.formula} — the I/O board row. `
            + `Gesamt row ${g ?? 41} already holds the slot-weighted connector count; `
            + `this file reads that instead.`,
        }
      }
      return {
        ...base, mark: 'derived · BD BOM',
        why: `computed inside BD BOM as ${p.driver.formula}`,
      }
    }

    if (!rule) return { ...base, mark: 'no rule', why: NO_RULE }
    if (rule.condition && off(rule.condition)) {
      return { ...base, mark: 'dormant', why: `${rule.id} · ${rule.condition} is switched off` }
    }
    if (rule.driver === 'MANUAL' || !rule.expression) {
      return {
        ...base, mark: 'manual',
        why: `${rule.id} · no rule exists in either calculator — enter by hand`,
      }
    }
    const pick = CABLE[rule.id]
    if (pick) {
      return {
        ...base, mark: 'tool literal',
        literal: (i) => pick(cableOf(i)),
        why: `${rule.id} · questionnaire B151 item 16; the workbook has no cable-length `
          + `dimension, so this quantity is the tool's, not Gesamt's`,
      }
    }
    const g = gesamtRowOf(rule)
    if (g === null) {
      return { ...base, mark: 'no rule', why: `${rule.id} · ${NO_GESAMT}` }
    }
    return {
      ...base, mark: 'wired by tool', gesamtRow: g,
      why: `${rule.id} · Gesamt row ${g} computes this and the shipped file never reads it`
        + (rule.confidence === 'conflict' ? ` — note: ${rule.note ?? 'the figures disagree'}` : ''),
    }
  })
}

const NO_RULE = 'no rule in the calculators, the rule map or questionnaire B151'
const NO_GESAMT = 'a rule exists but nothing in Gesamt computes it, so no quantity is written'

function whyDerived(rule: SeedRule | undefined, g: number | null, p: PartRow): string {
  const where = g !== null ? `Gesamt row ${g}` : (p.driver.formula ?? 'Gesamt')
  return rule ? `${rule.id} · ${where}, from the drawn grid` : `${where}, from the drawn grid`
}

// --- the grid ----------------------------------------------------------------

/** Every cell of one location sheet's grid that a human would type. */
function gridEdits(grid: LocationGrid, name: string): SheetEdits {
  const edits: SheetEdits = {}
  for (let b = 0; b < LIVE_BLOCKS; b++) {
    const base = BLOCK0 + b * PERIOD
    const rack = grid.racks[b]
    edits[`${colName(COL_RACK)}${base + ROW.header}`] = rack ? text(rack.type) : blank()
    // Clear the whole block first: a sheet the template shipped populated must
    // not keep one column of another tender's layout because this project's
    // rack happens to be narrower.
    for (let c = COL_FIRST; c <= COL_LAST; c++) {
      const col = colName(c)
      for (const off of [ROW.header, ROW.token, ROW.zp, ROW.fma1, ROW.fma2,
        ROW.psc, ROW.canIn, ROW.canOut]) {
        edits[`${col}${base + off}`] = blank()
      }
    }
    if (!rack) continue
    for (const bp of rack.backplanes) {
      edits[`${bp.startCol}${base + ROW.header}`] = text(bp.code)
      if (bp.pscVersion) edits[`${bp.startCol}${base + ROW.psc}`] = text(bp.pscVersion)
      if (bp.canIn) edits[`${bp.startCol}${base + ROW.canIn}`] = text('x')
      if (bp.canOut) edits[`${bp.startCol}${base + ROW.canOut}`] = text('x')
      for (const s of bp.slots) {
        // A LITERAL, always. The template's own token formula can produce only
        // PSC, PSC-R, spare-PSC, AEB and spare — there is no IO-EXB flavour in a
        // pristine sheet at all, and COM-AdC has no input row anywhere. Across
        // both shipped workbooks COM-AdC is a typed literal 42 times out of 42.
        edits[`${s.col}${base + ROW.token}`] = text(s.board)
        if (s.zp !== null) edits[`${s.col}${base + ROW.zp}`] = num(s.zp)
        if (s.fma[0] !== undefined) edits[`${s.col}${base + ROW.fma1}`] = num(s.fma[0])
        if (s.fma[1] !== undefined) edits[`${s.col}${base + ROW.fma2}`] = num(s.fma[1])
      }
    }
  }
  edits['A2'] = text(name)
  return edits
}

/** Blank the human-typed rows of a sheet this project does not use. */
function clearEdits(sentinel: string): SheetEdits {
  const edits: SheetEdits = {}
  for (let b = 0; b < LIVE_BLOCKS; b++) {
    const base = BLOCK0 + b * PERIOD
    edits[`${colName(COL_RACK)}${base + ROW.header}`] = blank()
    for (let c = COL_FIRST; c <= COL_LAST; c++) {
      const col = colName(c)
      for (const off of [ROW.header, ROW.token, ROW.zp, ROW.fma1, ROW.fma2,
        ROW.psc, ROW.canIn, ROW.canOut]) {
        edits[`${col}${base + off}`] = blank()
      }
    }
  }
  // The sentinel is the guard `Gesamt` actually tests. Restoring it is what
  // keeps an unused column at zero; clearing the grid as well is what keeps the
  // previous tender's hardware out of the file a bid engineer opens.
  edits['A2'] = text(sentinel)
  return edits
}

/**
 * The sentinel each column is guarded by, read out of `Gesamt`'s own formulas.
 *
 * It is `Tabelle N` with the leading zero stripped — sheet `'01'` is guarded by
 * `"Tabelle 1"`, not `"Tabelle 01"` — which is exactly the sort of thing worth
 * reading rather than assuming.
 */
function sentinelsFrom(gesamtXml: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of gesamtXml.matchAll(
    /<c r="([A-Z]+)5"[^>]*>\s*<f[^>]*>IF\(\$?([A-Z]+)\$?4=(?:"|&quot;)([^"&]+)/g,
  )) {
    const col = m[1]!
    if (col !== m[2]) continue
    const sheet = SHEETS[letterIndex(col) - COL_RACK]
    if (sheet) out.set(sheet, m[3]!)
  }
  return out
}

const letterIndex = (col: string): number =>
  [...col].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)

// --- the whole workbook ------------------------------------------------------

export type BrcInput = {
  project: Project
  declarations: Declarations
  /** All plans; the writer takes the ones matching `scope`. */
  plans: LocationPlan[]
  scope: Scope
  rules: SeedRule[]
  parts: PartRow[]
  /** What goes in the revision block. Defaults to today, unattributed. */
  revision?: { number?: number; date?: Date; author?: string; reason?: string }
}

export type BrcResult = { bytes: ArrayBuffer; warnings: string[]; marks: Record<RowMark, number> }

/** Excel's 1900 serial. Day 60 is the leap-year bug the epoch has to allow for. */
const dateSerial = (d: Date): number =>
  Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30))
    / 86_400_000)

export async function buildBrcCalculator(
  template: ArrayBuffer | Uint8Array,
  input: BrcInput,
): Promise<BrcResult> {
  const wb = await Workbook.open(template)
  const warnings: string[] = []
  const push = (ws: string[]) => warnings.push(...ws)

  // --- which columns this workbook carries ---------------------------------
  const mine = input.plans.filter((p) => p.location.scope === input.scope)
  const columns = mine.flatMap((p) => (p.rooms.length > 1 ? p.rooms : [p]))
  if (columns.length > SHEETS.length) {
    warnings.push(
      `${columns.length} evaluation columns and the calculator holds ${SHEETS.length} location `
      + `sheets; the last ${columns.length - SHEETS.length} are not written.`,
    )
  }
  const used = columns.slice(0, SHEETS.length)

  // --- the project name, and the revision block ----------------------------
  const rev = input.revision ?? {}
  const when = rev.date ?? new Date()
  await wb.edit(await wb.sheetPart(REVISION), (xml) => {
    const r = patchSheet(xml, {
      B21: text(input.project.source || 'Untitled project'),
      A25: num(rev.number ?? 0),
      // A serial, not text. The ABS workbook stores one and the Yard workbook
      // stores the string "28/01/2025'" — with a stray apostrophe — under the
      // same number format. Only one of those is a date.
      B25: num(dateSerial(when)),
      C25: text(rev.author ?? 'FAdC BoQ Calculator'),
      D25: text(`Generated for ${input.scope} from ${input.project.totals.locations} location(s)`),
    })
    push(r.warnings.map((w) => `${REVISION}: ${w}`))
    return r.xml
  })

  // --- the location sheets -------------------------------------------------
  const sentinels = sentinelsFrom(await wb.read(await wb.sheetPart(GESAMT)))
  const tallies: Record<string, number>[] = []
  const visible = new Map<string, 'visible' | 'hidden'>()

  for (const [i, sheet] of SHEETS.entries()) {
    const part = await wb.sheetPart(sheet)
    const plan = used[i]
    if (plan) {
      const grid = buildGrid(plan.pack, plan.groups, plan.location.name)
      push(grid.warnings)
      tallies.push(tallyGrid(grid))
      await wb.edit(part, (xml) => {
        const r = patchSheet(xml, gridEdits(grid, plan.location.name))
        // The Can IN / Can OUT rows are documentation and a few of their cells
        // are simply absent from sheets a human has edited. Nothing reads them,
        // so a miss there is not worth a warning.
        push(r.warnings.filter((w) => !isCanRow(w)).map((w) => `sheet ${sheet}: ${w}`))
        return r.xml
      })
    } else {
      const sentinel = sentinels.get(sheet) ?? `Tabelle ${Number(sheet)}`
      await wb.edit(part, (xml) => {
        const r = patchSheet(xml, clearEdits(sentinel))
        push(r.warnings.filter((w) => !isCanRow(w)).map((w) => `sheet ${sheet}: ${w}`))
        return r.xml
      })
    }
    // A location sheet is visible exactly when it is populated — the rule holds
    // across all sixty sheets of both shipped workbooks. Collected and applied
    // in one pass, rather than decompressing `workbook.xml` thirty times.
    visible.set(sheet, plan ? 'visible' : 'hidden')
  }
  await wb.edit('xl/workbook.xml', (xml) => {
    let out = xml
    for (const [sheet, state] of visible) out = setSheetState(out, sheet, state)
    return out
  })

  // --- the declarations ----------------------------------------------------
  const d = input.declarations
  await wb.edit(await wb.sheetPart(GESAMT), (xml) => {
    const r = patchSheet(xml, {
      AI81: d.fdsRequired ? text('x') : blank(),
      AI82: d.cubiclesEnabled ? text('x') : blank(),
      AI83: d.planningIncluded ? text('x') : blank(),
      AI88: text('x'),   // one COM per CAN segment per system; see G36
    })
    push(r.warnings.map((w) => `${GESAMT}: ${w}`))
    return r.xml
  })

  // --- BD BOM: the wiring, the literals, and the mark on every row ---------
  const cable = used.map((p) => splitByLength([p.location], input.project.cableSource))
  const rows = classifyRows(input.parts, input.rules, d, (i) => cable[i] ?? EMPTY_CABLE)
  const marks = Object.fromEntries(ROW_MARKS.map((m) => [m, 0])) as Record<RowMark, number>

  await wb.edit(await wb.sheetPart(BD_BOM), (xml) => {
    const edits: SheetEdits = {}
    // Two dead columns become the provenance record. `Loc 31`..`Loc 51` can
    // never be filled — Gesamt has thirty location columns — and they sit inside
    // `BG = SUM(H:BF)`, which ignores text.
    edits['AL3'] = text('Provenance')
    edits['AM3'] = text('Where this quantity comes from')
    for (let c = letterIndex('AN'); c <= letterIndex('BF'); c++) {
      edits[`${colName(c)}3`] = blank()
    }
    for (const r of rows) {
      marks[r.mark]++
      edits[`AL${r.row}`] = text(r.mark)
      edits[`AM${r.row}`] = text(r.why)
      if (r.gesamtRow !== undefined) {
        // All thirty columns, not only the ones this project uses. Partly
        // because the unused ones must read zero rather than whatever the
        // template left there, and partly because row 43's existing formula is
        // SHARED across the whole span — rewriting less than all of it would
        // leave dependents pointing at a master that has gone.
        for (let i = 0; i < SHEETS.length; i++) {
          const col = colName(letterIndex('H') + i)
          edits[`${col}${r.row}`] = formula(`=Gesamt!${GESAMT_COL(i)}${r.gesamtRow}`, 0)
        }
      } else if (r.literal) {
        used.forEach((_, i) => {
          const col = colName(letterIndex('H') + i)
          const v = r.literal!(i)
          // Blank is never zero. A cable plan that cannot be resolved leaves the
          // cell empty and says why in AM, rather than booking nothing.
          edits[`${col}${r.row}`] = v === null ? blank() : num(v)
        })
      }
    }
    const p = patchSheet(xml, edits)
    push(p.warnings.map((w) => `${BD_BOM}: ${w}`))
    return p.xml
  })

  await wb.edit('xl/workbook.xml', forceFullCalc)
  await wb.dropCalcChain()

  // --- what the reader should know, in the app rather than buried -----------
  if (marks['no rule'] > 0) {
    warnings.push(
      `${marks['no rule']} of ${rows.length} BD BOM rows have no rule anywhere and ship blank; `
      + `each says so in column AL. ${marks.manual} more need a quantity entered by hand.`,
    )
  }
  if (marks['corrected by tool'] > 0) {
    warnings.push(
      'BD BOM row 43 has been rewired to Gesamt\'s own connector count. The shipped '
      + 'calculator reads the I/O board row instead and under-books it.',
    )
  }
  const totalRacks = tallies.reduce((a, t) => a + (t.racks ?? 0), 0)
  warnings.push(
    `${input.scope}: ${used.length} location sheet(s), ${totalRacks} rack(s). `
    + 'Cached values are stale until Excel opens the file and recalculates.',
  )

  return { bytes: await wb.toBytes(), warnings, marks }
}

const EMPTY_CABLE = { m5: null, m10: null, m15: null }

const isCanRow = (warning: string): boolean => {
  const m = /^cell [A-Z]+(\d+) /.exec(warning)
  if (!m) return false
  const off = (Number(m[1]) - BLOCK0) % PERIOD
  return off === ROW.canIn || off === ROW.canOut
}

/** Both halves of a project, as the tender shipped them. */
export async function buildBrcPair(
  template: ArrayBuffer | Uint8Array,
  input: Omit<BrcInput, 'scope'>,
): Promise<{ scope: Scope; result: BrcResult }[]> {
  const out: { scope: Scope; result: BrcResult }[] = []
  for (const scope of ['ABS', 'YARD'] as Scope[]) {
    if (!input.plans.some((p) => p.location.scope === scope)) continue
    out.push({ scope, result: await buildBrcCalculator(template, { ...input, scope }) })
  }
  return out
}
