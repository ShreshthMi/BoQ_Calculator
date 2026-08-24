/**
 * Domain model for the FAdC R2 rack packer.
 *
 * Zero dependencies, no DOM, no I/O — this module lifts unchanged into the app
 * or a service. Node's type stripping runs it directly, so no enums, no
 * parameter properties and no namespaces.
 */

/**
 * A caller-supplied label for which independent evaluation system a board serves.
 *
 * METADATA ONLY — the packer never branches on it. The slot grid records no such
 * field: there is nothing in the workbook that marks a system as main or
 * redundant. What the grid does record is that systems exist and are separate
 * (each has its own ZP numbering restarting at 1), which is what the packer acts
 * on. Whether two systems form a main/redundant pair is a project fact the
 * caller knows and the workbook does not.
 *
 * On this tender: ABS locations carry 2 or 4 identical mirrored systems, which
 * is consistent with redundancy. Yard locations carry 1 to 3 systems of
 * irregular size — Chaksu is 17 + 14 AEB, the down and up lines — which is
 * plainly not redundancy. Same mechanism, different meaning.
 */
export type SystemId = 'MAIN' | 'REDUNDANT'

/** Tokens the workbook writes into the slot grid, row 58. */
export type BoardToken =
  | 'PSC' | 'PSC-R'
  | 'COM-AdC' | 'COM-xxx'
  | 'AEB'
  | 'IO-EXB' | 'CO-EXB'
  | 'leer' | 'spare' | 'spare IO' | 'spare-PSC'

/** Slot pitch in TE, read from the workbook's own lookup on sheet '01' row 59. */
export const TE_OF: Record<BoardToken, number> = {
  'PSC': 8, 'PSC-R': 8, 'spare-PSC': 8,
  'COM-AdC': 4, 'COM-xxx': 4, 'AEB': 4, 'leer': 4, 'spare': 4,
  'IO-EXB': 6, 'CO-EXB': 6, 'spare IO': 6,
}

export type BackplaneKind = 'PWR' | 'EXB'

/**
 * Backplane geometry.
 *
 * BP-PWR-n: one 8 TE PSC slot + n slots of 4 TE, each holding an AEB *or* a COM
 *           board                                             => 8 + 4n TE
 * BP-EXB-n: one 4 TE slot holding an AEB + n slots of 6 TE,
 *           each holding an IO-EXB                            => 4 + 6n TE
 *
 * Every BP-EXB therefore carries an AEB, which couples the two decompositions.
 */
export type BackplaneSpec = {
  code: string
  kind: BackplaneKind
  /** n, the variant number in the part name. */
  n: number
  te: number
  /** PSC boards required to energise it. */
  psc: number
  /** 4 TE slots that accept an AEB or a COM board. */
  slots4: number
  /** 6 TE slots that accept an IO-EXB. */
  slots6: number
  /** IN Item Code (Sales Cloud), or null where no part number exists. */
  partCode: string | null
}

const pwr = (n: number, partCode: string | null): BackplaneSpec => ({
  code: `BP-PWR-${n}`, kind: 'PWR', n, te: 8 + 4 * n, psc: 1, slots4: n, slots6: 0, partCode,
})

const exb = (n: number, partCode: string | null): BackplaneSpec => ({
  code: `BP-EXB-${n}`, kind: 'EXB', n, te: 4 + 6 * n, psc: 0, slots4: 1, slots6: n, partCode,
})

/**
 * The variants that carry an orderable part number. The workbook models many
 * more (PWR 1/2/3/6/10/12/14/16, EXB 0/3/6/8/10/12) but they cannot be put on a
 * BoQ, so the packer must not emit them.
 */
export const BACKPLANES: BackplaneSpec[] = [
  pwr(0, '100031'),
  pwr(4, '100391'),
  pwr(8, '100030'),
  exb(1, '100028'),
  exb(2, '100392'),
  exb(4, '100393'),
]

export const PWR_VARIANTS = BACKPLANES.filter((b) => b.kind === 'PWR' && b.slots4 > 0)
export const EXB_VARIANTS = BACKPLANES.filter((b) => b.kind === 'EXB')

export type RackSpec = { code: string; te: number; partCode: string | null }

export const BGT07: RackSpec = { code: 'BGT07', te: 84, partCode: '100049' }
export const BGT08: RackSpec = { code: 'BGT08', te: 42, partCode: '100948' }

/** Per-location demand, already split by detection system. */
export type Demand = {
  /** Evaluation boards, one per detection point. */
  aeb: number
  /** In-/output boards; the caller derives these as ceil(TS / 2) plus any
   *  data-transmission allowance. */
  ioExb: number
  /** Communication boards. Not derivable from DP/TS — see rule G36. */
  com: number
}

export type PackOptions = {
  /**
   * Extra 4 TE slots to leave free per system, as a percentage of AEB demand.
   * The workbook's equivalent is the 'spare'/'leer' tokens a planner leaves in
   * the grid.
   */
  spareSlotPct: number
  /** Rack variant to pack into. */
  rack: RackSpec
  /**
   * Largest BP-EXB variant the project permits, as IO slots.
   *
   * Single detection caps at BP-EXB-2; dual detection allows BP-EXB-4. The
   * reference project is unambiguous: the Yard workbook (single) books zero
   * BP-EXB-4 across all thirteen locations, while ABS (dual) books ten.
   */
  maxExbSlots: number
  /**
   * When true, main and redundant boards may not share a backplane, and each
   * system carries its own COM board. Racks stay mixed either way.
   */
  separateSystems: boolean
}

export const DEFAULT_OPTIONS: PackOptions = {
  spareSlotPct: 0,
  rack: BGT07,
  maxExbSlots: 4,
  separateSystems: true,
}

/** One backplane as placed by the packer. */
export type PlacedBackplane = {
  spec: BackplaneSpec
  system: SystemId
  /** Which group owns it. No backplane ever mixes groups. */
  group: string
  /** Boards seated in this backplane's slots, in slot order. */
  contents: BoardToken[]
  aeb: number
  ioExb: number
  com: number
  /** 1 where this backplane carries the group's power supply, else 0. */
  psc: number
  /** 1 where its power slot is blanked instead. */
  sparePsc: number
  /** 4 TE slots left empty. */
  freeSlots4: number
  /** 6 TE slots left empty. */
  freeSlots6: number
}

export type PackedRack = {
  index: number
  spec: RackSpec
  backplanes: PlacedBackplane[]
  teUsed: number
  teFree: number
}

export type PackResult = {
  racks: PackedRack[]
  /** Backplane code -> count, for the BoQ. */
  backplaneCounts: Record<string, number>
  rackCount: number
  psc: number
  /** Unequipped PSC slots; each bills as two 4 TE blanking plates. */
  sparePsc: number
  aebSeated: number
  ioExbSeated: number
  comSeated: number
  /** Leftover TE across all racks, which becomes blanking plates. */
  blankingTe: number
  /** Populated when demand could not be satisfied. */
  warnings: string[]
}

export const emptyCounts = (): Record<string, number> =>
  Object.fromEntries(BACKPLANES.map((b) => [b.code, 0]))
