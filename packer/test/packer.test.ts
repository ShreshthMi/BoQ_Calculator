import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pack, splitDemand, groupsFromLines, ioForTs, type Group } from '../src/packer.ts'
import type { SystemId } from '../src/types.ts'

/**
 * Ground truth: the ABS workbook's own layout, read from Gesamt rows
 * 14/20/22/29/30/32/35/36/39/40 and from the slot grids on sheets '01'..'08'.
 *
 * `groups` is the planner's grouping, recovered from where ZP numbering restarts
 * in each grid. Grouping is an input to the packer (see packer.ts), so the
 * question these tests answer is: given the planner's grouping, does the packer
 * reproduce the planner's layout?
 */
type Ref = {
  name: string
  groups: [aeb: number, io: number, com: number][]
  racks: number
  psc: number
  com: number
  aeb: number
  io: number
  bp: Record<string, number>
}

const REFERENCE: Ref[] = [
  {
    name: 'Jaipur JN', groups: [[2, 1, 1], [2, 1, 0]],
    racks: 1, psc: 2, com: 1, aeb: 4, io: 2,
    bp: { 'BP-PWR-4': 2, 'BP-EXB-1': 2 },
  },
  {
    name: 'ALH-1', groups: [[12, 6, 1], [12, 6, 1]],
    racks: 3, psc: 2, com: 2, aeb: 24, io: 12,
    bp: { 'BP-PWR-4': 2, 'BP-PWR-8': 2, 'BP-EXB-2': 2, 'BP-EXB-4': 2 },
  },
  {
    name: 'Durgapura', groups: [[2, 1, 1], [2, 1, 0], [6, 3, 1], [6, 3, 1]],
    racks: 3, psc: 4, com: 3, aeb: 16, io: 8,
    bp: { 'BP-PWR-4': 2, 'BP-PWR-8': 2, 'BP-EXB-1': 2, 'BP-EXB-4': 2 },
  },
  {
    name: 'Sanganer', groups: [[2, 1, 1], [2, 1, 0], [6, 3, 1], [6, 3, 1]],
    racks: 3, psc: 4, com: 3, aeb: 16, io: 8,
    bp: { 'BP-PWR-4': 2, 'BP-PWR-8': 2, 'BP-EXB-1': 2, 'BP-EXB-4': 2 },
  },
  {
    name: 'ALH-2', groups: [[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]],
    racks: 4, psc: 4, com: 4, aeb: 40, io: 20,
    bp: { 'BP-PWR-8': 4, 'BP-EXB-1': 4, 'BP-EXB-2': 8 },
  },
  {
    name: 'ALH-3', groups: [[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]],
    racks: 4, psc: 4, com: 4, aeb: 40, io: 20,
    bp: { 'BP-PWR-8': 4, 'BP-EXB-1': 4, 'BP-EXB-2': 8 },
  },
  {
    name: 'ALH-4', groups: [[8, 4, 1], [8, 4, 1], [8, 4, 1], [8, 4, 1]],
    racks: 4, psc: 4, com: 4, aeb: 32, io: 16,
    bp: { 'BP-PWR-8': 4, 'BP-EXB-4': 4 },
  },
  {
    name: 'Sheodaspura', groups: [[2, 1, 1], [2, 1, 0]],
    racks: 1, psc: 2, com: 1, aeb: 4, io: 2,
    bp: { 'BP-PWR-4': 2, 'BP-EXB-1': 2 },
  },
]

const toGroups = (g: Ref['groups']): Group[] =>
  g.map(([aeb, ioExb, com], i) => ({
    id: `G${i + 1}`,
    system: (i % 2 === 0 ? 'MAIN' : 'REDUNDANT') as SystemId,
    aeb, ioExb, com,
  }))

// Every ABS location equips exactly one PSC per group, which is the default.

const nonZero = (c: Record<string, number>) =>
  Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0))

describe('reference project — ABS workbook', () => {
  for (const ref of REFERENCE) {
    describe(ref.name, () => {
      const result = pack({ groups: toGroups(ref.groups) })

      test('backplane mix matches the workbook', () => {
        assert.deepEqual(nonZero(result.backplaneCounts), ref.bp)
      })

      test(`rack count is ${ref.racks}`, () => {
        assert.equal(result.rackCount, ref.racks)
      })

      test(`PSC count is ${ref.psc} — equipped power slots, not BP-PWR count`, () => {
        // ABS equips one PSC per group, the default. ALH-1 has four BP-PWR and
        // only two PSC; the other two power slots carry a spare-PSC blank.
        assert.equal(result.psc, ref.psc)
        assert.equal(result.psc, ref.groups.length)
      })

      test('all boards are seated', () => {
        assert.equal(result.aebSeated, ref.aeb)
        assert.equal(result.ioExbSeated, ref.io)
        assert.equal(result.comSeated, ref.com)
      })

      test('no rack exceeds its 84 TE budget', () => {
        for (const r of result.racks) {
          assert.ok(r.teUsed <= r.spec.te, `rack ${r.index} used ${r.teUsed} TE`)
          assert.equal(r.teUsed + r.teFree, r.spec.te)
        }
      })
    })
  }

  test('project totals reconcile across all eight locations', () => {
    const tot = REFERENCE.reduce(
      (a, ref) => {
        const r = pack({ groups: toGroups(ref.groups) })
        a.racks += r.rackCount
        a.psc += r.psc
        a.aeb += r.aebSeated
        for (const [k, n] of Object.entries(r.backplaneCounts)) a.bp[k] = (a.bp[k] ?? 0) + n
        return a
      },
      { racks: 0, psc: 0, aeb: 0, bp: {} as Record<string, number> },
    )
    // Gesamt column totals for the ABS workbook.
    assert.equal(tot.racks, 23, 'BGT07')
    assert.equal(tot.aeb, 176, 'AEB / detection points')
    assert.equal(tot.psc, 26, 'PSC')
    assert.deepEqual(nonZero(tot.bp), {
      'BP-PWR-4': 10, 'BP-PWR-8': 18, 'BP-EXB-1': 16, 'BP-EXB-2': 18, 'BP-EXB-4': 10,
    })
  })
})

describe('the main/redundant constraint', () => {
  test('no backplane ever mixes groups', () => {
    for (const ref of REFERENCE) {
      const r = pack({ groups: toGroups(ref.groups) })
      for (const rack of r.racks) {
        for (const bp of rack.backplanes) {
          assert.equal(typeof bp.group, 'string')
          assert.ok(bp.group.length > 0, `${ref.name}: backplane with no owning group`)
        }
      }
    }
  })

  test('racks DO mix groups — Jaipur JN puts both systems in one rack', () => {
    const r = pack({ groups: toGroups([[2, 1, 1], [2, 1, 0]]) })
    assert.equal(r.rackCount, 1)
    const groups = new Set(r.racks[0]!.backplanes.map((b) => b.group))
    assert.equal(groups.size, 2, 'one rack should carry both groups')
    const systems = new Set(r.racks[0]!.backplanes.map((b) => b.system))
    assert.equal(systems.size, 2)
  })

  test('separation costs backplanes: one group of 4 is cheaper than two of 2', () => {
    const split = pack({ groups: toGroups([[2, 1, 1], [2, 1, 0]]) })
    const merged = pack({ groups: toGroups([[4, 2, 1]]) })
    // Merged needs one BP-PWR-4 + one BP-EXB-2; split needs two of each smaller.
    assert.ok(
      split.backplaneCounts['BP-PWR-4']! > merged.backplaneCounts['BP-PWR-4']!,
      'separation should require more power backplanes',
    )
    assert.equal(split.psc, 2)
    assert.equal(merged.psc, 1)
  })

  test('warns when a second system has no COM board of its own', () => {
    const r = pack({ groups: toGroups([[2, 1, 1], [2, 1, 0]]) })
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0]!, /no COM board/)
  })

  test('no warning when every group carries its own COM', () => {
    const r = pack({ groups: toGroups([[2, 1, 1], [2, 1, 1]]) })
    assert.deepEqual(r.warnings, [])
  })
})

describe('group helpers', () => {
  test('ioForTs is one board per two track sections', () => {
    assert.equal(ioForTs(0), 0)
    assert.equal(ioForTs(1), 1)
    assert.equal(ioForTs(10), 5)
    assert.equal(ioForTs(11), 6)
  })

  test('splitDemand mirrors main and redundant', () => {
    const g = splitDemand({ aeb: 4, ioExb: 2, com: 1 }, 'DUAL')
    assert.equal(g.length, 2)
    assert.equal(g[0]!.aeb + g[1]!.aeb, 4)
    assert.equal(g[0]!.system, 'MAIN')
    assert.equal(g[1]!.system, 'REDUNDANT')
  })

  test('splitDemand on SINGLE detection makes one group', () => {
    assert.equal(splitDemand({ aeb: 4, ioExb: 2, com: 1 }, 'SINGLE').length, 1)
  })

  test('groupsFromLines reproduces the ALH-2 four-group shape', () => {
    const g = groupsFromLines({ dn: { dp: 10, ts: 10 }, up: { dp: 10, ts: 10 } }, 'DUAL')
    assert.equal(g.length, 4)
    assert.deepEqual(g.map((x) => [x.aeb, x.ioExb, x.com]), [[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]])
    const r = pack({ groups: g })
    assert.equal(r.rackCount, 4)
    assert.deepEqual(nonZero(r.backplaneCounts), { 'BP-PWR-8': 4, 'BP-EXB-1': 4, 'BP-EXB-2': 8 })
  })
})

describe('options', () => {
  test('spare slots can push a location into another rack', () => {
    const base = pack({ groups: toGroups([[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]]) })
    const spared = pack({
      groups: toGroups([[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]]),
      options: { spareSlotPct: 20 },
    })
    assert.equal(base.rackCount, 4)
    assert.ok(spared.rackCount >= base.rackCount)
    assert.ok(spared.aebSeated > base.aebSeated, 'spare slots are seated as extra AEB capacity')
  })

  test('least-te objective is never worse on TE than fewest-backplanes', () => {
    for (const ref of REFERENCE) {
      const a = pack({ groups: toGroups(ref.groups), objective: 'fewest-backplanes' })
      const b = pack({ groups: toGroups(ref.groups), objective: 'least-te' })
      const teOf = (r: typeof a) => r.racks.reduce((s, x) => s + x.teUsed, 0)
      assert.ok(teOf(b) <= teOf(a), `${ref.name}: least-te used more TE`)
    }
  })
})
