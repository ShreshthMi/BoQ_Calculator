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
 *
 * TWO THINGS THE GUIDELINE NEEDS AND THE INPUT SHEET CANNOT GIVE IT.
 *
 * The mix keys on the APPLICATION, and the sheet records only a scope. Yard
 * means station and ABS means auto block on this tender, so that is the default
 * — but it is a default, and the IBH and absolute-block rows of the guideline
 * are unreachable without saying so per location. `Location.application` says it.
 *
 * And the whole table is a stated default for missing information, not a
 * measurement. Once the real cable plan exists it should be switched OFF rather
 * than overridden line by line, otherwise a dormant guideline sits underneath
 * the BoQ quietly contradicting three of its lines. `CableSource = 'measured'`
 * does exactly that: the percentages below are not consulted at all, the counts
 * come from the plan, and a location whose runs have not been counted yet blanks
 * the three kit lines rather than quietly filling them with an estimate.
 */
import {
  cableTotal, locationLabel,
  type Application, type CableSource, type Location,
} from './project.ts'

export type { Application } from './project.ts'

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
    default:
      // Unreachable through `buildProject`, which always fills the field in.
      // Naming the value beats returning undefined and multiplying by it.
      throw new Error(`unknown application '${application as string}'`)
  }
}

export type CableSplit = {
  /** Null where a measured plan is incomplete — a flagged blank, never a zero. */
  m5: number | null
  m10: number | null
  m15: number | null
  /** Unrounded guideline totals, so the rounding step is inspectable. */
  raw: { m5: number; m10: number; m15: number }
  total: number | null
  source: CableSource
  /**
   * What the guideline says, computed either way so a measured plan can be read
   * against the default it replaced rather than silently superseding it.
   */
  guideline: { m5: number; m10: number; m15: number; total: number }
  /** Locations carrying detection points but no measured runs. */
  unmeasured: string[]
  /**
   * Locations whose counted runs do not add up to their detection points.
   *
   * Blanking on these is not pedantry. Every detection point takes exactly one
   * trackside kit, so `K01 + K02 + K03` has to equal what `G05` books for
   * sensors. A plan that is 10 runs short would put a BoQ into print
   * contradicting its own sensor line.
   */
  mismatched: string[]
}

/**
 * Round three fractional shares to whole runs that still total `total`.
 *
 * The 15 m bucket used to absorb all the drift on its own — `m15 = total - m5 -
 * m10` — which is fine until both of the others round up. Two shares landing on
 * .5 inflate by half a unit each and the absorber pays for both, and with a
 * small enough 15 m share it pays more than it has: a NEGATIVE quantity on a BoQ
 * line. Reachable in 200 of the 3,200 single-location cases across the four
 * applications, both detections and 1–400 detection points.
 *
 * So round all three, then settle the difference against whichever bucket
 * rounding moved furthest — largest remainder first when runs must be added,
 * largest downward pressure first when they must be taken back, and never below
 * zero. Every detection point still gets exactly one kit.
 */
function shareOut(
  raw: { m5: number; m10: number; m15: number },
  total: number,
): { m5: number; m10: number; m15: number; total: number } {
  const keys = ['m5', 'm10', 'm15'] as const
  const out = { m5: Math.round(raw.m5), m10: Math.round(raw.m10), m15: Math.round(raw.m15) }
  let drift = total - (out.m5 + out.m10 + out.m15)
  // Settle a unit at a time against the bucket with the most claim on it.
  for (let guard = 0; drift !== 0 && guard < 8; guard++) {
    const step = drift > 0 ? 1 : -1
    const candidates = keys
      .filter((k) => step > 0 || out[k] > 0)
      .sort((a, b) => (raw[b] - out[b]) * step - (raw[a] - out[a]) * step)
    const pick = candidates[0]
    if (!pick) break
    out[pick] += step
    drift -= step
  }
  return { ...out, total: out.m5 + out.m10 + out.m15 }
}

/**
 * Split the project's detection points across the three tail lengths.
 *
 * Under the guideline, fractions are accumulated across the whole project and
 * rounded once at the end. Rounding per location instead would drift: eighteen
 * separate roundings of a 75/15/10 split do not sum to the same answer.
 */
export function splitByLength(
  locations: Location[],
  source: CableSource = 'guideline',
): CableSplit {
  const raw = { m5: 0, m10: 0, m15: 0 }
  for (const loc of locations) {
    const app = loc.application ?? (loc.scope === 'YARD' ? 'STATION' : 'AUTO_BLOCK')
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
  const gTotal = Math.round(raw.m5 + raw.m10 + raw.m15)
  const guideline = shareOut(raw, gTotal)

  // A location with detection points and no runs counted against them has not
  // been measured — and neither has one whose counts are all still zero, which
  // is the same absence of information wearing a number.
  const unmeasured = locations
    .filter((l) => l.totalDp > 0 && cableTotal(l.cable) === 0)
    .map((l) => locationLabel(l, locations))
  const mismatched = locations
    .filter((l) => cableTotal(l.cable) > 0 && cableTotal(l.cable) !== l.totalDp)
    .map((l) => locationLabel(l, locations))

  if (source !== 'measured') {
    return {
      ...guideline, raw, total: gTotal,
      source: 'guideline', guideline, unmeasured, mismatched,
    }
  }

  // Measured. No percentage is applied to anything; these are counted runs — and
  // a plan that is not finished is a blank, not a smaller number.
  if (unmeasured.length > 0 || mismatched.length > 0) {
    return {
      m5: null, m10: null, m15: null,
      raw, total: null, source: 'measured', guideline, unmeasured, mismatched,
    }
  }
  const m5 = locations.reduce((a, l) => a + (l.cable?.m5 ?? 0), 0)
  const m10 = locations.reduce((a, l) => a + (l.cable?.m10 ?? 0), 0)
  const m15 = locations.reduce((a, l) => a + (l.cable?.m15 ?? 0), 0)
  return {
    m5, m10, m15, raw, total: m5 + m10 + m15,
    source: 'measured', guideline, unmeasured, mismatched,
  }
}
