/**
 * The drawn grid, scored against the grids the planners actually drew.
 *
 * `Rule Map/fixtures/actual-layouts.json` was extracted from the two shipped
 * workbooks by `Rule Map/extract_layouts.py`, and it records every slot of every
 * rack at all 21 configured locations. That makes it the right thing to check
 * `buildGrid` against: not "does it produce something plausible" but "does it
 * put the same numbers under the same boards as the engineer did".
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pack, type Group } from '../src/packer.ts'
import {
  buildGrid, tallyGrid, colName, BLOCK0, PERIOD, LIVE_BLOCKS,
  COL_FIRST, COL_LAST, SLOTS_PER_RACK,
} from '../src/grid.ts'
import type { SystemId } from '../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAYOUTS = join(HERE, '..', '..', 'Rule Map', 'fixtures', 'actual-layouts.json')

type RefSlot = { col: string; board: string | null; te: number; zp: number | null; fma: number[] }
type RefBp = {
  type: string; startCol: string; pscVersion: string | null
  canIn: boolean; canOut: boolean; slots: RefSlot[]
}
type RefRack = { index: number; type: string; baseRow: number; backplanes: RefBp[] }
type RefLoc = {
  name: string; sheet: string
  racks: RefRack[]
  zpSystems: { zpMin: number; zpMax: number; aeb: number }[]
  totals: Record<string, number>
  sheetCells: Record<string, number | null>
}

const MAX_EXB: Record<string, number> = { ABS: 4, Yard: 2 }

describe('grid geometry', () => {
  test('column names round-trip', () => {
    assert.equal(colName(3), 'C')
    assert.equal(colName(COL_FIRST), 'D')
    assert.equal(colName(COL_LAST), 'U')
    assert.equal(colName(28), 'AB')
  })

  test('eighteen slot columns, four live blocks', () => {
    assert.equal(SLOTS_PER_RACK, 18)
    assert.equal(LIVE_BLOCKS, 4)
    assert.equal(BLOCK0 + (LIVE_BLOCKS - 1) * PERIOD, 98)
  })
})

describe('the drawn grid against the reference layouts', () => {
  let REF: Record<string, { locations: RefLoc[] }> = {}

  before(() => {
    assert.ok(existsSync(LAYOUTS), 'run Rule Map/extract_layouts.py first')
    REF = JSON.parse(readFileSync(LAYOUTS, 'utf8'))
  })

  /** Rebuild the planner's own groups, so only the DRAWING is under test. */
  const groupsOf = (loc: RefLoc): Group[] => {
    // A group is a run of backplanes whose ZP numbering restarts at 1, exactly
    // as extract_layouts.py recovers it.
    const flat = loc.racks.flatMap((r) => r.backplanes)
    const runs: RefBp[][] = []
    let cur: RefBp[] = []
    let seen = false
    for (const bp of flat) {
      const zps = bp.slots.map((s) => s.zp).filter((z): z is number => z != null)
      if (zps.length && Math.min(...zps) === 1 && seen) { runs.push(cur); cur = []; seen = false }
      cur.push(bp)
      if (zps.length) seen = true
    }
    if (cur.length) runs.push(cur)
    return runs.map((run, i) => {
      const slots = run.flatMap((b) => b.slots)
      return {
        id: `G${i + 1}`,
        system: (i % 2 === 0 ? 'MAIN' : 'REDUNDANT') as SystemId,
        aeb: slots.filter((s) => s.board === 'AEB').length,
        ioExb: slots.filter((s) => s.board === 'IO-EXB' || s.board === 'CO-EXB').length,
        com: slots.filter((s) => s.board === 'COM-AdC' || s.board === 'COM-xxx').length,
        psc: slots.filter((s) => s.board === 'PSC' || s.board === 'PSC-R').length,
        ts: slots.reduce((a, s) => a + s.fma.length, 0),
      }
    })
  }

  test('every reference location draws into four blocks or fewer', () => {
    for (const [book, data] of Object.entries(REF)) {
      for (const loc of data.locations) {
        assert.ok(
          loc.racks.length <= LIVE_BLOCKS,
          `${book}/${loc.name} drew ${loc.racks.length} racks`,
        )
      }
    }
  })

  test('every reference rack fits the eighteen slot columns', () => {
    for (const [book, data] of Object.entries(REF)) {
      for (const loc of data.locations) {
        for (const r of loc.racks) {
          const used = r.backplanes.reduce((a, b) => a + b.slots.length, 0)
          assert.ok(used <= SLOTS_PER_RACK, `${book}/${loc.name} rack ${r.index} used ${used}`)
        }
      }
    }
  })

  test('block base rows are 56, 70, 84, 98', () => {
    for (const data of Object.values(REF)) {
      for (const loc of data.locations) {
        for (const r of loc.racks) {
          assert.equal(r.baseRow, BLOCK0 + (r.index - 1) * PERIOD)
        }
      }
    }
  })

  test('PSC version is R1 where the power slot is equipped and NE where it is blanked', () => {
    // The single strongest derivation in the module, and it is exact: the
    // template's own token formula reads this cell back the other way.
    let r1 = 0
    let ne = 0
    for (const data of Object.values(REF)) {
      for (const loc of data.locations) {
        for (const rack of loc.racks) {
          for (const bp of rack.backplanes) {
            if (!bp.type.startsWith('BP-PWR')) {
              assert.equal(bp.pscVersion, null, `${loc.name} ${bp.type} carries a PSC version`)
              continue
            }
            const head = bp.slots[0]!.board
            if (head === 'spare-PSC') { assert.equal(bp.pscVersion, 'NE'); ne++ } else { assert.equal(bp.pscVersion, 'R1'); r1++ }
          }
        }
      }
    }
    assert.equal(r1, 61)
    assert.equal(ne, 14)
  })

  test('FMA numbers are carried by I/O boards alone, two apiece', () => {
    for (const data of Object.values(REF)) {
      for (const loc of data.locations) {
        for (const rack of loc.racks) {
          for (const bp of rack.backplanes) {
            for (const s of bp.slots) {
              if (s.board === 'IO-EXB' || s.board === 'CO-EXB') {
                assert.ok(s.fma.length === 1 || s.fma.length === 2,
                  `${loc.name} ${s.col} has ${s.fma.length} FMA`)
              } else {
                assert.equal(s.fma.length, 0, `${loc.name} ${s.col} ${s.board} carries FMA`)
              }
            }
          }
        }
      }
    }
  })

  test('generated grids reconcile with the sheet totals the workbook recorded', () => {
    const rows: string[] = []
    let checked = 0
    for (const [book, data] of Object.entries(REF)) {
      for (const loc of data.locations) {
        const groups = groupsOf(loc)
        const result = pack({ groups, options: { maxExbSlots: MAX_EXB[book] ?? 4 } })
        const grid = buildGrid(result, groups, `${book}/${loc.name}`)
        const t = tallyGrid(grid)
        const want = loc.totals
        const diff: string[] = []
        // Board counts must land exactly: they are the same demand, re-drawn.
        for (const [k, got] of [
          ['aeb', t.aeb], ['ioExb', t.ioExb], ['comAdc', t.comAdc],
          ['pscTotal', t.pscTotal], ['sparePsc', t.sparePsc],
        ] as const) {
          if (want[k] !== got) diff.push(`${k} ${got} != ${want[k]}`)
        }
        // Track sections come back from the FMA numbering, and that is the
        // number the sheet reports as AO3 and Gesamt reports as row 63.
        if (t.trackSections !== want.trackSections) {
          diff.push(`trackSections ${t.trackSections} != ${want.trackSections}`)
        }
        if (diff.length) rows.push(`${book}/${loc.name}: ${diff.join(', ')}`)
        checked++
      }
    }
    assert.equal(checked, 21)
    assert.deepEqual(rows, [], `\n  ${rows.join('\n  ')}\n`)
  })

  test('counting points restart at 1 in each group and run without a gap', () => {
    for (const [book, data] of Object.entries(REF)) {
      for (const loc of data.locations) {
        const groups = groupsOf(loc)
        const result = pack({ groups, options: { maxExbSlots: MAX_EXB[book] ?? 4 } })
        const grid = buildGrid(result, groups, `${book}/${loc.name}`)
        const byGroup = new Map<string, number[]>()
        for (const r of grid.racks) {
          for (const bp of r.backplanes) {
            for (const s of bp.slots) {
              if (s.zp == null) continue
              const list = byGroup.get(bp.group) ?? []
              list.push(s.zp)
              byGroup.set(bp.group, list)
            }
          }
        }
        for (const [id, zps] of byGroup) {
          const want = Array.from({ length: zps.length }, (_, i) => i + 1)
          assert.deepEqual([...zps].sort((a, b) => a - b), want,
            `${book}/${loc.name} group ${id}`)
        }
      }
    }
  })

  test('no group is split across the drawing by another group', () => {
    // The restart-at-1 rule is the only record of where a group begins, so an
    // interleaved drawing cannot be read back. buildGrid warns; nothing on the
    // reference project should trip it.
    const warned: string[] = []
    for (const [book, data] of Object.entries(REF)) {
      for (const loc of data.locations) {
        const groups = groupsOf(loc)
        const result = pack({ groups, options: { maxExbSlots: MAX_EXB[book] ?? 4 } })
        const grid = buildGrid(result, groups, `${book}/${loc.name}`)
        warned.push(...grid.warnings)
      }
    }
    assert.deepEqual(warned, [], `\n  ${warned.join('\n  ')}\n`)
  })

  test('slots are laid out left to right from D with no gap', () => {
    for (const [book, data] of Object.entries(REF)) {
      for (const loc of data.locations) {
        const groups = groupsOf(loc)
        const result = pack({ groups, options: { maxExbSlots: MAX_EXB[book] ?? 4 } })
        const grid = buildGrid(result, groups, `${book}/${loc.name}`)
        for (const r of grid.racks) {
          let expect = COL_FIRST
          for (const bp of r.backplanes) {
            assert.equal(bp.startCol, colName(expect), `${loc.name} rack ${r.index}`)
            bp.slots.forEach((s, i) => assert.equal(s.col, colName(expect + i)))
            expect += bp.slots.length
          }
          assert.ok(expect - 1 <= COL_LAST)
        }
      }
    }
  })
})

describe('the template ceilings are reported, never silently truncated', () => {
  const bigGroup = (id: string, aeb: number): Group => ({
    id, system: 'MAIN', aeb, ioExb: Math.ceil(aeb / 2), ts: aeb, com: 1, psc: 1,
  })

  test('a fifth rack is dropped and named, with the reason the workbook gives', () => {
    const groups = [bigGroup('G1', 40), bigGroup('G2', 40), bigGroup('G3', 40)]
    const result = pack({ groups, options: { maxExbSlots: 4 } })
    assert.ok(result.rackCount > 4, `needs ${result.rackCount} racks to be a useful test`)
    const grid = buildGrid(result, groups, 'Overflow Jn')
    assert.equal(grid.racks.length, 4)
    assert.ok(grid.dropped.length > 0)
    assert.match(grid.warnings.join('\n'), /Overflow Jn packs into \d+ racks/)
    assert.match(grid.warnings.join('\n'), /Rev!C5/)
    assert.match(grid.warnings.join('\n'), /equipment room/)
  })

  test('an odd track-section count numbers the last I/O board once', () => {
    const groups: Group[] = [{ id: 'G1', system: 'MAIN', aeb: 4, ioExb: 4, ts: 7, com: 1, psc: 1 }]
    const grid = buildGrid(pack({ groups, options: { maxExbSlots: 4 } }), groups, 'Odd Jn')
    const fma = grid.racks.flatMap((r) => r.backplanes)
      .flatMap((b) => b.slots).filter((s) => s.fma.length)
    assert.equal(fma.reduce((a, s) => a + s.fma.length, 0), 7)
    assert.deepEqual(fma.map((s) => s.fma.length), [2, 2, 2, 1])
    assert.deepEqual(fma.flatMap((s) => s.fma), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(grid.warnings, [])
  })

  test('track sections with no board to sit under are reported', () => {
    // ioExb understated against ts: the sheet's own total would come out short,
    // and saying so is the whole point.
    const groups: Group[] = [{ id: 'G1', system: 'MAIN', aeb: 4, ioExb: 1, ts: 9, com: 1, psc: 1 }]
    const grid = buildGrid(pack({ groups, options: { maxExbSlots: 4 } }), groups, 'Short Jn')
    assert.match(grid.warnings.join('\n'), /7 track section\(s\) with no I\/O board slot/)
  })
})
