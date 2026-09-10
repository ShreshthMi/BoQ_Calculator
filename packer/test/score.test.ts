/**
 * Regression guard over the whole reference project — 21 locations across both
 * BRC workbooks, scored against the layouts the planners actually drew.
 *
 * Run `node scripts/extract_reference.py` if fixtures/reference.json is stale.
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pack, type Group } from '../src/packer.ts'
import type { SystemId } from '../src/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'reference.json')

type RefLoc = {
  name: string
  groups: { aeb: number; ioExb: number; com: number; psc: number }[]
  actual: { racks: number; backplanes: Record<string, number>; psc: number; com: number; te: number }
}

const CODES = ['BP-PWR-0', 'BP-PWR-4', 'BP-PWR-8', 'BP-EXB-1', 'BP-EXB-2', 'BP-EXB-4']

/** Dual detection permits BP-EXB-4; single detection caps at BP-EXB-2. */
const MAX_EXB: Record<string, number> = { ABS: 4, Yard: 2 }

/**
 * The three locations where the packer and the planner disagree. All are spare
 * IO capacity the planner chose to carry and the packer does not invent: two add
 * a whole BP-EXB-1, one uses a BP-EXB-2 where a BP-EXB-1 would do. Rack count is
 * unaffected at all three.
 *
 * These are recorded, not corrected. If the list changes, something moved.
 */
const KNOWN_DIFFERENCES = new Set([
  'Yard/Devpura Acc-1',
  'Yard/Snaganer Acc-1',
  'Yard/Devpura Acc-2#4',
])

describe('reference project scoring', () => {
  let REF: Record<string, RefLoc[]> = {}

  before(() => {
    assert.ok(existsSync(FIXTURE), 'run scripts/extract_reference.py first')
    REF = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  })

  test('fixture covers all 21 locations', () => {
    assert.equal(Object.values(REF).flat().length, 21)
    assert.equal(REF['ABS']!.length, 8)
    assert.equal(REF['Yard']!.length, 13)
  })

  test('rack count matches the planner at every location', () => {
    const misses: string[] = []
    for (const [proj, locs] of Object.entries(REF)) {
      for (const loc of locs) {
        const r = runLoc(proj, loc)
        if (r.rackCount !== loc.actual.racks) {
          misses.push(`${proj}/${loc.name}: ${r.rackCount} vs ${loc.actual.racks}`)
        }
      }
    }
    assert.deepEqual(misses, [], 'rack count is the number that reaches the BoQ')
  })

  test('PSC placement and spare-PSC blanking match the workbook', () => {
    // PSC count is an input, but where they sit — and therefore how many power
    // slots end up blanked — is the packer's own output, and is checkable.
    for (const [proj, locs] of Object.entries(REF)) {
      for (const loc of locs) {
        const r = runLoc(proj, loc)
        assert.equal(r.psc, loc.actual.psc, `${proj}/${loc.name} PSC`)
        assert.equal(r.sparePsc, loc.actual.sparePsc, `${proj}/${loc.name} spare-PSC`)
      }
    }
  })

  test('one PSC per group holds across ABS and fails across Yard', () => {
    // Recorded because it is a real asymmetry, not a bug: every ABS location
    // equips exactly one PSC per group; no Yard location does, its larger
    // groups carrying two.
    const perGroup = (p: string) =>
      (REF[p] ?? []).filter((l) => l.actual.psc === l.groups.length).length
    assert.equal(perGroup('ABS'), 8, 'all eight ABS locations')
    assert.equal(perGroup('Yard'), 0, 'no Yard location')
  })

  test('every board in the workbook is seated by the packer', () => {
    for (const [proj, locs] of Object.entries(REF)) {
      for (const loc of locs) {
        const r = runLoc(proj, loc)
        const aeb = loc.groups.reduce((a, g) => a + g.aeb, 0)
        const io = loc.groups.reduce((a, g) => a + g.ioExb, 0)
        assert.equal(r.aebSeated, aeb, `${proj}/${loc.name} AEB`)
        assert.equal(r.ioExbSeated, io, `${proj}/${loc.name} IO-EXB`)
        assert.equal(r.comSeated, loc.actual.com, `${proj}/${loc.name} COM`)
      }
    }
  })

  test('backplane mix matches except at three recorded locations', () => {
    const differing: string[] = []
    let seen = 0
    for (const [proj, locs] of Object.entries(REF)) {
      locs.forEach((loc, i) => {
        const r = runLoc(proj, loc)
        const same = CODES.every(
          (k) => (r.backplaneCounts[k] ?? 0) === (loc.actual.backplanes[k] ?? 0),
        )
        // Yard carries two locations both labelled 'Devpura Acc-2'; disambiguate
        // the second by its index, as the workbook itself does not.
        const key = `${proj}/${loc.name}${loc.name === 'Devpura Acc-2' && i > 8 ? '#4' : ''}`
        if (!same) differing.push(key)
        seen++
      })
    }
    assert.equal(seen, 21)
    assert.deepEqual(
      new Set(differing), KNOWN_DIFFERENCES,
      `differences moved: ${differing.join(', ')}`,
    )
  })

  test('the packer is never wider than the planner in total TE', () => {
    let us = 0
    let them = 0
    for (const [proj, locs] of Object.entries(REF)) {
      for (const loc of locs) {
        us += runLoc(proj, loc).racks.reduce((a, x) => a + x.teUsed, 0)
        them += loc.actual.te
      }
    }
    assert.ok(us <= them, `packer used ${us} TE, planner ${them}`)
  })

  test('no rack anywhere exceeds 84 TE', () => {
    for (const [proj, locs] of Object.entries(REF)) {
      for (const loc of locs) {
        for (const rack of runLoc(proj, loc).racks) {
          assert.ok(rack.teUsed <= 84, `${proj}/${loc.name} rack ${rack.index}`)
        }
      }
    }
  })

  test('single-detection projects never emit a BP-EXB-4', () => {
    for (const loc of REF['Yard'] ?? []) {
      const r = runLoc('Yard', loc)
      assert.equal(r.backplaneCounts['BP-EXB-4'], 0, loc.name)
      assert.equal(loc.actual.backplanes['BP-EXB-4'] ?? 0, 0, `${loc.name} workbook`)
    }
  })

  function runLoc(proj: string, loc: RefLoc) {
    const groups: Group[] = loc.groups.map((g, i) => ({
      id: `G${i + 1}`,
      system: (i % 2 === 0 ? 'MAIN' : 'REDUNDANT') as SystemId,
      aeb: g.aeb, ioExb: g.ioExb, com: g.com, psc: g.psc,
    }))
    return pack({ groups, options: { maxExbSlots: MAX_EXB[proj] ?? 4 } })
  }
})
