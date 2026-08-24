/**
 * The cable-length split — how 550 detection points divide across the 5 m,
 * 10 m and 15 m tail-cable variants, and therefore across the three trackside
 * kit codes the BoQ actually books.
 *
 * This is NOT in either calculator. BD BOM rows 6/7 (10 m and 15 m sensor) and
 * 9/10 (9.8 m and 14.8 m tube) carry no formula in any location column of either
 * workbook, and Gesamt has a single undifferentiated 'Wheel sensor' line. There
 * is no length dimension anywhere in the calculator.
 *
 * It IS written down, though — handover sheet `4. Project Questionnairre`,
 * cell B151, item 16, "Cable Length if not specified in tender document":
 *
 *   Station application
 *     single detection            75 % of 5 m, 15 % of 10 m, 10 % of 15 m
 *     dual, main system           75 % of 5 m, 15 % of 10 m, 10 % of 15 m
 *     dual, redundant system      75 % of 10 m, 25 % of 15 m
 *   Auto block application        50 % of 5 m, 50 % of 10 m
 *   IBH / absolute block
 *     single detection            all 5 m
 *     dual detection              50 % of 5 m, 50 % of 10 m
 *
 * Applied to this tender it yields 369 / 144 / 37, which is exactly what the
 * hidden older BoQ sheet books. The shipped sheet reads 350 / 163 / 37 — a hand
 * adjustment of 19 units from 5 m to 10 m, made after the fact and recorded
 * nowhere. That delta is an override, and the tool can now show it as one.
 */
import type { Location } from './import.ts'

export type Application = 'STATION' | 'AUTO_BLOCK' | 'IBH' | 'ABSOLUTE_BLOCK'

/** Fractions of detection points at 5 m / 10 m / 15 m tail length. */
export type LengthMix = { m5: number; m10: number; m15: number }

const STATION_MAIN: LengthMix = { m5: 0.75, m10: 0.15, m15: 0.10 }
const STATION_REDUNDANT: LengthMix = { m5: 0, m10: 0.75, m15: 0.25 }
const HALF: LengthMix = { m5: 0.5, m10: 0.5, m15: 0 }
const ALL_5M: LengthMix = { m5: 1, m10: 0, m15: 0 }

/**
 * The mix for one system of one location.
 * `redundant` selects the second half of a dual-detection station.
 */
export function mixFor(
  application: Application,
  detection: 'SINGLE' | 'DUAL',
  redundant: boolean,
): LengthMix {
  switch (application) {
    case 'STATION':
      return detection === 'DUAL' && redundant ? STATION_REDUNDANT : STATION_MAIN
    case 'AUTO_BLOCK':
      return HALF
    case 'IBH':
    case 'ABSOLUTE_BLOCK':
      return detection === 'SINGLE' ? ALL_5M : HALF
  }
}

export type CableSplit = {
  m5: number
  m10: number
  m15: number
  /** Unrounded totals, so the rounding step is inspectable. */
  raw: { m5: number; m10: number; m15: number }
  total: number
}

/**
 * Split the project's detection points across the three tail lengths.
 *
 * Fractions are accumulated across the whole project and rounded once at the
 * end. Rounding per location instead would drift: eighteen separate roundings
 * of a 75/15/10 split do not sum to the same answer.
 */
export function splitByLength(locations: Location[]): CableSplit {
  const raw = { m5: 0, m10: 0, m15: 0 }
  for (const loc of locations) {
    const app: Application = loc.scope === 'YARD' ? 'STATION' : 'AUTO_BLOCK'
    if (loc.detection === 'DUAL') {
      // main and redundant halves can take different mixes
      const half = loc.totalDp / 2
      for (const redundant of [false, true]) {
        const m = mixFor(app, 'DUAL', redundant)
        raw.m5 += half * m.m5
        raw.m10 += half * m.m10
        raw.m15 += half * m.m15
      }
    } else {
      const m = mixFor(app, 'SINGLE', false)
      raw.m5 += loc.totalDp * m.m5
      raw.m10 += loc.totalDp * m.m10
      raw.m15 += loc.totalDp * m.m15
    }
  }
  const m5 = Math.round(raw.m5)
  const m10 = Math.round(raw.m10)
  // The longest length absorbs any rounding drift so the three always sum to DP.
  const total = Math.round(raw.m5 + raw.m10 + raw.m15)
  const m15 = total - m5 - m10
  return { m5, m10, m15, raw, total }
}
