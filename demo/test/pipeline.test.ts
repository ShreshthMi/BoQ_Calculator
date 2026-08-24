import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { evaluate, applyRounding, identifiers, partRefs, tokenise } from '../src/expr.ts'
import {
  planLocation, buildDrivers, buildDriversFor, runRulesOverLocations,
  groupsFor, DEFAULT_DECLARATIONS,
} from '../src/engine.ts'
import { assemble, diffAgainstSubmitted } from '../src/boq.ts'
import {
  importProject, loadRules, readSubmittedBoq, buildPartIndex, buildPartIndexWithAliases,
} from '../src/node-io.ts'
import { CODE_ALIASES, applyAliases } from '../src/aliases.ts'
import { splitByLength, mixFor } from '../src/cable.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '..', '..')
const SHEET = join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
const RULES = join(BASE, 'Rule Map', 'rules.seed.json')
const PARTS = join(BASE, 'Part Catalogue', 'parts.json')

describe('stage 1 — import', () => {
  const p = importProject(SHEET)

  test('reads both block shapes and reconciles with the sheet', () => {
    assert.equal(p.totals.locations, 18)
    assert.equal(p.totals.dp, 550, '550 DP as per NIT')
    assert.equal(p.totals.ts, 467)
    assert.deepEqual(p.warnings, [])
  })

  test('ABS is dual detection, Yard single', () => {
    const abs = p.locations.filter((l) => l.scope === 'ABS')
    const yard = p.locations.filter((l) => l.scope === 'YARD')
    assert.equal(abs.length, 8)
    assert.equal(yard.length, 10)
    assert.ok(abs.every((l) => l.detection === 'DUAL'))
    assert.ok(yard.every((l) => l.detection === 'SINGLE'))
    assert.equal(abs.reduce((a, l) => a + l.totalDp, 0), 176)
    assert.equal(yard.reduce((a, l) => a + l.totalDp, 0), 374)
  })

  test('merges the locations that sit on two block sections', () => {
    // Durgapura and Sanganer each appear twice in the ABS block.
    for (const name of ['Durgapura', 'Sanganer']) {
      const l = p.locations.find((x) => x.scope === 'ABS' && x.name === name)!
      assert.equal(l.sections.length, 2, `${name} sections`)
      assert.equal(l.blockSections.length, 2, `${name} block sections`)
    }
    assert.equal(p.locations.filter((l) => l.scope === 'ABS' && l.name === 'Durgapura').length, 1)
  })

  test('keeps per-section counts rather than summing them away', () => {
    const d = p.locations.find((x) => x.scope === 'ABS' && x.name === 'Durgapura')!
    const perSection = d.sections.map((s) => s.dn.dp + s.up.dp)
    assert.deepEqual(perSection.sort(), [2, 6])
    assert.equal(d.totalDp, 16) // (2 + 6) main, mirrored redundant
  })
})

describe('expression evaluator', () => {
  const scope = {
    vars: { DP: 550, TS: 467, AEB: 550, racks: 66, CABLE: null } as Record<string, number | null>,
    part: (k: string) => (k === 'BD005' ? 350 : k === 'BD999' ? null : 10),
  }

  test('arithmetic and precedence', () => {
    assert.equal(evaluate('DP', scope), 550)
    assert.equal(evaluate('TS/2', scope), 233.5)
    assert.equal(evaluate('2 + 3 * 4', scope), 14)
    assert.equal(evaluate('(2 + 3) * 4', scope), 20)
    assert.equal(evaluate('-racks + 70', scope), 4)
  })

  test('floor and ceil', () => {
    assert.equal(evaluate('floor(racks/2)', scope), 33)
    assert.equal(evaluate('ceil(AEB/25)', scope), 22)
  })

  test('part() reads the resolved quantity', () => {
    assert.equal(evaluate('part(BD005)', scope), 350)
    assert.equal(evaluate('part(BD005) * 0.05', scope), 17.5)
  })

  test('null is absorbing — an unavailable driver blanks the whole line', () => {
    assert.equal(evaluate('CABLE', scope), null)
    assert.equal(evaluate('CABLE * 2 + DP', scope), null)
    assert.equal(evaluate('part(BD999)', scope), null)
    assert.equal(evaluate('floor(CABLE/2)', scope), null)
  })

  test('rejects anything outside the grammar — there is no eval here', () => {
    assert.throws(() => evaluate('process.exit(1)', scope), /unknown driver|unexpected/)
    assert.throws(() => evaluate('DP; DP', scope), /unexpected character/)
    assert.throws(() => evaluate('NOPE + 1', scope), /unknown driver 'NOPE'/)
    assert.throws(() => tokenise('DP @ 2'), /unexpected character/)
  })

  test('static analysis finds drivers and part references', () => {
    assert.deepEqual(identifiers('TS/2 + dataTransmissionIO').sort(), ['TS', 'dataTransmissionIO'])
    assert.deepEqual(identifiers('floor(racks/2)'), ['racks'])
    assert.deepEqual(partRefs('part(BD041) * 0.01'), ['BD041'])
    assert.deepEqual(identifiers('part(BD041) * 0.01'), [])
  })

  test('rounding modes', () => {
    assert.equal(applyRounding(17.5, 'UP'), 18)
    assert.equal(applyRounding(17.5, 'DOWN'), 17)
    assert.equal(applyRounding(17.4, 'NEAREST'), 17)
    assert.equal(applyRounding(null, 'UP'), null)
  })
})

describe('stage 2-3 — grouping and packing', () => {
  const p = importProject(SHEET)
  const d = DEFAULT_DECLARATIONS
  const byName = (n: string) => p.locations.find((l) => l.scope === 'ABS' && l.name === n)!

  test('ALH-2 splits into four groups of ten, as the workbook does', () => {
    const g = groupsFor(byName('ALH-2'), d)
    assert.equal(g.length, 4)
    assert.deepEqual(g.map((x) => x.aeb), [10, 10, 10, 10])
    assert.equal(planLocation(byName('ALH-2'), d).pack.rackCount, 4)
  })

  test('ALH-1 folds the directions into two groups of twelve', () => {
    const g = groupsFor(byName('ALH-1'), d)
    assert.equal(g.length, 2)
    assert.deepEqual(g.map((x) => x.aeb), [12, 12])
    assert.equal(planLocation(byName('ALH-1'), d).pack.rackCount, 3)
  })

  test('Durgapura groups per block section, giving 2+2+6+6', () => {
    const g = groupsFor(byName('Durgapura'), d)
    assert.equal(g.length, 4)
    assert.deepEqual(g.map((x) => x.aeb).sort((a, b) => a - b), [2, 2, 6, 6])
    assert.equal(planLocation(byName('Durgapura'), d).pack.rackCount, 3)
  })

  test('single-detection Yard locations never get a BP-EXB-4', () => {
    for (const l of p.locations.filter((x) => x.scope === 'YARD')) {
      assert.equal(planLocation(l, d).pack.backplaneCounts['BP-EXB-4'], 0, l.name)
    }
  })
})

describe('stage 4 — rules', () => {
  const p = importProject(SHEET)
  const d = DEFAULT_DECLARATIONS
  const plans = p.locations.map((l) => planLocation(l, d))
  const rules = loadRules(RULES)
  const run = () => runRulesOverLocations(
    rules, plans.map((x) => buildDriversFor(x, d)), buildDrivers(p, plans, d), d)

  test('every rule resolves to a status', () => {
    const { resolved } = run()
    assert.equal(resolved.size, rules.length)
  })

  test('the only evaluation problems are the two unproduced sensor variants', () => {
    // The 10 m and 15 m tail lengths have no rule: splitting 550 across them is
    // the hand decision the tender actually made. Surfacing it is correct.
    const { problems } = run()
    assert.equal(problems.length, 2)
    assert.ok(problems.every((x) => /BD006|BD007/.test(x)), problems.join(' | '))
  })

  test('location scope matters: the sum of ceilings is not the ceiling of the sum', () => {
    const { resolved } = run()
    // G10 is ceil(AEB / 25) per location, which Gesamt then totals across
    // columns. Rounding up in each of 18 columns accumulates to 32; applying the
    // same rule to the 550 project total would give 22. A ten-unit difference on
    // one line, purely from where the rounding happens.
    assert.equal(resolved.get('G10')!.qty, 32)
    assert.equal(Math.ceil(550 / 25), 22)
  })

  test('project-scoped rules are not summed per location', () => {
    const { resolved } = run()
    // The tube follows the sensor 1:1 across the whole project, so it is 550 —
    // not 550 counted once per location.
    assert.equal(resolved.get('G06a')!.rule.scope, 'project')
    assert.equal(resolved.get('G06a')!.qty, 550)
  })

  test('a dormant declaration blanks its rules rather than zeroing them', () => {
    const off = runRulesOverLocations(
      rules, plans.map((x) => buildDriversFor(x, d)), buildDrivers(p, plans, d),
      { ...d, powerAbove120W: false })
    const fan = off.resolved.get('G56')!
    assert.equal(fan.status, 'dormant')
    assert.equal(fan.qty, null, 'dormant must be blank, never 0')
  })

  test('DP drives the trackside lines to 550', () => {
    const { resolved } = run()
    for (const id of ['G05', 'G07', 'G09', 'G13']) {
      assert.equal(resolved.get(id)!.qty, 550, id)
    }
  })
})

describe('stage 5 — overrides and staleness', () => {
  const p = importProject(SHEET)
  const d = DEFAULT_DECLARATIONS
  const plans = p.locations.map((l) => planLocation(l, d))
  const rules = loadRules(RULES)
  const ov = [{
    partKey: 'BD005', qty: 350, driverSnapshot: 550,
    reason: 'cable-length split', by: 'test', at: '2026-01-01',
  }]
  const run = (overrides: typeof ov) => {
    const { resolved } = runRulesOverLocations(
      rules, plans.map((x) => buildDriversFor(x, d)), buildDrivers(p, plans, d), d,
      (k) => overrides.find((o) => o.partKey === k)?.qty ?? null)
    return assemble(resolved, overrides)
  }

  test('an override in step with the rules reads as override, not stale', () => {
    const line = run(ov).find((l) => l.ruleId === 'G05')!
    assert.equal(line.main, 350)
    assert.equal(line.provenance, 'override')
  })

  test('the effective quantity feeds forward to dependent rules', () => {
    // The protection tube follows the sensor 1:1, so overriding the sensor to
    // 350 must move the tube too — not leave it at the derived 550.
    const lines = run(ov)
    assert.equal(lines.find((l) => l.ruleId === 'G06a')!.main, 350)
    // and the 5 % spare is 5 % of what is actually bought
    assert.equal(lines.find((l) => l.ruleId === 'G05')!.spare, Math.ceil(350 * 0.05))
  })

  test('a moved driver marks the override stale rather than dropping it', () => {
    const stale = [{ ...ov[0]!, driverSnapshot: 500 }] // rules now say 550
    const line = run(stale).find((l) => l.ruleId === 'G05')!
    assert.equal(line.provenance, 'stale')
    assert.equal(line.main, 350, 'the hand-entered value survives')
    assert.match(line.note!, /entered against 500, rules now say 550/)
  })

  test('an override on a part with no rule is kept, not flagged', () => {
    const manual = [{
      partKey: 'BD045', qty: 315, driverSnapshot: null,
      reason: 'no rule exists', by: 'test', at: '2026-01-01',
    }]
    const line = run(manual).find((l) => l.partKey === 'BD045')!
    assert.equal(line.main, 315)
    assert.equal(line.provenance, 'override')
  })
})

describe('diff against the submitted BoQ', () => {
  const submitted = readSubmittedBoq(SHEET)

  test('reads all 41 lines of sheet "10.  BOQ"', () => {
    assert.equal(submitted.length, 41)
  })

  test('the submitted BoQ books no spares at all', () => {
    // 41 lines, every Spare cell zero — despite the workbook carrying 27 spare
    // rules at 5 % and 1 %. Worth a conversation with the bid team.
    assert.equal(submitted.reduce((a, s) => a + s.spare, 0), 0)
  })

  test('generated lines match the submitted quantities where a rule exists', () => {
    const p = importProject(SHEET)
    const d = DEFAULT_DECLARATIONS
    const plans = p.locations.map((l) => planLocation(l, d))
    const rules = loadRules(RULES)
    const { resolved } = runRulesOverLocations(
      rules, plans.map((x) => buildDriversFor(x, d)), buildDrivers(p, plans, d), d)
    const { summary } = diffAgainstSubmitted(
      assemble(resolved, []), submitted, buildPartIndex(PARTS))
    assert.ok(summary['match']! >= 8, `expected at least 8 matches, got ${summary['match']}`)
    assert.equal(
      summary['match']! + summary['differs']! + summary['blank']! + summary['missing']!,
      41,
    )
  })
})

describe('the cable-length split', () => {
  const p = importProject(SHEET)
  const split = splitByLength(p.locations)

  test('reproduces the hidden BoQ sheet exactly', () => {
    // Applying the questionnaire's guideline (B151 item 16) to the real scopes:
    //   5 m  = 0.75 x 374 (station) + 0.50 x 176 (auto block) = 368.5 -> 369
    //   10 m = 0.15 x 374           + 0.50 x 176              = 144.1 -> 144
    //   15 m = 0.10 x 374                                     =  37.4 ->  37
    // The hidden sheet '10. BoQ' books 369 / 144 / 37. The shipped sheet
    // '10.  BOQ' books 350 / 163 / 37 — 19 units moved by hand, afterwards,
    // recorded nowhere.
    assert.deepEqual([split.m5, split.m10, split.m15], [369, 144, 37])
  })

  test('the three lengths always account for every detection point', () => {
    assert.equal(split.m5 + split.m10 + split.m15, 550)
    assert.equal(split.total, p.totals.dp)
  })

  test('station and auto-block take different mixes', () => {
    assert.deepEqual(mixFor('STATION', 'SINGLE', false), { m5: 0.75, m10: 0.15, m15: 0.10 })
    assert.deepEqual(mixFor('STATION', 'DUAL', true), { m5: 0, m10: 0.75, m15: 0.25 })
    assert.deepEqual(mixFor('AUTO_BLOCK', 'DUAL', false), { m5: 0.5, m10: 0.5, m15: 0 })
    assert.deepEqual(mixFor('ABSOLUTE_BLOCK', 'SINGLE', false), { m5: 1, m10: 0, m15: 0 })
  })

  test('the shipped BoQ differs from the guideline by exactly 19 units', () => {
    const shipped = readSubmittedBoq(SHEET)
    const q = (code: string) => shipped.find((s) => s.code === code)!.main
    assert.equal(q('102058'), 350)
    assert.equal(q('101880'), 163)
    assert.equal(split.m5 - q('102058'), 19)
    assert.equal(q('101880') - split.m10, 19)
  })
})

describe('G36 — one COM board per evaluation group', () => {
  const p = importProject(SHEET)
  const d = DEFAULT_DECLARATIONS
  const plans = p.locations.map((l) => planLocation(l, d))

  test('COM equals the group count', () => {
    // A COM board is one CAN segment. Gesamt!AI88 'Redundancy COM' is set on
    // this project, so each segment carries one COM per system — one per group.
    for (const plan of plans) {
      assert.equal(plan.pack.comSeated, plan.groups.length, plan.location.name)
    }
  })

  test('the rule produces 46 against the submitted 42', () => {
    const rules = loadRules(RULES)
    const { resolved } = runRulesOverLocations(
      rules, plans.map((x) => buildDriversFor(x, d)), buildDrivers(p, plans, d), d)
    const com = resolved.get('G36')!
    assert.equal(com.status, 'derived', 'G36 is no longer MANUAL')
    assert.equal(com.qty, 46)

    // The shipped BoQ books 42. The four missing boards are the redundant COM at
    // Jaipur JN, Durgapura, Sanganer and Sheodaspura — the same four locations
    // the packer already warns about.
    const submitted = readSubmittedBoq(SHEET).find((s) => s.code === '23152')!
    assert.equal(submitted.main, 42)
    assert.equal(com.qty! - submitted.main, 4)
  })

  test('the four short locations are the ones that warn', () => {
    const warned = plans
      .filter((x) => x.pack.warnings.some((w) => /no COM board/.test(w)))
      .map((x) => x.location.name)
    assert.deepEqual(warned, [])  // with comPerGroup = 1 every group has one
  })
})

describe('part-code aliases', () => {
  const { index, aliases } = buildPartIndexWithAliases(PARTS)

  test('the table is clean — every target exists, none redundant', () => {
    assert.deepEqual(aliases.unknownTarget, [], 'alias points at a part that is not in the catalogue')
    assert.deepEqual(aliases.shadowed, [], 'catalogue now carries the code; delete the alias')
    assert.equal(aliases.applied.length, 1)
  })

  test('24422 resolves to the deflector', () => {
    assert.equal(index.get('24422'), 'BD018')
  })

  test('every alias carries its evidence', () => {
    for (const a of CODE_ALIASES) {
      assert.ok(a.evidence.length > 60, `${a.code} needs evidence, not a bare mapping`)
    }
  })

  test('an alias never overwrites a real catalogue code', () => {
    const idx = new Map([['101950', 'BD018']])
    const r = applyAliases(idx, new Set(['BD018', 'BD071']), [
      { code: '101950', partKey: 'BD071', evidence: 'x'.repeat(70) },
    ])
    assert.equal(idx.get('101950'), 'BD018', 'catalogue wins')
    assert.equal(r.shadowed.length, 1)
    assert.equal(r.applied.length, 0)
  })

  test('an alias to a non-existent part is reported, not applied', () => {
    const idx = new Map<string, string>()
    const r = applyAliases(idx, new Set(['BD018']), [
      { code: '99999', partKey: 'BD999', evidence: 'x'.repeat(70) },
    ])
    assert.equal(r.unknownTarget.length, 1)
    assert.equal(idx.size, 0)
  })

  test('the deflector line matches once the alias is applied', () => {
    const p = importProject(SHEET)
    const d = DEFAULT_DECLARATIONS
    const plans = p.locations.map((l) => planLocation(l, d))
    const { resolved } = runRulesOverLocations(
      loadRules(RULES), plans.map((x) => buildDriversFor(x, d)), buildDrivers(p, plans, d), d)
    const { rows } = diffAgainstSubmitted(assemble(resolved, []), readSubmittedBoq(SHEET), index)
    const deflector = rows.find((r) => r.code === '24422')!
    assert.equal(deflector.verdict, 'match')
    assert.equal(deflector.submitted, 550)
    assert.equal(deflector.generated, 550)
  })
})
