/**
 * Cubicle allocation, fans and blanking plates — stage 3c.
 *
 * TWO RULES EXIST AND THEY DISAGREE.
 *
 * The workbook computes `Gesamt` row 55 as `ceil(BGT07 racks / 6)`, gated on the
 * project tick at `Gesamt!AI82`. The written guideline says otherwise: the
 * handover sheet's `4. Project Questionnairre` cell B151 gives cubicle capacity
 * as 15U = 1 BGT / 4 IO-EXB, 20U = 2 BGT / 10 IO-EXB, 35U = 4 BGT / 20 IO-EXB.
 * Six racks do not fit any cubicle the catalogue sells.
 *
 * The conflict is latent on this tender: no location exceeds four racks, and
 * both rules return one cubicle per location below that. It first bites at five
 * racks, where the capacity rule needs two cubicles and the workbook still says
 * one. Both are computed here so the difference is visible rather than decided
 * silently.
 */
import type { PackResult } from './types.ts'

export type CubicleSpec = {
  code: string
  name: string
  /** IN Sales Cloud code, or the RAMCO/AT code where no IN code exists. */
  partCode: string
  maxRacks: number
  maxIoExb: number
}

/**
 * Capacities from the questionnaire, not from the workbook — neither .xlsm holds
 * a capacity table, lookup or constant for any of this.
 */
export const CUBICLES: CubicleSpec[] = [
  { code: 'FAR-007-15U', name: 'Wall mount 15U', partCode: '101872', maxRacks: 1, maxIoExb: 4 },
  { code: 'FAR-004-20U', name: 'Half cubicle 20U', partCode: '101416', maxRacks: 2, maxIoExb: 10 },
  { code: 'FAR-002-35U', name: 'Floor standing 35U', partCode: '100002', maxRacks: 4, maxIoExb: 20 },
]

/** Guideline note 1: one COM board per cubicle, max 40 AEB configured per COM. */
export const MAX_AEB_PER_COM = 40

export type CubicleAllocation = {
  /** Cubicle code -> count. */
  counts: Record<string, number>
  total: number
  /** What `Gesamt` row 55 would say: ceil(racks / 6). */
  excelCount: number
  /** True where the capacity rule and the workbook formula disagree. */
  divergesFromWorkbook: boolean
  slotFans: number
  activeFans: number
  /** 4 TE-equivalent blanking plates for unequipped power slots. */
  sparePscPlates: number
  warnings: string[]
}

export type CubicleOptions = {
  /** Gesamt!AI82. When off, the workbook books no cubicles, fans or wiring. */
  cubiclesEnabled: boolean
  /** Total power draw in watts; above 120 W an active fan is fitted per cubicle. */
  powerWatts: number
}

export const DEFAULT_CUBICLE_OPTIONS: CubicleOptions = {
  cubiclesEnabled: true,
  powerWatts: 0,
}

/** `Gesamt` row 55 verbatim. */
export const excelCubicleCount = (racks: number, enabled = true): number =>
  enabled ? Math.ceil(racks / 6) : 0

/**
 * 19-inch slot fans, `Gesamt` row 57 via the step table on `'01'!BM5:BM12`.
 *
 * The table covers one to eight racks and closes to floor(n / 2). Note the
 * latent defect: there is no branch beyond eight racks, so a ninth rack silently
 * returns zero fans rather than four.
 */
export function slotFans(racks: number, enabled = true): number {
  if (!enabled || racks < 1) return 0
  if (racks > 8) return 0 // the workbook's own behaviour, reproduced deliberately
  return Math.floor(racks / 2)
}

/**
 * Allocate cubicles by first-fit-decreasing over capacity, respecting both the
 * rack limit and the IO-EXB limit — a cubicle can run out of either first.
 */
export function allocateCubicles(
  result: PackResult,
  options?: Partial<CubicleOptions>,
): CubicleAllocation {
  const opts: CubicleOptions = { ...DEFAULT_CUBICLE_OPTIONS, ...(options ?? {}) }
  const counts: Record<string, number> = Object.fromEntries(CUBICLES.map((c) => [c.code, 0]))
  const warnings: string[] = []
  const racks = result.rackCount
  const io = result.ioExbSeated
  const excelCount = excelCubicleCount(racks, opts.cubiclesEnabled)

  if (!opts.cubiclesEnabled) {
    return {
      counts, total: 0, excelCount: 0, divergesFromWorkbook: false,
      slotFans: 0, activeFans: 0,
      sparePscPlates: result.sparePsc * 2,
      warnings: ['cubiclesEnabled is off — the workbook books no cubicles, fans or wiring (Gesamt!AI82 blank)'],
    }
  }

  // Largest cubicle first: fill it to whichever limit binds, then open another.
  const largest = CUBICLES[CUBICLES.length - 1]!
  let racksLeft = racks
  let ioLeft = io
  let total = 0
  while (racksLeft > 0 || ioLeft > 0) {
    const fit = CUBICLES.find((c) => c.maxRacks >= racksLeft && c.maxIoExb >= ioLeft) ?? largest
    counts[fit.code] = (counts[fit.code] ?? 0) + 1
    total++
    racksLeft -= fit.maxRacks
    ioLeft -= fit.maxIoExb
    if (total > 64) {
      warnings.push('cubicle allocation did not converge')
      break
    }
  }

  const comNeeded = Math.ceil(result.aebSeated / MAX_AEB_PER_COM)
  if (result.comSeated < comNeeded) {
    warnings.push(
      `${result.aebSeated} AEB needs at least ${comNeeded} COM board(s) at ` +
      `${MAX_AEB_PER_COM} AEB each; ${result.comSeated} are seated`,
    )
  }
  if (result.comSeated < total) {
    warnings.push(
      `the guideline allows one COM board per cubicle; ${total} cubicle(s) but ` +
      `${result.comSeated} COM seated`,
    )
  }
  if (total !== excelCount) {
    warnings.push(
      `capacity rule gives ${total} cubicle(s), the workbook formula ` +
      `ceil(${racks}/6) gives ${excelCount}`,
    )
  }

  return {
    counts, total, excelCount,
    divergesFromWorkbook: total !== excelCount,
    slotFans: slotFans(racks, opts.cubiclesEnabled),
    activeFans: opts.powerWatts > 120 ? total : 0,
    sparePscPlates: result.sparePsc * 2,
    warnings,
  }
}
