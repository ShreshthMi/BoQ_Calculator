import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { decomposeGroup, materialise } from '../src/decompose.ts'
import { BACKPLANES, TE_OF } from '../src/types.ts'

const nz = (c: Record<string, number>) =>
  Object.entries(c).filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${n}x ${k}`).join(', ')

describe('backplane geometry', () => {
  test('TE arithmetic matches the workbook lookup', () => {
    // Sheet '01' row 59: PSC 8, AEB/COM 4, IO-EXB 6.
    assert.equal(TE_OF['PSC'], 8)
    assert.equal(TE_OF['AEB'], 4)
    assert.equal(TE_OF['IO-EXB'], 6)
    for (const b of BACKPLANES) {
      const expected = b.kind === 'PWR' ? 8 + 4 * b.n : 4 + 6 * b.n
      assert.equal(b.te, expected, `${b.code} TE`)
    }
  })

  test('the six orderable variants have the widths the BoQ names', () => {
    const te = Object.fromEntries(BACKPLANES.map((b) => [b.code, b.te]))
    assert.deepEqual(te, {
      'BP-PWR-0': 8, 'BP-PWR-4': 24, 'BP-PWR-8': 40,
      'BP-EXB-1': 10, 'BP-EXB-2': 16, 'BP-EXB-4': 28,
    })
  })

  test('every BP-EXB carries one AEB slot as well as its IO slots', () => {
    for (const b of BACKPLANES.filter((x) => x.kind === 'EXB')) {
      assert.equal(b.slots4, 1, `${b.code} AEB slot`)
      assert.equal(b.slots6, b.n, `${b.code} IO slots`)
    }
  })
})

describe('coupled decomposition', () => {
  test('ALH-2 group: solving jointly beats optimising EXB alone', () => {
    // 10 AEB, 5 IO, 1 COM. The workbook's layout is BP-PWR-8 + 2x BP-EXB-2 +
    // BP-EXB-1 = 82 TE, which fits one 84 TE rack. Optimising the EXB side alone
    // picks {EXB-4, EXB-1} and needs a second BP-PWR, reaching 102 TE.
    const d = decomposeGroup({ aeb: 10, ioExb: 5, com: 1 })
    assert.equal(d.te, 82, `got ${nz(d.counts)}`)
    assert.equal(nz(d.counts), '1x BP-EXB-1, 2x BP-EXB-2, 1x BP-PWR-8')
    assert.equal(d.pwrCount, 1)
    assert.equal(d.freeSlots4, 0, 'slots exactly filled')
    assert.equal(d.freeSlots6, 0)
  })

  test('ALH-1 group: fewest-backplanes reproduces the human layout', () => {
    // 12 AEB, 6 IO, 1 COM. Human: BP-PWR-8 + BP-PWR-4 + BP-EXB-4 + BP-EXB-2
    // = 108 TE over 4 backplanes.
    const d = decomposeGroup({ aeb: 12, ioExb: 6, com: 1 }, 'fewest-backplanes')
    assert.equal(d.backplanes, 4)
    assert.equal(d.te, 108, `got ${nz(d.counts)}`)
    assert.equal(nz(d.counts), '1x BP-EXB-2, 1x BP-EXB-4, 1x BP-PWR-4, 1x BP-PWR-8')
  })

  test('least-te finds a cheaper but bushier answer for the same group', () => {
    // BP-EXB-2 + 4x BP-EXB-1 covers the six IO and donates five AEB slots, so a
    // single BP-PWR-8 absorbs the rest: 96 TE over six backplanes. Twelve TE
    // better than the layout the planner drew, and two more backplanes to wire.
    const d = decomposeGroup({ aeb: 12, ioExb: 6, com: 1 }, 'least-te')
    assert.equal(d.te, 96, `got ${nz(d.counts)}`)
    assert.equal(d.backplanes, 6)
    assert.equal(nz(d.counts), '4x BP-EXB-1, 1x BP-EXB-2, 1x BP-PWR-8')
    // The trade the objective encodes: 12 TE saved for 2 extra backplanes.
    const fewest = decomposeGroup({ aeb: 12, ioExb: 6, com: 1 }, 'fewest-backplanes')
    assert.equal(fewest.te - d.te, 12)
    assert.equal(d.backplanes - fewest.backplanes, 2)
  })

  test('Jaipur JN main group', () => {
    // 2 AEB, 1 IO, 1 COM -> BP-PWR-4 + BP-EXB-1, with two 4 TE slots left spare.
    const d = decomposeGroup({ aeb: 2, ioExb: 1, com: 1 })
    assert.equal(nz(d.counts), '1x BP-EXB-1, 1x BP-PWR-4')
    assert.equal(d.te, 34)
    assert.equal(d.freeSlots4, 2)
  })

  test('Jaipur JN redundant group carries no COM and one more spare slot', () => {
    const d = decomposeGroup({ aeb: 2, ioExb: 1, com: 0 })
    assert.equal(nz(d.counts), '1x BP-EXB-1, 1x BP-PWR-4')
    assert.equal(d.te, 34)
    assert.equal(d.freeSlots4, 3)
  })
})

describe('decomposition invariants', () => {
  const cases = [
    { aeb: 1, ioExb: 0, com: 0 }, { aeb: 0, ioExb: 0, com: 0 },
    { aeb: 0, ioExb: 1, com: 0 }, { aeb: 39, ioExb: 20, com: 1 },
    { aeb: 7, ioExb: 3, com: 2 }, { aeb: 1, ioExb: 12, com: 1 },
  ]

  for (const c of cases) {
    test(`aeb=${c.aeb} io=${c.ioExb} com=${c.com} seats all demand`, () => {
      const d = decomposeGroup(c)
      const slots4 = Object.entries(d.counts).reduce((a, [code, n]) => {
        const b = BACKPLANES.find((x) => x.code === code)!
        return a + b.slots4 * n
      }, 0)
      const slots6 = Object.entries(d.counts).reduce((a, [code, n]) => {
        const b = BACKPLANES.find((x) => x.code === code)!
        return a + b.slots6 * n
      }, 0)
      assert.ok(slots4 >= c.aeb + c.com, `4 TE slots ${slots4} < ${c.aeb + c.com}`)
      assert.ok(slots6 >= c.ioExb, `6 TE slots ${slots6} < ${c.ioExb}`)
      assert.ok(d.pwrCount >= 1, 'every group needs at least one power slot')
      assert.ok(d.freeSlots4 >= 0 && d.freeSlots6 >= 0)
    })
  }

  test('an extension backplane never carries I/O boards under an empty evaluation slot', () => {
    // The leading 4 TE of a BP-EXB is the AEB its I/O boards extend, and
    // `freeSlots4` already counts it as evaluation-board capacity. Seating the
    // power backplanes first used to let them eat those boards, leaving 43 of
    // the reference project's 202 backplanes with I/O under a blank — something
    // the planners' own layouts do exactly zero times in 21 locations. Caught by
    // reading a generated workbook back with `extract_layouts.py`.
    let checked = 0
    let starved = 0
    for (let aeb = 1; aeb <= 40; aeb++) {
      for (let io = 0; io <= 24; io += 2) {
        for (const com of [0, 1, 2]) {
          const d = { aeb, ioExb: io, com }
          const dec = decomposeGroup(d)
          const placed = materialise(dec, d, 'MAIN', 'G1')
          checked += placed.length
          const exb = placed.filter((b) => b.spec.kind === 'EXB')
          const seated = exb.filter((b) => b.contents[0] === 'AEB').length
          // Evaluation boards go to the extension heads FIRST, so every one of
          // them is filled unless the group has fewer boards than backplanes.
          assert.equal(seated, Math.min(exb.length, aeb),
            `aeb=${aeb} io=${io} com=${com}: ${seated} of ${exb.length} extension heads seated`)
          if (aeb >= exb.length) {
            for (const b of exb) {
              assert.equal(b.contents[0], 'AEB',
                `aeb=${aeb} io=${io} com=${com}: ${b.spec.code} seats ${b.contents[0]}`)
            }
          } else starved++
          // No power backplane may hold an evaluation board while an extension
          // head goes without — that is the failure mode exactly.
          if (seated < exb.length) {
            assert.equal(placed.filter((b) => b.spec.kind === 'PWR')
              .reduce((a, b) => a + b.aeb, 0), 0,
            `aeb=${aeb} io=${io} com=${com}: a power backplane took a board an extension needed`)
          }
        }
      }
    }
    assert.ok(checked > 1000, `only ${checked} backplanes exercised`)
    // The starved case is real but degenerate — more I/O backplanes than
    // evaluation boards. It never occurs on this tender, and `leer` is the token
    // the workbook's own formula produces for it. Worth knowing that Gesamt's
    // blanking-plate COUNTIF looks for "spare" and not for "leer", so such a
    // slot would book no plate; nothing on this project exercises it.
    assert.ok(starved > 0, 'the starved case should still be reachable and recorded')
  })

  test('reseating moves no board and changes no free-slot count', () => {
    // The fix above is a seating change, not a hardware change: the BoQ reads
    // `freeSlots4`, which is arithmetic over the decomposition rather than over
    // these tokens, so it must be untouched.
    for (let aeb = 1; aeb <= 30; aeb++) {
      for (let io = 0; io <= 16; io += 2) {
        const d = { aeb, ioExb: io, com: 1 }
        const dec = decomposeGroup(d)
        const placed = materialise(dec, d, 'MAIN', 'G1')
        assert.equal(placed.reduce((a, b) => a + b.aeb, 0), aeb, `aeb ${aeb}/${io}`)
        assert.equal(placed.reduce((a, b) => a + b.ioExb, 0), io, `io ${aeb}/${io}`)
        assert.equal(placed.reduce((a, b) => a + b.freeSlots4, 0), dec.freeSlots4)
        assert.equal(placed.reduce((a, b) => a + b.freeSlots6, 0), dec.freeSlots6)
      }
    }
  })

  test('never emits a variant without a part number', () => {
    const orderable = new Set(BACKPLANES.filter((b) => b.partCode).map((b) => b.code))
    for (let aeb = 0; aeb <= 40; aeb += 3) {
      for (let io = 0; io <= 20; io += 3) {
        const d = decomposeGroup({ aeb, ioExb: io, com: 1 })
        for (const [code, n] of Object.entries(d.counts)) {
          if (n > 0) assert.ok(orderable.has(code), `${code} has no part number`)
        }
      }
    }
  })
})
