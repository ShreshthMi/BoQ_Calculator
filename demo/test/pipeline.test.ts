import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { evaluate, applyRounding, identifiers, partRefs, tokenise } from '../src/expr.ts'
import {
  planLocation, buildDrivers, buildDriversFor, runRulesOverLocations,
  groupsFor, columnsOf, DEFAULT_DECLARATIONS,
} from '../src/engine.ts'
import { assemble, diffAgainstSubmitted, type Override } from '../src/boq.ts'
import {
  importProject, importManualProject, loadRules, readSubmittedBoq, buildPartIndex,
  buildPartIndexWithAliases,
} from '../src/node-io.ts'
import {
  buildProject, toInput, setRoomCount, blankLocation, blankProject, validate,
  nextLocationId, type ProjectInput,
} from '../src/project.ts'
import { CODE_ALIASES, applyAliases } from '../src/aliases.ts'
import { splitByLength, mixFor } from '../src/cable.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '..', '..')
const SHEET = join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
const RULES = join(BASE, 'Rule Map', 'rules.seed.json')
const PARTS = join(BASE, 'Part Catalogue', 'parts.json')
const MANUAL = join(HERE, '..', 'fixtures', 'nwr-jaipur-manual.json')

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
  const ov: Override[] = [{
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
    const manual: Override[] = [{
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
    assert.equal(split.m5! + split.m10! + split.m15!, 550)
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
    assert.equal(split.m5! - q('102058'), 19)
    assert.equal(q('101880') - split.m10!, 19)
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

/* ------------------------------------------------------------------------- */
/* The second route in: a project entered by hand, with no workbook behind it */
/* ------------------------------------------------------------------------- */

const decl = DEFAULT_DECLARATIONS

/** The whole pipeline, from a project to the numbers that come out of it. */
function pipeline(project: ReturnType<typeof importProject>) {
  const plans = project.locations.map((l) => planLocation(l, decl))
  const columns = columnsOf(plans)
  const { resolved, problems } = runRulesOverLocations(
    loadRules(RULES),
    columns.map((p) => buildDriversFor(p, decl, project.cableSource)),
    buildDrivers(project, plans, decl),
    decl,
  )
  const lines = assemble(resolved, [])
  const backplanes: Record<string, number> = {}
  for (const pl of plans) {
    for (const [code, n] of Object.entries(pl.pack.backplaneCounts)) {
      backplanes[code] = (backplanes[code] ?? 0) + n
    }
  }
  return {
    plans, columns, resolved, problems, lines, backplanes,
    racks: plans.reduce((a, p) => a + p.pack.rackCount, 0),
    qty: (id: string) => resolved.get(id)!.qty,
    diff: diffAgainstSubmitted(lines, readSubmittedBoq(SHEET), buildPartIndex(PARTS)).summary,
  }
}

describe('the hand-entry route', () => {
  const imported = importProject(SHEET)
  const manual = importManualProject(MANUAL)
  // `source` is the one field that must differ: one names a file, one does not.
  const shape = (p: typeof imported) => JSON.parse(JSON.stringify({ ...p, source: '' }))

  test('reproduces the imported project exactly, field for field', () => {
    // The strongest check there is that the two doors lead to the same room:
    // the same 18 locations, the same per-section counts, the same totals, the
    // same absence of warnings — from typed numbers rather than from a workbook.
    assert.deepEqual(shape(manual), shape(imported))
  })

  test('and therefore the same BoQ and the same diff', () => {
    const a = pipeline(imported)
    const b = pipeline(manual)
    assert.equal(b.racks, 66)
    assert.equal(b.qty('G05'), 550)
    assert.deepEqual(b.diff, a.diff)
    assert.deepEqual(b.lines.map((l) => [l.ruleId, l.main]), a.lines.map((l) => [l.ruleId, l.main]))
  })

  test('a project round-trips through the entered data it was built from', () => {
    // Export writes the INPUT, not the derived project. That only works if
    // rebuilding from it reproduces every derived figure.
    assert.deepEqual(shape(buildProject(toInput(imported))), shape(imported))
    const text = JSON.stringify(toInput(imported))
    assert.deepEqual(shape(buildProject(JSON.parse(text) as ProjectInput)), shape(imported))
  })

  test('everything derivable is derived, not asked for', () => {
    const p = buildProject({
      locations: [{
        name: 'Test', scope: 'ABS',
        sections: [{ name: 'A-B', dn: { dp: 6, ts: 5 }, up: { dp: 2, ts: 1 } }],
      }],
    })
    const l = p.locations[0]!
    assert.equal(l.id, 'A01')
    assert.equal(l.detection, 'DUAL', 'ABS defaults to dual detection')
    assert.equal(l.application, 'AUTO_BLOCK')
    assert.deepEqual(l.dn, { dp: 6, ts: 5 })
    assert.equal(l.totalDp, 16, 'dual detection mirrors the main system')
    assert.equal(l.totalTs, 12)
    assert.deepEqual(l.blockSections, ['A-B'])
    assert.equal(l.rooms.length, 1)
    assert.deepEqual(p.totals, { dp: 16, ts: 12, locations: 1, rooms: 1 })
  })

  test('an empty project is empty rather than broken', () => {
    const p = buildProject(blankProject())
    assert.deepEqual(p.locations, [])
    assert.deepEqual(p.totals, { dp: 0, ts: 0, locations: 0, rooms: 0 })
    assert.deepEqual(p.warnings, [])
    assert.equal(pipeline(p).racks, 0)
  })

  test('reconciliation reports a disagreement rather than resolving it', () => {
    // The sheet's own No of Location says 18 while the calculators carry 21, and
    // cell E13 says the DP table was adjusted "To Match the Quantity". Stated
    // figures are a check, never a source.
    const p = buildProject({
      stated: { 'Total DP': 600, 'No of Location': 2 },
      locations: [blankLocation('YARD', 'Alpha')],
    })
    assert.ok(p.warnings.some((w) => /Total DP: 0 from the locations, 600 stated/.test(w)))
    assert.ok(p.warnings.some((w) => /No of Location: 1 from the locations, 2 stated/.test(w)))
  })

  test('hand-entry mistakes are named', () => {
    const p = buildProject({
      locations: [
        { name: 'Alpha', scope: 'YARD', sections: [{ dn: { dp: 4, ts: 3 }, up: { dp: 0, ts: 0 } }] },
        { name: 'alpha', scope: 'YARD', sections: [{ dn: { dp: 1, ts: 1 }, up: { dp: 0, ts: 0 } }] },
        blankLocation('YARD', 'Empty'),
      ],
    })
    assert.ok(p.warnings.some((w) => /two YARD locations share this name/.test(w)))
    assert.ok(p.warnings.some((w) => /Empty: no detection points/.test(w)))
  })
})

describe('equipment rooms — the racks the input sheet cannot express', () => {
  const imported = importProject(SHEET)

  const withRooms = (names: string[]) => {
    const input = toInput(imported)
    input.locations = input.locations.map((l) =>
      (l.scope === 'YARD' && names.includes(l.name) ? setRoomCount(l, 2) : l))
    return buildProject(input)
  }

  test('splitting a station puts the down line in one room and the up line in the other', () => {
    // Which is what the workbook does: Devpura Acc-1 carries 22 evaluation
    // boards against 29 in Acc-2 — exactly the down and up counts of the single
    // row the input sheet has for Devpura.
    const devpura = withRooms(['Devpura']).locations.find((l) => l.name === 'Devpura')!
    assert.equal(devpura.rooms.length, 2)
    assert.deepEqual(devpura.rooms.map((r) => r.name), ['Devpura Acc-1', 'Devpura Acc-2'])
    assert.deepEqual(devpura.rooms.map((r) => r.sections[0]!.dn.dp), [22, 0])
    assert.deepEqual(devpura.rooms.map((r) => r.sections[0]!.up.dp), [0, 29])
    assert.equal(devpura.totalDp, 51, 'not one detection point moves')
    assert.equal(devpura.totalTs, 40)
  })

  test('Devpura and Snaganer in two rooms each give the 68 racks that shipped', () => {
    // The submitted BoQ books 68 BGT07 racks and the tool derives 66, because
    // the planner sited those two stations' down and up lines in separate
    // equipment rooms and a rack cannot span two rooms. Nothing else about the
    // project changes: the same boards, in one more rack at each.
    const roomed = pipeline(withRooms(['Devpura', 'Snaganer']))
    const flat = pipeline(imported)
    assert.equal(flat.racks, 66)
    assert.equal(roomed.racks, 68)
    assert.equal(roomed.qty('G14'), 68)
    assert.equal(roomed.qty('G36'), flat.qty('G36'), 'COM is per group, and the groups do not move')
    assert.equal(roomed.qty('G35'), flat.qty('G35'), 'nor does board demand')
    assert.equal(roomed.diff['match'], flat.diff['match']! + 1, 'the rack line now matches')
  })

  test('the room is the evaluation column, so per-location rules see it', () => {
    // Gesamt computes every row in each location sheet's column and totals
    // across, and the calculators carry one sheet per equipment room — 21 of
    // them against this sheet's 18 locations. So ceil(racks / 6) is asked of
    // each room: two rooms cannot share a cubicle.
    const roomed = withRooms(['Devpura', 'Snaganer'])
    assert.equal(roomed.totals.locations, 18)
    assert.equal(roomed.totals.rooms, 20)
    const r = pipeline(roomed)
    assert.equal(r.columns.length, 20)
    assert.equal(r.qty('G55'), 20, 'one cubicle per room, not one per station')
    assert.equal(pipeline(imported).qty('G55'), 18)
  })

  test('the backplane mix does not move, and is not made to', () => {
    // Rooms fix the rack count and nothing else. The shipped BoQ books one more
    // BP-EXB-1 and one more BP-EXB-2 than the packer does, because at three of
    // the room sheets the planner used a wider mix than necessary. That is a
    // difference to report, not to tune away.
    const roomed = pipeline(withRooms(['Devpura', 'Snaganer']))
    assert.equal(roomed.backplanes['BP-EXB-1'], 26)
    assert.equal(roomed.backplanes['BP-EXB-2'], 91)
    assert.equal(roomed.backplanes['BP-PWR-8'], 56)
  })

  test('merging rooms back adds the sections up again', () => {
    const before = toInput(imported).locations.find((l) => l.name === 'Devpura')!
    const split = setRoomCount(before, 2)
    const merged = setRoomCount(split, 1)
    assert.equal(merged.rooms!.length, 1)
    assert.deepEqual(
      buildProject({ locations: [merged] }).locations[0]!.sections,
      buildProject({ locations: [before] }).locations[0]!.sections,
    )
  })

  test('a location with two block sections keeps them inside its room', () => {
    const durgapura = importProject(SHEET).locations.find(
      (l) => l.scope === 'ABS' && l.name === 'Durgapura')!
    assert.equal(durgapura.rooms.length, 1)
    assert.equal(durgapura.rooms[0]!.sections.length, 2, 'one room, two block sections')
    assert.equal(planLocation(durgapura, decl).pack.rackCount, 3)
  })
})

describe('measured cable runs switch the guideline off', () => {
  const imported = importProject(SHEET)

  /** Distribute a project-wide 350 / 163 / 37 across the locations. */
  const measured = (plan: [number, number, number]) => {
    const input = toInput(imported)
    input.cableSource = 'measured'
    let left = [...plan]
    input.locations.forEach((l, i) => {
      const dp = imported.locations[i]!.totalDp
      const m5 = Math.min(left[0]!, dp)
      const m10 = Math.min(left[1]!, dp - m5)
      const m15 = dp - m5 - m10
      left = [left[0]! - m5, left[1]! - m10, left[2]! - m15]
      l.cable = { m5, m10, m15 }
    })
    return buildProject(input)
  }

  test('the guideline is what the tool derives when nothing was measured', () => {
    const split = splitByLength(imported.locations, imported.cableSource)
    assert.equal(split.source, 'guideline')
    assert.deepEqual([split.m5, split.m10, split.m15], [369, 144, 37])
  })

  test('counted runs are used as counted, with no percentage applied', () => {
    const p = measured([350, 163, 37])
    const split = splitByLength(p.locations, p.cableSource)
    assert.equal(split.source, 'measured')
    assert.deepEqual([split.m5, split.m10, split.m15], [350, 163, 37])
    const r = pipeline(p)
    assert.deepEqual([r.qty('K01'), r.qty('K02'), r.qty('K03')], [350, 163, 37])
    // Two more lines of the submitted BoQ now agree, and the 19-unit hand
    // adjustment stops being an unexplained override.
    assert.equal(r.diff['match'], pipeline(imported).diff['match']! + 2)
  })

  test('the guideline is still reported, so both figures stay visible', () => {
    // Superseding a stated default silently would be the same mistake as
    // overriding it silently. The estimate travels alongside the measurement.
    const split = splitByLength(measured([350, 163, 37]).locations, 'measured')
    assert.deepEqual(
      [split.guideline.m5, split.guideline.m10, split.guideline.m15], [369, 144, 37])
  })

  test('an incomplete cable plan blanks the kit lines rather than guessing', () => {
    const input = toInput(imported)
    input.cableSource = 'measured'
    input.locations[0]!.cable = { m5: 31, m10: 0, m15: 0 }
    const p = buildProject(input)
    const split = splitByLength(p.locations, 'measured')
    assert.equal(split.m5, null, 'blank, never a silent zero')
    assert.equal(split.unmeasured.length, 17)
    const r = pipeline(p)
    for (const id of ['K01', 'K02', 'K03']) {
      assert.equal(r.qty(id), null, id)
      assert.equal(r.lines.find((l) => l.ruleId === id)!.provenance, 'blank', id)
    }
    assert.ok(p.warnings.some((w) => /cable lengths are measured/.test(w)))
  })

  test('a plan that does not add up blanks too, rather than under-booking', () => {
    // Every detection point takes exactly one trackside kit, so K01 + K02 + K03
    // has to equal what G05 books for sensors. Booking a plan that is short
    // would put a BoQ into print contradicting its own sensor line.
    const input = toInput(imported)
    input.cableSource = 'measured'
    for (const l of input.locations) l.cable = { m5: 1, m10: 0, m15: 0 }
    const p = buildProject(input)
    assert.ok(p.warnings.some((w) => /cable runs total 1 against 31 detection points/.test(w)))
    const split = splitByLength(p.locations, 'measured')
    assert.equal(split.m5, null)
    assert.equal(split.mismatched.length, 18)
    const r = pipeline(p)
    assert.equal(r.qty('K01'), null)
    assert.equal(r.qty('G05'), 550, 'the sensor line is unaffected, which is the point')
  })

  test('an all-zero entry counts as not measured, not as no cable', () => {
    const input = toInput(imported)
    input.cableSource = 'measured'
    for (const l of input.locations) l.cable = { m5: 0, m10: 0, m15: 0 }
    const p = buildProject(input)
    const split = splitByLength(p.locations, 'measured')
    assert.equal(split.m5, null, 'zero runs is an absence of information, not an answer')
    assert.equal(split.unmeasured.length, 18)
  })
})

describe('application type — the guideline rows the sheet cannot reach', () => {
  test('it selects the mix, and defaults to what the scope implies', () => {
    const p = buildProject({
      locations: [
        { name: 'Yard', scope: 'YARD', sections: [{ dn: { dp: 100, ts: 0 }, up: { dp: 0, ts: 0 } }] },
      ],
    })
    assert.equal(p.locations[0]!.application, 'STATION')
    const split = splitByLength(p.locations)
    assert.deepEqual([split.m5, split.m10, split.m15], [75, 15, 10])
  })

  test('IBH and absolute block are unreachable from a scope alone', () => {
    // The questionnaire gives four applications; the input sheet's two scopes
    // can only ever produce two of them. Declaring it per location is the only
    // way the other two rows of that table are ever used.
    const ibh = buildProject({
      locations: [{
        name: 'Halt', scope: 'YARD', application: 'IBH',
        sections: [{ dn: { dp: 100, ts: 0 }, up: { dp: 0, ts: 0 } }],
      }],
    })
    const split = splitByLength(ibh.locations)
    assert.deepEqual([split.m5, split.m10, split.m15], [100, 0, 0], 'single IBH is all 5 m')
  })
})

describe('what declaring an equipment room actually moves', () => {
  const imported = importProject(SHEET)
  const withRooms = (names: string[]) => {
    const input = toInput(imported)
    input.locations = input.locations.map((l) =>
      (l.scope === 'YARD' && names.includes(l.name) ? setRoomCount(l, 2) : l))
    return buildProject(input)
  }

  test('the whole location-scoped rule set moves, not only the rack line', () => {
    // Worth pinning explicitly, because "rooms just fix the rack count" is the
    // easy thing to believe and it is not true. A room is a Gesamt column, so
    // every per-column rule is asked once more.
    const flat = pipeline(imported)
    const roomed = pipeline(withRooms(['Devpura', 'Snaganer']))
    const moved = (id: string) => [flat.qty(id), roomed.qty(id)]
    assert.deepEqual(moved('G14'), [66, 68], 'racks — and 68 is what shipped')
    assert.deepEqual(moved('G55'), [18, 20], 'cubicles, against a shipped 22')
    assert.deepEqual(moved('G10'), [32, 33], 'testing plates, one per 25 boards per column')
    assert.deepEqual(moved('G12'), [32, 33], 'service displays, the same shape')
    assert.deepEqual(moved('G49'), [18, 20], 'planning, one per column')
    assert.deepEqual(moved('G58'), [18, 20], 'cubicle wiring, which follows the cubicles')
    // FDS moves the WRONG way, and saying so is the point of listing these.
    // The rule gives one per column; the tender shipped 12 for 18 locations.
    assert.deepEqual(moved('G53'), [18, 20], 'FDS — further from the shipped 12, not closer')
    // and what does not move, because it is per group or per detection point
    assert.deepEqual(moved('G36'), [46, 46], 'COM, one per evaluation group')
    assert.deepEqual(moved('G35'), [46, 46], 'PSC')
    assert.deepEqual(moved('G05'), [550, 550], 'sensors')
    assert.deepEqual(moved('G41'), [248, 248], 'backplane connectors')
  })

  test('all three split stations reproduce the calculators’ 21 sheets', () => {
    // The workbook carries 21 location sheets against the input sheet's 18 rows.
    // Splitting the third station too is neutral on racks — the planner fitted
    // Durgapur into 2 + 3 where the tool fits 5 — but it is what was built.
    const all = withRooms(['Devpura', 'Snaganer', 'Durgapura'])
    assert.equal(all.totals.rooms, 21)
    const r = pipeline(all)
    assert.equal(r.columns.length, 21)
    assert.equal(r.racks, 68, 'still 68; the third split costs nothing')
    assert.equal(r.qty('G55'), 21, 'one cubicle per room, against a shipped 22')
  })

  test('a small station gains a COM board when it is split, and should', () => {
    // Two rooms are two CAN segments, so two COM boards. Every Acc- sheet in the
    // reference carries exactly one group and one COM, which is the same fact
    // read off the workbook. It is a consequence of the declaration, not a bug.
    const one = buildProject({
      locations: [{
        name: 'Halt', scope: 'YARD',
        sections: [{ dn: { dp: 6, ts: 6 }, up: { dp: 6, ts: 6 } }],
      }],
    })
    const two = buildProject({ locations: [setRoomCount(toInput(one).locations[0]!, 2)] })
    assert.equal(planLocation(one.locations[0]!, decl).groups.length, 1, 'folded into one group')
    assert.equal(planLocation(two.locations[0]!, decl).groups.length, 2, 'one per room')
    assert.equal(pipeline(one).qty('G36'), 1)
    assert.equal(pipeline(two).qty('G36'), 2)
  })
})

describe('a project with nothing in it answers nothing', () => {
  test('no locations means blank lines, never a BoQ of zeros', () => {
    // The failure mode this guards against is quiet: summing an empty list gives
    // zero for every driver, and a BoQ of zeros reads as a real answer of "none
    // required" rather than as an unanswered question.
    const r = pipeline(buildProject(blankProject()))
    assert.equal(r.qty('G05'), null)
    assert.equal(r.qty('G14'), null)
    assert.equal(r.lines.find((l) => l.ruleId === 'G05')!.provenance, 'blank')
    assert.equal(r.lines.every((l) => l.main === null), true, 'not one zero anywhere')
  })
})

describe('naming a location unambiguously', () => {
  test('a name shared across scopes carries its scope in warnings', () => {
    // This tender really does carry a Durgapura and a Sheodaspura in BOTH the
    // Yard and the ABS block. A warning that says only "Durgapura" sends
    // someone to the wrong row.
    const input = toInput(importProject(SHEET))
    input.cableSource = 'measured'
    const p = buildProject(input)
    const named = p.warnings.filter((w) => /^Durgapura/.test(w))
    assert.equal(named.length, 2)
    assert.ok(named.some((w) => w.startsWith('Durgapura (YARD)')))
    assert.ok(named.some((w) => w.startsWith('Durgapura (ABS)')))
    assert.ok(p.warnings.some((w) => w.startsWith('Chaksu:')), 'unshared names stay plain')
  })
})

/* ------------------------------------------------------------------------- */
/* What an adversarial review of the hand-entry route turned up               */
/* ------------------------------------------------------------------------- */

describe('defects the review found', () => {
  test('the guideline split never books a negative quantity', () => {
    // The 15 m bucket used to absorb all the rounding drift on its own. Two
    // shares landing on .5 inflate by half a unit each, the absorber pays for
    // both, and with a small enough 15 m share it pays more than it has — a
    // negative number on a BoQ line. 200 of these 3,200 cases used to fail.
    let negative = 0
    let mismatched = 0
    for (const application of ['STATION', 'AUTO_BLOCK', 'IBH', 'ABSOLUTE_BLOCK'] as const) {
      for (const detection of ['SINGLE', 'DUAL'] as const) {
        for (let dp = 1; dp <= 400; dp++) {
          const p = buildProject({
            locations: [{
              name: 'L', scope: 'YARD', detection, application,
              sections: [{ dn: { dp, ts: 0 }, up: { dp: 0, ts: 0 } }],
            }],
          })
          const s = splitByLength(p.locations)
          if (s.m5! < 0 || s.m10! < 0 || s.m15! < 0) negative++
          if (s.m5! + s.m10! + s.m15! !== p.totals.dp) mismatched++
        }
      }
    }
    assert.equal(negative, 0, 'a kit line cannot book a negative quantity')
    assert.equal(mismatched, 0, 'every detection point still takes exactly one kit')
  })

  test('splitting and merging rooms is a round trip, not a demolition', () => {
    // `setRoomCount` merged sections by name across every source room, so two
    // sections of the SAME room — which share a name by default, both taking the
    // location's — folded into each other. The detection points survived and an
    // evaluation system did not.
    const two: ProjectInput['locations'][number] = {
      name: 'Block 1', scope: 'ABS',
      sections: [
        { dn: { dp: 4, ts: 3 }, up: { dp: 0, ts: 0 } },
        { dn: { dp: 9, ts: 7 }, up: { dp: 0, ts: 0 } },
      ],
    }
    const shape = (li: typeof two) => {
      const l = buildProject({ locations: [li] }).locations[0]!
      return {
        sections: l.sections.length,
        dp: l.totalDp,
        groups: planLocation(l, decl).groups.length,
      }
    }
    const before = shape(two)
    assert.deepEqual(before, { sections: 2, dp: 26, groups: 4 })
    assert.deepEqual(shape(setRoomCount(setRoomCount(two, 2), 1)), before)
    assert.deepEqual(shape(setRoomCount(setRoomCount(two, 3), 1)), before)
  })

  test('a section keeps the location name whatever the room count', () => {
    // `toInput` drops a section name equal to the location's, on the ground that
    // it is re-derived. It has to be re-derived as the SAME thing — falling back
    // to the room name once there are two rooms made the round trip lossy, and
    // it compounded: the next pass wrote "X Acc-1" into the input, the
    // merge-by-name stopped folding, and one section became two.
    const split = setRoomCount({
      name: 'Devpura', scope: 'YARD',
      sections: [{ dn: { dp: 22, ts: 16 }, up: { dp: 29, ts: 24 } }],
    }, 2)
    const p = buildProject({ locations: [split] })
    assert.deepEqual(p.locations[0]!.sections.map((s) => s.name), ['Devpura', 'Devpura'])
    const again = buildProject(toInput(p))
    assert.deepEqual(
      JSON.parse(JSON.stringify({ ...again, source: '' })),
      JSON.parse(JSON.stringify({ ...p, source: '' })),
      'buildProject(toInput(p)) is identity for a multi-room location too',
    )
  })

  test('an ABS location reports its block sections, not its room names', () => {
    const p = buildProject({
      locations: [setRoomCount({
        name: 'Kanota', scope: 'ABS',
        sections: [{ dn: { dp: 3, ts: 2 }, up: { dp: 3, ts: 2 } }],
      }, 2)],
    })
    assert.deepEqual(p.locations[0]!.blockSections, ['Kanota'])
  })

  test('an id belongs to its row, and removing a location does not move it', () => {
    // `openId` and `locId` in the app find a location by id. Ids minted from
    // array position on every rebuild would renumber on a delete and silently
    // re-point the open detail panel at a different station.
    const input = toInput(importProject(SHEET))
    const before = input.locations.map((l) => `${l.name}=${l.id}`)
    input.locations = input.locations.filter((l) => l.name !== 'Chaksu')
    const after = buildProject(input).locations.map((l) => `${l.name}=${l.id}`)
    for (const entry of after) assert.ok(before.includes(entry), `${entry} moved`)
    // and a new location takes a free id rather than one already in use
    const fresh = nextLocationId(input.locations, 'YARD')
    assert.equal(fresh, 'Y01', 'the id the deleted location freed')
    assert.ok(!input.locations.some((l) => l.id === fresh))
  })

  test('a project-scoped rule sees what the columns actually booked', () => {
    // The project pass used to run BEFORE the per-column sums, so a
    // project-scoped rule referencing a location-scoped one read that rule's
    // own project-driver value. G54 follows the FDS count: ceil(840/110) is 8
    // against the eighteen columns' 18.
    const p = importProject(SHEET)
    const plans = p.locations.map((l) => planLocation(l, decl))
    const { resolved } = runRulesOverLocations(
      loadRules(RULES),
      columnsOf(plans).map((x) => buildDriversFor(x, decl, p.cableSource)),
      buildDrivers(p, plans, decl), decl,
    )
    assert.equal(resolved.get('G53')!.qty, 18, 'FDS, summed over the columns')
    assert.equal(resolved.get('G54')!.qty, resolved.get('G53')!.qty, 'wiring follows it')
  })

  test('a blank column result blanks the rule that references it', () => {
    // The referencing rule must not fall back to a confident project-level
    // number when the thing it depends on could not be resolved.
    const p = buildProject(blankProject())
    const plans = p.locations.map((l) => planLocation(l, decl))
    const { resolved } = runRulesOverLocations(
      loadRules(RULES),
      columnsOf(plans).map((x) => buildDriversFor(x, decl, p.cableSource)),
      buildDrivers(p, plans, decl), decl,
    )
    assert.equal(resolved.get('G54')!.qty, null)
  })
})
