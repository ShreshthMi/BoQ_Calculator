/**
 * Backplane decomposition for one system group.
 *
 * The crux: the PWR and EXB decompositions are COUPLED. Every BP-EXB carries one
 * 4 TE AEB slot as well as its IO-EXB slots, so choosing more (smaller) EXB
 * backplanes donates AEB slots and can remove a whole BP-PWR from the answer.
 * Optimising the two independently gets the wrong result.
 *
 * Worked example — ALH-2, one group of 10 AEB / 5 IO / 1 COM:
 *   EXB minimised alone:  {EXB-4, EXB-1}        38 TE, 2 AEB slots
 *                         -> 9 PWR slots needed -> PWR-8 + PWR-4  = 64 TE
 *                         -> 102 TE total, needs 2 racks
 *   solved jointly:       {EXB-2, EXB-2, EXB-1} 42 TE, 3 AEB slots
 *                         -> 8 PWR slots needed -> PWR-8          = 40 TE
 *                         -> 82 TE total, fits one rack
 * The workbook's own layout is the second. It is 20 TE better.
 */
import {
  type BackplaneSpec, type Demand, type PlacedBackplane, type SystemId,
  type BoardToken, PWR_VARIANTS, EXB_VARIANTS, BACKPLANES,
} from './types.ts'

export type Objective = 'fewest-backplanes' | 'least-te'

export type Decomposition = {
  /** Backplane code -> count. */
  counts: Record<string, number>
  te: number
  backplanes: number
  /**
   * BP-PWR backplanes in this decomposition, i.e. how many 8 TE power slots
   * exist. How many are actually EQUIPPED with a PSC is a separate, planner-set
   * number — see Group.psc in packer.ts. ALH-1 has four power slots across two
   * groups but only two PSC; the other two carry a 'spare-PSC' blank, which is
   * why Gesamt's spare-PSC blanking line reads 4 (two slots at two plates each).
   */
  pwrCount: number
  /** 4 TE slots left empty after seating AEB and COM. */
  freeSlots4: number
  /** 6 TE slots left empty after seating IO-EXB. */
  freeSlots6: number
}

const spec = (code: string): BackplaneSpec => {
  const s = BACKPLANES.find((b) => b.code === code)
  if (!s) throw new Error(`unknown backplane ${code}`)
  return s
}

/** Candidate EXB multisets that cover the IO demand, as [n1, n2, n4] counts. */
function exbCandidates(io: number, maxExbSlots: number): number[][] {
  const out: number[][] = []
  const max4 = maxExbSlots >= 4 ? Math.ceil(io / 4) + 1 : 0
  const max2 = maxExbSlots >= 2 ? Math.ceil(io / 2) + 1 : 0
  const max1 = io + 1
  for (let c4 = 0; c4 <= max4; c4++) {
    for (let c2 = 0; c2 <= max2; c2++) {
      for (let c1 = 0; c1 <= max1; c1++) {
        if (c4 * 4 + c2 * 2 + c1 >= io) {
          out.push([c1, c2, c4])
          break // more EXB-1 only adds TE once demand is covered
        }
      }
    }
  }
  return out
}

/** Candidate PWR multisets providing at least `slots` 4 TE slots. */
function pwrCandidates(slots: number): number[][] {
  const out: number[][] = []
  const max8 = Math.ceil(slots / 8) + 1
  const max4 = Math.ceil(slots / 4) + 1
  for (let p8 = 0; p8 <= max8; p8++) {
    for (let p4 = 0; p4 <= max4; p4++) {
      if (p8 * 8 + p4 * 4 >= slots) {
        out.push([p4, p8])
        break
      }
    }
  }
  // A group with no 4 TE demand at all still needs power: BP-PWR-0 is PSC only.
  if (slots === 0) out.push([0, 0])
  return out
}

/**
 * Exhaustively decompose one group. The search space is small — a few thousand
 * combinations at the largest location on this tender — so no solver is needed.
 */
export function decomposeGroup(
  d: Demand,
  objective: Objective = 'fewest-backplanes',
  maxExbSlots = 4,
): Decomposition {
  const aeb = Math.max(0, Math.trunc(d.aeb))
  const io = Math.max(0, Math.trunc(d.ioExb))
  const com = Math.max(0, Math.trunc(d.com))

  let best: Decomposition | null = null

  for (const [c1, c2, c4] of exbCandidates(io, maxExbSlots) as [number, number, number][]) {
    const exbCount = c1 + c2 + c4
    const exbTe = c1 * 10 + c2 * 16 + c4 * 28
    const ioCap = c1 * 1 + c2 * 2 + c4 * 4

    // Each EXB donates exactly one AEB slot. COM boards may only sit in a BP-PWR
    // slot — that is what the workbook's grids show without exception.
    const aebInExb = Math.min(exbCount, aeb)
    const need4 = aeb - aebInExb + com

    for (const [p4, p8] of pwrCandidates(need4) as [number, number][]) {
      const pwrCount = p4 + p8
      let p0 = 0
      if (pwrCount === 0) p0 = 1 // every group needs at least one PSC
      const pwrTe = p4 * 24 + p8 * 40 + p0 * 8
      const pwrSlots = p4 * 4 + p8 * 8

      const counts: Record<string, number> = {
        'BP-PWR-0': p0, 'BP-PWR-4': p4, 'BP-PWR-8': p8,
        'BP-EXB-1': c1, 'BP-EXB-2': c2, 'BP-EXB-4': c4,
      }
      const totalPwr = pwrCount + p0
      const cand: Decomposition = {
        counts,
        te: exbTe + pwrTe,
        backplanes: exbCount + totalPwr,
        pwrCount: totalPwr,
        freeSlots4: pwrSlots + exbCount - (aeb + com),
        freeSlots6: ioCap - io,
      }
      if (cand.freeSlots4 < 0 || cand.freeSlots6 < 0) continue
      if (best === null || better(cand, best, objective)) best = cand
    }
  }

  if (best === null) {
    throw new Error(
      `no decomposition for aeb=${aeb} io=${io} com=${com} maxExbSlots=${maxExbSlots}`,
    )
  }
  return best
}

function better(a: Decomposition, b: Decomposition, objective: Objective): boolean {
  // Lexicographic. Validated against the reference project: 'fewest-backplanes'
  // reproduces the human layout at ALH-1 (4 backplanes, 108 TE) where
  // 'least-te' would pick six BP-EXB-1 for 100 TE and seven backplanes.
  if (objective === 'fewest-backplanes') {
    if (a.backplanes !== b.backplanes) return a.backplanes < b.backplanes
    if (a.te !== b.te) return a.te < b.te
  } else {
    if (a.te !== b.te) return a.te < b.te
    if (a.backplanes !== b.backplanes) return a.backplanes < b.backplanes
  }
  // Final tie-break: fewer power slots (each unequipped one bills as blanking),
  // then fewer wasted board slots.
  if (a.pwrCount !== b.pwrCount) return a.pwrCount < b.pwrCount
  return a.freeSlots4 + a.freeSlots6 < b.freeSlots4 + b.freeSlots6
}

/**
 * Expand a decomposition into placed backplanes with their seated boards, in the
 * order the workbook lays them out: the PSC-bearing backplanes first, then the
 * extension backplanes largest first.
 */
export function materialise(
  dec: Decomposition,
  d: Demand,
  system: SystemId,
  group: string,
  pscCount = 1,
): PlacedBackplane[] {
  const order = ['BP-PWR-8', 'BP-PWR-4', 'BP-PWR-0', 'BP-EXB-4', 'BP-EXB-2', 'BP-EXB-1']
  let aebLeft = Math.max(0, Math.trunc(d.aeb))
  let ioLeft = Math.max(0, Math.trunc(d.ioExb))
  let comLeft = Math.max(0, Math.trunc(d.com))
  let pscLeft = Math.min(pscCount, dec.pwrCount)
  const out: PlacedBackplane[] = []

  for (const code of order) {
    for (let i = 0; i < (dec.counts[code] ?? 0); i++) {
      const s = spec(code)
      const contents: BoardToken[] = []
      // One PSC per group; later BP-PWRs get a blank in the power slot.
      if (s.psc > 0) {
        if (pscLeft > 0) { contents.push('PSC'); pscLeft-- }
        else contents.push('spare-PSC')
      }
      let aeb = 0
      let com = 0
      let io = 0
      for (let k = 0; k < s.slots4; k++) {
        // COM boards take the first 4 TE slot of a BP-PWR, as the grids show.
        if (s.kind === 'PWR' && comLeft > 0) { contents.push('COM-AdC'); comLeft--; com++ }
        else if (aebLeft > 0) { contents.push('AEB'); aebLeft--; aeb++ }
        else contents.push(s.kind === 'PWR' ? 'spare' : 'leer')
      }
      for (let k = 0; k < s.slots6; k++) {
        if (ioLeft > 0) { contents.push('IO-EXB'); ioLeft--; io++ }
        else contents.push('spare IO')
      }
      out.push({
        spec: s, system, group, contents, aeb, ioExb: io, com,
        psc: contents.includes('PSC') ? 1 : 0,
        sparePsc: contents.includes('spare-PSC') ? 1 : 0,
        freeSlots4: s.slots4 - aeb - com,
        freeSlots6: s.slots6 - io,
      })
    }
  }
  return out
}

export const PWR_CODES = PWR_VARIANTS.map((b) => b.code)
export const EXB_CODES = EXB_VARIANTS.map((b) => b.code)
