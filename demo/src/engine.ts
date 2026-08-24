/**
 * Stage 2 + 4 — board demand, then the rule engine.
 *
 * Demand and packing run per location; rules then evaluate against project-level
 * drivers plus the packer's aggregate output. Rules that reference another
 * part's quantity (`part(BD041) * 0.01`) run after their referent, resolved by
 * topological order rather than by hoping the file is sorted.
 */
import { pack, ioForTs, type Group } from '../../packer/src/packer.ts'
import { allocateCubicles, type CubicleAllocation } from '../../packer/src/cubicle.ts'
import type { PackResult, SystemId } from '../../packer/src/types.ts'
import { evaluate, applyRounding, partRefs, identifiers, type Rounding } from './expr.ts'
import { splitByLength } from './cable.ts'
import type { Location, Project } from './import.ts'

export type SeedRule = {
  id: string
  part: string | null
  partKey: string | null
  partDescription: string | null
  partMissing: boolean
  group: string
  driver: string
  /** 'location' rules are evaluated per location and summed; see runRules. */
  scope?: 'location' | 'project'
  expression: string
  rounding: Rounding
  condition?: string
  split?: { part: string | null; partKey: string; pct: number }[]
  confidence: string
  prototypeRule: string | null
  source: string | null
  note?: string
}

export type Declarations = {
  cubiclesEnabled: boolean
  fdsRequired: boolean
  planningIncluded: boolean
  sparesIncluded: boolean
  powerAbove120W: boolean
  /** IO-EXB boards for data transmission, over and above ceil(TS / 2). */
  dataTransmissionIO: number
  /** COM boards per group. Rule G36 — not derivable, so declared. */
  comPerGroup: number
  /** PSC per group. Not derivable, so declared. */
  pscPerGroup: number
}

export const DEFAULT_DECLARATIONS: Declarations = {
  cubiclesEnabled: true,
  fdsRequired: true,
  planningIncluded: true,
  sparesIncluded: true,
  powerAbove120W: false,
  dataTransmissionIO: 0,
  comPerGroup: 1,
  pscPerGroup: 1,
}

export type LocationPlan = {
  location: Location
  groups: Group[]
  pack: PackResult
  cubicles: CubicleAllocation
}

/**
 * Group a location into independent evaluation systems.
 *
 * The reference project uses two shapes and the choice between them is a
 * planner's, not a formula's (see packer/src/packer.ts). The default reproduces
 * the shape the workbook used most often: one group per direction per system,
 * folding the directions together when a location is small enough that the
 * planner did.
 */
export function groupsFor(loc: Location, d: Declarations): Group[] {
  const systems: SystemId[] = loc.detection === 'DUAL' ? ['MAIN', 'REDUNDANT'] : ['MAIN']
  // Above this many detection points per system, the planner gives each line
  // direction its own evaluation system. ALH-1 folds at 12; ALH-2 splits at 20.
  const SPLIT_THRESHOLD = 16
  const out: Group[] = []
  for (const system of systems) {
    const tag = system === 'MAIN' ? 'M' : 'R'
    loc.sections.forEach((sec, si) => {
      const dp = sec.dn.dp + sec.up.dp
      const ts = sec.dn.ts + sec.up.ts
      if (dp === 0 && ts === 0) return
      const sTag = loc.sections.length > 1 ? `S${si + 1}-` : ''
      if (dp >= SPLIT_THRESHOLD) {
        for (const [dir, line] of [['DN', sec.dn], ['UP', sec.up]] as const) {
          if (line.dp === 0 && line.ts === 0) continue
          out.push({
            id: `${sTag}${dir}-${tag}`, system,
            aeb: line.dp, ioExb: ioForTs(line.ts),
            com: d.comPerGroup, psc: d.pscPerGroup,
          })
        }
      } else {
        out.push({
          id: `${sTag}ALL-${tag}`, system,
          aeb: dp, ioExb: ioForTs(ts),
          com: d.comPerGroup, psc: d.pscPerGroup,
        })
      }
    })
  }
  return out
}

export function planLocation(loc: Location, d: Declarations): LocationPlan {
  const groups = groupsFor(loc, d)
  // Dual detection permits BP-EXB-4; single detection caps at BP-EXB-2.
  const maxExbSlots = loc.detection === 'DUAL' ? 4 : 2
  const result = pack({ groups, options: { maxExbSlots } })
  const cubicles = allocateCubicles(result, {
    cubiclesEnabled: d.cubiclesEnabled,
    powerWatts: d.powerAbove120W ? 999 : 0,
  })
  return { location: loc, groups, pack: result, cubicles }
}

export type Drivers = Record<string, number | null>

/** Drivers for a single location — what a location-scoped rule sees. */
export function buildDriversFor(plan: LocationPlan, d: Declarations): Drivers {
  return buildDrivers(
    { totals: { dp: plan.location.totalDp, ts: plan.location.totalTs, locations: 1 } } as Project,
    [plan], d,
  )
}

/** Aggregate every driver the seeded rules can read. */
export function buildDrivers(
  project: Project,
  plans: LocationPlan[],
  d: Declarations,
): Drivers {
  const s = (f: (p: LocationPlan) => number) => plans.reduce((a, p) => a + f(p), 0)
  const bp = (code: string) => s((p) => p.pack.backplaneCounts[code] ?? 0)
  const cable = splitByLength(plans.map((p) => p.location))

  const aeb = s((p) => p.pack.aebSeated)
  const io = s((p) => p.pack.ioExbSeated)
  const com = s((p) => p.pack.comSeated)
  const racks = s((p) => p.pack.rackCount)
  const bpPwrAll = bp('BP-PWR-0') + bp('BP-PWR-4') + bp('BP-PWR-8')
  const bpExbAll = bp('BP-EXB-1') + bp('BP-EXB-2') + bp('BP-EXB-4')

  return {
    // demand
    DP: project.totals.dp,
    TS: project.totals.ts,
    AEB: aeb,
    IO_EXB: io,
    COM_ADC: com,
    COM_XXX: 0,          // never used on this tender
    PSC: s((p) => p.pack.psc),
    // structure
    locations: project.totals.locations,
    PROJECT: 1,
    racks,
    racks42: 0,          // BGT08 unused
    /**
     * The workbook's own definition, `ceil(racks / 6)` per location — which is
     * what its downstream rows consume (Gesamt row 58 wiring = row 55, row 49
     * planning = row 55). cubicle.ts also computes a capacity-based allocation
     * from the questionnaire's 15U/20U/35U limits; the two diverge above four
     * racks and the divergence is reported separately rather than resolved here.
     */
    cubicles: d.cubiclesEnabled ? s((p) => p.cubicles.excelCount) : null,
    // backplanes
    bp_pwr_0: bp('BP-PWR-0'), bp_pwr_4: bp('BP-PWR-4'), bp_pwr_8: bp('BP-PWR-8'),
    bp_exb_1: bp('BP-EXB-1'), bp_exb_2: bp('BP-EXB-2'), bp_exb_4: bp('BP-EXB-4'),
    bp_exb_8: 0,
    bp_pwr_all: bpPwrAll,
    bp_all: bpPwrAll + bpExbAll,
    psc_r: 0,            // the R2 redundant supply is never used on this tender
    // spare slots -> blanking plates
    spare_psc_slots: s((p) => p.pack.sparePsc),
    spare_aeb_slots: s((p) => p.pack.racks.reduce(
      (a, r) => a + r.backplanes.reduce((b, x) => b + x.freeSlots4, 0), 0)),
    spare_io_slots: s((p) => p.pack.racks.reduce(
      (a, r) => a + r.backplanes.reduce((b, x) => b + x.freeSlots6, 0), 0)),
    // cable-length split, from the questionnaire's guideline (see cable.ts)
    dp_5m: cable.m5,
    dp_10m: cable.m10,
    dp_15m: cable.m15,
    // declared
    dataTransmissionIO: d.dataTransmissionIO,
    // not derivable from anything in the workbook
    CABLE: null,
  }
}

export type Resolved = {
  rule: SeedRule
  qty: number | null
  /** Why there is no quantity, when there is none. */
  blockedBy: string | null
  status: 'derived' | 'blank' | 'dormant'
}

const CONDITIONS: Record<string, (d: Declarations) => boolean> = {
  cubiclesEnabled: (d) => d.cubiclesEnabled,
  fdsRequired: (d) => d.fdsRequired,
  planningIncluded: (d) => d.planningIncluded,
  sparesIncluded: (d) => d.sparesIncluded,
  powerAbove120W: (d) => d.powerAbove120W,
}

/** Take an already-parsed rules.seed.json object. */
export function parseRules(raw: { rules: SeedRule[] }): SeedRule[] {
  return raw.rules
}

/**
 * Evaluate every rule, referents first.
 *
 * `part(...)` makes the rule set a dependency graph, so it is sorted
 * topologically. A cycle is a defect in the seed and is reported rather than
 * silently broken.
 */
/**
 * Evaluate the rule set once per location and sum, which is what Gesamt does —
 * every row is computed in each location's column and totalled across. Rounding
 * makes that materially different from evaluating against project totals:
 * ceil(550 / 25) is 22, while the sum of ceil(dp / 25) over 18 locations is 18.
 *
 * Project-scoped rules are evaluated once against the aggregate context.
 */
export function runRulesOverLocations(
  rules: SeedRule[],
  perLocation: Drivers[],
  projectDrivers: Drivers,
  d: Declarations,
  overrideOf?: (partKey: string) => number | null,
): { resolved: Map<string, Resolved>; order: string[]; problems: string[] } {
  const project = runRules(rules, projectDrivers, d, overrideOf)
  if (perLocation.length === 0) return project

  // Overrides are project-level quantities, so they steer the project pass only;
  // the per-location passes see the plain derived chain.
  const locRuns = perLocation.map((dr) => runRules(rules, dr, d))
  const resolved = new Map<string, Resolved>()

  for (const [id, projRes] of project.resolved) {
    if ((projRes.rule.scope ?? 'location') === 'project') {
      resolved.set(id, projRes)
      continue
    }
    let sum: number | null = null
    let blockedBy: string | null = null
    let status: Resolved['status'] = 'derived'
    for (const run of locRuns) {
      const r = run.resolved.get(id)
      if (!r) continue
      if (r.status === 'dormant') { status = 'dormant'; blockedBy = r.blockedBy; sum = null; break }
      if (r.qty === null) { status = r.status; blockedBy = r.blockedBy; sum = null; break }
      sum = (sum ?? 0) + r.qty
    }
    resolved.set(id, { rule: projRes.rule, qty: sum, blockedBy, status })
  }
  return { resolved, order: project.order, problems: project.problems }
}

export function runRules(
  rules: SeedRule[],
  drivers: Drivers,
  d: Declarations,
  /**
   * Effective quantities from the override layer. A rule reading `part(BD005)`
   * must see the overridden number, not the derived one — a 5 % spare is 5 % of
   * what is actually being bought.
   */
  overrideOf?: (partKey: string) => number | null,
): { resolved: Map<string, Resolved>; order: string[]; problems: string[] } {
  const problems: string[] = []
  // A part's DEFINING rule is the one that produces it without referencing it.
  // Spare rules carry the same partKey as their referent ('BD005' spared from
  // 'part(BD005) * 0.05'), so indexing naively both fakes a cycle and resolves
  // part() to the wrong rule.
  const byKey = new Map<string, SeedRule>()
  for (const r of rules) {
    if (!r.partKey) continue
    const selfRef = r.expression ? partRefs(r.expression).includes(r.partKey) : false
    if (selfRef) continue
    if (!byKey.has(r.partKey)) byKey.set(r.partKey, r)
  }

  // --- topological order over part() references ---------------------------
  const order: string[] = []
  const state = new Map<string, 'open' | 'done'>()
  const visit = (r: SeedRule, trail: string[]) => {
    const st = state.get(r.id)
    if (st === 'done') return
    if (st === 'open') { problems.push(`cycle: ${[...trail, r.id].join(' -> ')}`); return }
    state.set(r.id, 'open')
    if (r.expression) {
      for (const key of partRefs(r.expression)) {
        const dep = byKey.get(key)
        if (dep) visit(dep, [...trail, r.id])
        else problems.push(`${r.id} references ${key}, which no rule produces`)
      }
    }
    state.set(r.id, 'done')
    order.push(r.id)
  }
  for (const r of rules) visit(r, [])

  // --- evaluate -----------------------------------------------------------
  const resolved = new Map<string, Resolved>()
  const byId = new Map(rules.map((r) => [r.id, r]))
  const qtyOfPart = (key: string): number | null => {
    const forced = overrideOf?.(key)
    if (forced != null) return forced
    const dep = byKey.get(key)
    if (!dep) return null
    return resolved.get(dep.id)?.qty ?? null
  }

  for (const id of order) {
    const rule = byId.get(id)!
    let qty: number | null = null
    let blockedBy: string | null = null
    let status: Resolved['status'] = 'derived'

    if (rule.condition) {
      const test = CONDITIONS[rule.condition]
      if (!test) {
        problems.push(`${rule.id}: unknown condition '${rule.condition}'`)
      } else if (!test(d)) {
        resolved.set(id, { rule, qty: null, blockedBy: `${rule.condition} is off`, status: 'dormant' })
        continue
      }
    }

    if (rule.driver === 'MANUAL' || !rule.expression) {
      resolved.set(id, { rule, qty: null, blockedBy: 'no rule exists', status: 'blank' })
      continue
    }

    try {
      for (const name of identifiers(rule.expression)) {
        if (!(name in drivers)) {
          problems.push(`${rule.id}: expression reads unknown driver '${name}'`)
        }
      }
      qty = applyRounding(
        evaluate(rule.expression, { vars: drivers, part: qtyOfPart }),
        rule.rounding,
      )
      if (qty === null) {
        status = 'blank'
        const missing = identifiers(rule.expression).filter((n) => drivers[n] === null)
        const refs = partRefs(rule.expression).filter((k) => qtyOfPart(k) === null)
        blockedBy = missing.length ? `driver unavailable: ${missing.join(', ')}`
          : refs.length ? `referenced part has no quantity: ${refs.join(', ')}`
          : 'expression yielded no value'
      }
    } catch (err) {
      problems.push(`${rule.id}: ${(err as Error).message}`)
      status = 'blank'
      blockedBy = 'expression failed to evaluate'
    }

    resolved.set(id, { rule, qty, blockedBy, status })
  }

  return { resolved, order, problems }
}
