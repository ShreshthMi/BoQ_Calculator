/**
 * Rack packing under the main/redundant separation constraint.
 *
 * The constraint, as stated by the Bid team:
 *   "Main and redundant AEBs will NOT share a backplane. They CAN share a rack
 *    when in a different backplane with a different COM board."
 *
 * The workbook bears this out and generalises it. Every location's slot grid is
 * laid out as one or more GROUPS — independent evaluation systems, each with its
 * own contiguous ZP (counting point) numbering restarting at 1. A group owns its
 * backplanes outright and racks freely span group boundaries. Jaipur JN puts two
 * whole groups in one rack; ALH-1 rack 2 holds the tail of group A and the head
 * of group B.
 *
 * Verified exhaustively across both workbooks: at all 21 configured locations,
 * ZERO backplanes carry boards from more than one group, and 7 racks host two
 * groups on separate backplanes — the permitted case.
 *
 * So the group, not the board, is the unit of separation. Note that the grid
 * does not say which groups are main and which redundant; see SystemId. The
 * separation rule holds either way, which is why the packer keys on the group.
 */
import {
  type Demand, type PackOptions, type PackResult, type PackedRack,
  type PlacedBackplane, type SystemId, DEFAULT_OPTIONS, emptyCounts,
} from './types.ts'
import { decomposeGroup, materialise, type Objective } from './decompose.ts'

/** One independent evaluation domain: its own ZP numbering, its own COM board. */
export type Group = Demand & {
  id: string
  system: SystemId
  /**
   * Power supplies to equip in this group's BP-PWR backplanes. Defaults to 1.
   *
   * NOT DERIVABLE. The workbook places PSC and spare-PSC tokens into the grid by
   * hand and then FEEDS them into its current calculation (Gesamt rows 69/70 use
   * the PSC count as an input, at 38 mA each) rather than deriving them from it.
   * One per group holds at all eight ABS locations and at none of the thirteen
   * Yard ones, where larger groups carry two. Like the COM count and the group
   * structure itself, this is a planner decision the packer should not invent.
   */
  psc?: number
}

export type PackInput = {
  groups: Group[]
  options?: Partial<PackOptions>
  objective?: Objective
}

/**
 * HOW MANY GROUPS A LOCATION HAS IS AN INPUT, NOT A DERIVATION.
 *
 * The reference project is not consistent about it. ALH-2 splits into four
 * groups — down and up line, each mirrored main and redundant — with ten
 * counting points and one COM board apiece. Jaipur JN has the same down/up
 * structure but uses only two groups, folding both directions into one. Both are
 * valid; the planner chooses, bounded by the 80-participant CAN ceiling.
 *
 * That is the same decision as the COM count, which is rule G36 — the one driver
 * that could not be recovered from the workbook. Guessing it here would bury an
 * open question inside an algorithm, so the caller supplies the groups and the
 * helpers below only cover the two shapes actually seen.
 */

/** Per-line detection-point and track-section counts for the MAIN system. */
export type LineCounts = { dp: number; ts: number }

/** Default IO-EXB derivation: one board drives two track sections. */
export const ioForTs = (ts: number): number => Math.ceil(ts / 2)

/**
 * One group per system: down and up folded together. The shape at Jaipur JN,
 * Durgapura's larger racks, Sanganer and Sheodaspura.
 */
export function splitDemand(total: Demand, detection: 'SINGLE' | 'DUAL'): Group[] {
  if (detection === 'SINGLE') return [{ id: 'G1', system: 'MAIN', ...total }]
  const half = (n: number) => Math.floor(n / 2)
  const rest = (n: number) => n - half(n)
  return [
    { id: 'G1', system: 'MAIN', aeb: rest(total.aeb), ioExb: rest(total.ioExb), com: rest(total.com) },
    { id: 'G2', system: 'REDUNDANT', aeb: half(total.aeb), ioExb: half(total.ioExb), com: half(total.com) },
  ]
}

/**
 * One group per line direction per system — four groups under dual detection.
 * The shape at ALH-2 and ALH-3. Counts given are MAIN-side; dual detection
 * mirrors them.
 */
export function groupsFromLines(
  lines: { dn?: LineCounts; up?: LineCounts },
  detection: 'SINGLE' | 'DUAL',
  comPerGroup = 1,
): Group[] {
  const systems: SystemId[] = detection === 'DUAL' ? ['MAIN', 'REDUNDANT'] : ['MAIN']
  const out: Group[] = []
  for (const system of systems) {
    for (const dir of ['dn', 'up'] as const) {
      const line = lines[dir]
      if (!line || (line.dp === 0 && line.ts === 0)) continue
      out.push({
        id: `${dir.toUpperCase()}-${system === 'MAIN' ? 'M' : 'R'}`,
        system,
        aeb: line.dp,
        ioExb: ioForTs(line.ts),
        com: comPerGroup,
      })
    }
  }
  return out
}

/**
 * Pack groups into racks.
 *
 * Backplanes are emitted group by group and placed by first fit across open
 * racks, so a rack may carry the tail of one group and the head of the next —
 * which is exactly what the reference layouts do.
 */
export function pack(input: PackInput): PackResult {
  const opts: PackOptions = { ...DEFAULT_OPTIONS, ...(input.options ?? {}) }
  const objective = input.objective ?? 'fewest-backplanes'
  const warnings: string[] = []

  if (opts.separateSystems) {
    const systems = new Set(input.groups.map((g) => g.system))
    const comless = input.groups.filter((g) => g.com === 0)
    if (systems.size > 1 && comless.length > 0) {
      warnings.push(
        `separateSystems is on but ${comless.length} group(s) carry no COM board ` +
        `(${comless.map((g) => g.id).join(', ')}). The stated rule wants one per ` +
        `system; the reference project shares a single COM at several locations.`,
      )
    }
  }

  const placed: PlacedBackplane[] = []
  for (const g of input.groups) {
    const spare = Math.ceil((g.aeb * opts.spareSlotPct) / 100)
    const dec = decomposeGroup({ ...g, aeb: g.aeb + spare }, objective, opts.maxExbSlots)
    placed.push(
      ...materialise(dec, { ...g, aeb: g.aeb + spare }, g.system, g.id, g.psc ?? 1),
    )
  }

  const racks: PackedRack[] = []
  for (const bp of placed) {
    if (bp.spec.te > opts.rack.te) {
      warnings.push(`${bp.spec.code} is ${bp.spec.te} TE and cannot fit a ${opts.rack.code}`)
      continue
    }
    let target = racks.find((r) => r.teFree >= bp.spec.te)
    if (!target) {
      target = { index: racks.length + 1, spec: opts.rack, backplanes: [], teUsed: 0, teFree: opts.rack.te }
      racks.push(target)
    }
    target.backplanes.push(bp)
    target.teUsed += bp.spec.te
    target.teFree -= bp.spec.te
  }

  const backplaneCounts = emptyCounts()
  let psc = 0
  let sparePsc = 0
  for (const bp of placed) {
    backplaneCounts[bp.spec.code] = (backplaneCounts[bp.spec.code] ?? 0) + 1
    psc += bp.psc
    sparePsc += bp.sparePsc
  }

  return {
    racks,
    backplaneCounts,
    rackCount: racks.length,
    psc,
    sparePsc,
    aebSeated: placed.reduce((a, b) => a + b.aeb, 0),
    ioExbSeated: placed.reduce((a, b) => a + b.ioExb, 0),
    comSeated: placed.reduce((a, b) => a + b.com, 0),
    blankingTe: racks.reduce((a, r) => a + r.teFree, 0),
    warnings,
  }
}

/** Convenience: pack a location given totals and a detection mode. */
export function packLocation(
  total: Demand,
  detection: 'SINGLE' | 'DUAL',
  options?: Partial<PackOptions>,
  objective?: Objective,
): PackResult {
  return pack({ groups: splitDemand(total, detection), options, objective })
}
