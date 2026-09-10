import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateCubicles, excelCubicleCount, slotFans, CUBICLES, MAX_AEB_PER_COM,
} from '../src/cubicle.ts'
import { pack, type Group } from '../src/packer.ts'
import type { SystemId } from '../src/types.ts'

const groups = (g: [number, number, number][]): Group[] =>
  g.map(([aeb, ioExb, com], i) => ({
    id: `G${i + 1}`, system: (i % 2 === 0 ? 'MAIN' : 'REDUNDANT') as SystemId,
    aeb, ioExb, com,
  }))

describe('cubicle capacities', () => {
  test('match the questionnaire, not the workbook (which has none)', () => {
    // Handover sheet '4. Project Questionnairre' cell B151, notes 6-8.
    assert.deepEqual(
      CUBICLES.map((c) => [c.maxRacks, c.maxIoExb]),
      [[1, 4], [2, 10], [4, 20]],
    )
    assert.equal(MAX_AEB_PER_COM, 40)
  })
})

describe('the workbook formula', () => {
  test('Gesamt row 55 is ceil(racks / 6)', () => {
    assert.equal(excelCubicleCount(1), 1)
    assert.equal(excelCubicleCount(4), 1)
    assert.equal(excelCubicleCount(6), 1)
    assert.equal(excelCubicleCount(7), 2)
  })

  test('gated off it books nothing', () => {
    assert.equal(excelCubicleCount(4, false), 0)
  })
})

describe('slot fans', () => {
  test('reproduce the BM5:BM12 step table exactly', () => {
    const expected = [0, 0, 1, 1, 2, 2, 3, 3, 4]
    for (let n = 0; n <= 8; n++) assert.equal(slotFans(n), expected[n], `${n} racks`)
  })

  test('nine racks returns zero — the workbook has no branch past eight', () => {
    // Reproduced deliberately. The step table stops at 8 and every branch fails,
    // so a ninth rack silently books no fans instead of four.
    assert.equal(slotFans(9), 0)
    assert.equal(slotFans(12), 0)
  })
})

describe('allocation against the reference project', () => {
  test('ALH-2: four racks and twenty IO fill exactly one 35U', () => {
    const r = pack({ groups: groups([[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]]) })
    const c = allocateCubicles(r)
    assert.equal(r.rackCount, 4)
    assert.equal(c.total, 1)
    assert.equal(c.counts['FAR-002-35U'], 1)
    assert.equal(c.excelCount, 1)
    assert.equal(c.divergesFromWorkbook, false)
  })

  test('Jaipur JN: one rack and two IO take the 15U wall mount', () => {
    const r = pack({ groups: groups([[2, 1, 1], [2, 1, 0]]) })
    const c = allocateCubicles(r)
    assert.equal(c.total, 1)
    assert.equal(c.counts['FAR-007-15U'], 1)
  })

  test('the IO limit can bind before the rack limit', () => {
    // Two racks but 12 IO-EXB: a 20U holds 2 racks yet only 10 IO, so the
    // allocation must step up to a 35U.
    const r = pack({ groups: groups([[8, 12, 1]]) })
    const c = allocateCubicles(r)
    assert.equal(c.counts['FAR-002-35U'], 1)
    assert.equal(c.counts['FAR-004-20U'], 0)
  })

  test('the two rules agree everywhere on this tender', () => {
    // No location exceeds four racks, and below five both rules say one cubicle.
    for (const g of [
      [[2, 1, 1], [2, 1, 0]], [[12, 6, 1], [12, 6, 1]],
      [[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]],
      [[8, 4, 1], [8, 4, 1], [8, 4, 1], [8, 4, 1]],
    ] as [number, number, number][][]) {
      const c = allocateCubicles(pack({ groups: groups(g) }))
      assert.equal(c.divergesFromWorkbook, false)
    }
  })

  test('the two rules diverge at five racks — the latent conflict', () => {
    // 60 AEB / 6 IO packs into five racks. The capacity rule needs two cubicles
    // because a 35U holds four racks; the workbook's ceil(5/6) still says one.
    // The largest location on this tender is four racks, so nothing reaches it.
    const r = pack({ groups: groups([[60, 6, 1]]) })
    assert.equal(r.rackCount, 5)
    const c = allocateCubicles(r)
    assert.equal(c.total, 2)
    assert.equal(c.excelCount, 1)
    assert.equal(c.divergesFromWorkbook, true)
    assert.ok(c.warnings.some((w) => w.includes('workbook formula')))
  })
})

describe('gates and warnings', () => {
  test('cubiclesEnabled off books nothing, as Gesamt!AI82 blank does', () => {
    const r = pack({ groups: groups([[10, 5, 1]]) })
    const c = allocateCubicles(r, { cubiclesEnabled: false })
    assert.equal(c.total, 0)
    assert.equal(c.slotFans, 0)
    assert.equal(c.activeFans, 0)
    assert.match(c.warnings[0]!, /Gesamt!AI82/)
  })

  test('active fans are fitted per cubicle above 120 W', () => {
    const r = pack({ groups: groups([[10, 5, 1], [10, 5, 1], [10, 5, 1], [10, 5, 1]]) })
    assert.equal(allocateCubicles(r, { powerWatts: 119 }).activeFans, 0)
    assert.equal(allocateCubicles(r, { powerWatts: 121 }).activeFans, 1)
  })

  test('warns when AEB exceeds what the seated COM boards can configure', () => {
    const r = pack({ groups: groups([[60, 10, 1]]) })
    const c = allocateCubicles(r)
    assert.ok(c.warnings.some((w) => w.includes('at least 2 COM')), c.warnings.join(' | '))
  })

  test('spare-PSC slots bill as two 4 TE plates each', () => {
    // ALH-1 has four BP-PWR across two groups but only two PSC.
    const r = pack({ groups: groups([[12, 6, 1], [12, 6, 1]]) })
    assert.equal(r.sparePsc, 2)
    assert.equal(allocateCubicles(r).sparePscPlates, 4) // Gesamt row 45 reads 4
  })
})
