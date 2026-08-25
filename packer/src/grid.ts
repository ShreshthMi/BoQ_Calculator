/**
 * The drawn slot grid — a packed location as the calculator's own picture of it.
 *
 * `pack()` decides what hardware there is. This decides where it sits on the
 * page and what a planner writes underneath it: the counting-point number below
 * every evaluation board, the track-section numbers below every I/O board, and
 * the R1/NE marker on every power slot. Those three are the *inputs* the
 * location sheet's own formulas read; everything the sheet totals follows from
 * them plus the board tokens.
 *
 * The shape is deliberately the one `Rule Map/fixtures/actual-layouts.json`
 * already uses, because that fixture was extracted from the two shipped
 * workbooks and is therefore the ground truth this module is scored against.
 *
 * Zero dependencies and no I/O, like the rest of `packer/`.
 *
 * THE GEOMETRY, and where it differs from what you would guess
 *
 *   Eight 14-row blocks are scaffolded per sheet, at rows 56, 70, 84, 98, 112,
 *   126, 140, 154 — but only the FIRST FOUR are alive. Blocks 5–8 were emptied
 *   on purpose, and the workbook says why. `Rev!C5`, the layout template's own
 *   changelog:
 *
 *     "From 5 BGT to 8 BGT content deleted hence maximum 4 BGT only can be
 *      mounted in India environmental condition. If require to use those BGT's,
 *      Content shall be copied from above BGT and pasted."
 *
 *   So four racks per sheet is an engineering decision, not damage, and this
 *   module reports a fifth rack rather than quietly drawing into a block whose
 *   formulas were removed.
 *
 *   Slot columns are D…U — eighteen of them. Column C holds the rack type alone.
 *   The template's per-slot formulas stop at U; V, W and X are styled empties
 *   with no width formula behind them, so a board written there would count for
 *   zero TE.
 */
import { TE_OF, type BoardToken } from './types.ts'
import type { PackResult, PlacedBackplane } from './types.ts'

/** First block's base row, and the row period between blocks. */
export const BLOCK0 = 56
export const PERIOD = 14

/** Blocks whose formulas survive. See `Rev!C5`, quoted above. */
export const LIVE_BLOCKS = 4

/** Slot columns, 1-based: D = 4 … U = 21. Column C = 3 holds the rack type. */
export const COL_RACK = 3
export const COL_FIRST = 4
export const COL_LAST = 21
export const SLOTS_PER_RACK = COL_LAST - COL_FIRST + 1

/** Row offsets from a block's base row. Only these are ever written. */
export const ROW = {
  /** `C` rack type, `D…U` backplane code at each backplane's first column. */
  header: 1,
  /** Board token per slot. */
  token: 2,
  /** Counting-point number, under each AEB. */
  zp: 4,
  /** Track-section numbers, under each IO-EXB. */
  fma1: 5,
  fma2: 6,
  /** `R1` / `R2` / `NE`, at each BP-PWR's first column. */
  psc: 9,
  canIn: 10,
  canOut: 11,
} as const

/**
 * Rows the template owns and this module must never write:
 * `+0` the derived Pos. prefix sums, `+3` the TE-width chain (a shared formula
 * master at `D`), `+12` the LB-EXB marker (likewise). Listed so the writer can
 * assert it, rather than left as a comment nobody checks.
 */
export const TEMPLATE_ROWS = [0, 3, 12] as const

/** `4` -> `'D'`. */
export function colName(index: number): string {
  let n = index
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = (n - r - 1) / 26
  }
  return out
}

/**
 * Can IN / Can OUT, per backplane variant.
 *
 * These are documentation, not data: no formula anywhere in either workbook
 * reads these two rows. Measured across all 21 reference locations, the pair is
 * a pure function of the backplane VARIANT and has nothing to do with position —
 * which is the signature of a marker copied in with a `Vorlagen` palette strip
 * rather than reasoned about. A first-and-last daisy-chain reading was tested
 * and refuted outright: 0 of 46 evaluation groups match it.
 *
 * So the palette's own marking is reproduced, because that is what a copied
 * strip produces and what a bid engineer expects to see.
 *
 * BP-PWR-8 is the one variant the data does not settle — 38 occurrences read
 * (out) and 18 read (in), matching the two BP-PWR-8 slots of `Vorlagen` strip
 * 43, and no position rule separates them. The majority is used and the split is
 * recorded here rather than papered over.
 */
const CAN_OF: Record<string, { in: boolean; out: boolean }> = {
  'BP-PWR-0': { in: false, out: false },
  'BP-PWR-4': { in: true, out: true },
  'BP-PWR-8': { in: false, out: true },
  'BP-EXB-1': { in: false, out: false },
  'BP-EXB-2': { in: true, out: true },
  'BP-EXB-4': { in: true, out: false },
}

export type GridSlot = {
  col: string
  board: BoardToken
  te: number
  /** Counting point, on AEB slots only. */
  zp: number | null
  /** Track sections, on IO-EXB slots only — two per board, one where TS is odd. */
  fma: number[]
}

export type GridBackplane = {
  code: string
  startCol: string
  /** `R1` where the power slot is equipped, `NE` where it is blanked. */
  pscVersion: 'R1' | 'NE' | null
  canIn: boolean
  canOut: boolean
  /** Which evaluation group owns it. No backplane ever mixes groups. */
  group: string
  slots: GridSlot[]
}

export type GridRack = {
  index: number
  baseRow: number
  type: string
  backplanes: GridBackplane[]
  teUsed: number
  teFree: number
}

export type LocationGrid = {
  racks: GridRack[]
  /** Racks and backplanes that did not fit the template's ceilings. */
  dropped: { rack: number; reason: string }[]
  warnings: string[]
}

/** Track sections a group covers. `ioExb` is `ceil(ts / 2)`, so it loses parity. */
const tsOf = (g: { ioExb: number; ts?: number }): number =>
  g.ts ?? g.ioExb * 2

/**
 * Lay the backplanes out group by group, filling racks forward only.
 *
 * The packer places by first fit, which is right for counting hardware and
 * wrong for drawing it: first fit backtracks, so a later group's small
 * backplane drops into a gap in an earlier rack and the page ends up reading
 * group A, group B, group A. That matters because ZP restarting at 1 is the
 * ONLY record of where one evaluation group ends and the next begins — an
 * interleaved page cannot be read back as the groups it actually has, and a bid
 * engineer sees counting points running 1, 2, 3, 1, 2, 4, 5 down the sheet.
 *
 * The planners never do this: all 21 reference layouts are group-contiguous.
 * So the drawing re-bins with the same first-fit rule, plus one constraint — a
 * group may not use a rack that an earlier group has already moved past.
 *
 * THE RACK COUNT IS NOT NEGOTIABLE. It is what the BoQ books, so if the extra
 * constraint would need one more rack, the pack's own layout is kept and the
 * caller is told. A readable page is worth less than a page that agrees with
 * the bill.
 */
function layOut(pack: PackResult): { bins: PlacedBackplane[][]; regrouped: boolean } {
  const flat = pack.racks.flatMap((r) => r.backplanes)
  const order: string[] = []
  for (const bp of flat) if (!order.includes(bp.group)) order.push(bp.group)
  const sorted = [...flat].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))

  const capacityTe = pack.racks[0]?.spec.te ?? 84
  const bins: PlacedBackplane[][] = []
  const usedTe: number[] = []
  const usedSlots: number[] = []
  let floor = 0
  let current: string | null = null
  let highest = 0

  for (const bp of sorted) {
    if (bp.group !== current) { floor = highest; current = bp.group }
    let idx = -1
    for (let i = floor; i < bins.length; i++) {
      if (usedTe[i]! + bp.spec.te <= capacityTe
        && usedSlots[i]! + bp.contents.length <= SLOTS_PER_RACK) { idx = i; break }
    }
    if (idx < 0) { bins.push([]); usedTe.push(0); usedSlots.push(0); idx = bins.length - 1 }
    bins[idx]!.push(bp)
    usedTe[idx]! += bp.spec.te
    usedSlots[idx]! += bp.contents.length
    highest = Math.max(highest, idx)
  }

  if (bins.length !== pack.rackCount) {
    return { bins: pack.racks.map((r) => r.backplanes), regrouped: false }
  }
  return { bins, regrouped: true }
}

/**
 * Draw a packed location.
 *
 * `groups` supplies each group's track-section count, which the pack result
 * cannot carry: `ioExb` is `ceil(ts / 2)` and a group of 7 track sections and
 * one of 8 both pack to 4 boards. The last I/O board of an odd group takes one
 * FMA number rather than two, and that is what makes the sheet's own
 * `AO3` — its relay-output-section total — come out equal to TS.
 */
export function buildGrid(
  pack: PackResult,
  groups: { id: string; ioExb: number; ts?: number }[],
  locationName = 'this location',
): LocationGrid {
  const warnings: string[] = []
  const dropped: { rack: number; reason: string }[] = []

  // --- counters, per group -------------------------------------------------
  //
  // ZP restarts at 1 in every evaluation group; that restart is the ONLY thing
  // recording where one group ends and the next begins, and it is how
  // `extract_layouts.py` recovers the structure. FMA likewise runs 1..ts within
  // the group.
  const zpNext = new Map<string, number>()
  const fmaNext = new Map<string, number>()
  const tsLeft = new Map<string, number>()
  for (const g of groups) {
    zpNext.set(g.id, 1)
    fmaNext.set(g.id, 1)
    tsLeft.set(g.id, tsOf(g))
  }

  const racks: GridRack[] = []
  const seenGroupRun: string[] = []
  const { bins, regrouped } = layOut(pack)
  const rackSpec = pack.racks[0]?.spec

  bins.forEach((contents, ri) => {
    if (ri >= LIVE_BLOCKS) {
      dropped.push({
        rack: ri + 1,
        reason: `only ${LIVE_BLOCKS} rack blocks are usable on a location sheet`,
      })
      return
    }
    const baseRow = BLOCK0 + ri * PERIOD
    const backplanes: GridBackplane[] = []
    let col = COL_FIRST

    for (const bp of contents) {
      const width = bp.contents.length
      if (col + width - 1 > COL_LAST) {
        dropped.push({
          rack: ri + 1,
          reason: `${bp.spec.code} needs ${width} slots and only `
            + `${COL_LAST - col + 1} of the sheet's ${SLOTS_PER_RACK} remain`,
        })
        continue
      }
      if (seenGroupRun[seenGroupRun.length - 1] !== bp.group) seenGroupRun.push(bp.group)

      const slots: GridSlot[] = bp.contents.map((board, k) => {
        const slot: GridSlot = {
          col: colName(col + k), board, te: TE_OF[board], zp: null, fma: [],
        }
        if (board === 'AEB') {
          const n = zpNext.get(bp.group) ?? 1
          slot.zp = n
          zpNext.set(bp.group, n + 1)
        } else if (board === 'IO-EXB' || board === 'CO-EXB') {
          // Two track sections per board, and one on the last where TS is odd.
          const left = tsLeft.get(bp.group) ?? 0
          const take = Math.min(2, left)
          const from = fmaNext.get(bp.group) ?? 1
          for (let i = 0; i < take; i++) slot.fma.push(from + i)
          fmaNext.set(bp.group, from + take)
          tsLeft.set(bp.group, left - take)
        }
        return slot
      })

      const head = bp.contents[0]
      backplanes.push({
        code: bp.spec.code,
        startCol: colName(col),
        pscVersion: bp.spec.kind === 'PWR'
          ? (head === 'spare-PSC' ? 'NE' : 'R1')
          : null,
        canIn: CAN_OF[bp.spec.code]?.in ?? false,
        canOut: CAN_OF[bp.spec.code]?.out ?? false,
        group: bp.group,
        slots,
      })
      col += width
    }

    const teUsed = backplanes.reduce(
      (a, b) => a + b.slots.reduce((s, x) => s + x.te, 0), 0)
    racks.push({
      index: ri + 1, baseRow, type: rackSpec?.code ?? 'BGT07', backplanes,
      teUsed, teFree: (rackSpec?.te ?? 84) - teUsed,
    })
  })

  // --- the checks that keep the drawing readable back -----------------------
  if (!regrouped && new Set(pack.racks.flatMap((r) => r.backplanes.map((b) => b.group))).size > 1) {
    warnings.push(
      `${locationName}: the drawing keeps the packer's own rack assignment because laying `
      + `the groups out contiguously would need another rack, and the rack count is what the `
      + `bill books. Counting-point numbering may not read back as one run per group.`,
    )
  }
  if (pack.racks.length > LIVE_BLOCKS) {
    warnings.push(
      `${locationName} packs into ${pack.racks.length} racks and a location sheet holds `
      + `${LIVE_BLOCKS} — blocks 5 to 8 were deliberately emptied ("maximum 4 BGT only can be `
      + `mounted in India environmental condition", Rev!C5). Declare an equipment room to `
      + `split it across two sheets.`,
    )
  }
  for (const d of dropped) {
    warnings.push(`${locationName} rack ${d.rack}: ${d.reason}, so it was not drawn`)
  }

  // A group whose backplanes are not contiguous in reading order cannot be read
  // back: the extractor recovers groups by watching ZP restart at 1, so an
  // interleaved layout would be parsed as more groups than there are. It has
  // never happened on real input; it is checked rather than assumed.
  const runs = new Set<string>()
  for (const g of seenGroupRun) {
    if (runs.has(g)) {
      warnings.push(
        `${locationName}: evaluation group ${g} is split across the drawing by another `
        + `group, so its counting-point numbering will not read back as one group.`,
      )
    }
    runs.add(g)
  }

  // Only worth saying when the drawing is otherwise complete. Where a rack was
  // dropped its I/O boards went with it, and the dropped-rack warning above
  // already accounts for every number that follows from it.
  if (dropped.length === 0) {
    for (const [id, left] of tsLeft) {
      if (left > 0) {
        warnings.push(
          `${locationName}: group ${id} has ${left} track section(s) with no I/O board slot `
          + `to number them under, so the sheet's track-section total will be short.`,
        )
      }
    }
  }

  return { racks, dropped, warnings }
}

/**
 * What the sheet's own COUNTIF band will make of a drawing.
 *
 * Row 3 of a location sheet is fed by per-block `COUNTIF`s over the token row and
 * the backplane row, and `Gesamt` reads row 3. Recomputing them here — from the
 * same literals the writer puts in the file — is how a generated workbook is
 * checked without asking Excel to recalculate it first.
 */
export function tallyGrid(grid: LocationGrid): Record<string, number> {
  const out: Record<string, number> = {
    racks: grid.racks.length, aeb: 0, ioExb: 0, psc: 0, pscR: 0, comAdc: 0,
    comXxx: 0, spare: 0, spareIo: 0, sparePsc: 0, leer: 0, coExb: 0,
    trackSections: 0, connector: 0,
  }
  for (const b of ['BP-PWR-0', 'BP-PWR-4', 'BP-PWR-8', 'BP-EXB-1', 'BP-EXB-2', 'BP-EXB-4']) {
    out[b] = 0
  }
  const KEY: Record<string, string> = {
    'AEB': 'aeb', 'IO-EXB': 'ioExb', 'PSC': 'psc', 'PSC-R': 'pscR',
    'COM-AdC': 'comAdc', 'COM-xxx': 'comXxx', 'CO-EXB': 'coExb',
    'leer': 'leer', 'spare': 'spare', 'spare IO': 'spareIo', 'spare-PSC': 'sparePsc',
  }
  for (const r of grid.racks) {
    for (const bp of r.backplanes) {
      out[bp.code] = (out[bp.code] ?? 0) + 1
      for (const s of bp.slots) {
        const k = KEY[s.board]
        if (k) out[k] = (out[k] ?? 0) + 1
        out.trackSections! += s.fma.length
      }
    }
  }
  // The sheet's own AL3, and the reason BD BOM row 43 is wrong: it is weighted
  // by the extension backplane's slot count, not equal to the I/O board count.
  out.connector = out['BP-EXB-1']! * 1 + out['BP-EXB-2']! * 2 + out['BP-EXB-4']! * 4
  // AF3 = SUM(PSC) + AM3, where AM3 is the PSC-R total.
  out.pscTotal = out.psc! + out.pscR!
  return out
}
