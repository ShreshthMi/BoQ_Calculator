/**
 * Score the packer against the reference project.
 *
 * Runs every location from both BRC workbooks through the packer, using the
 * planner's own group structure as input, and diffs the result against the
 * layout the planner actually drew.
 *
 * Differences are reported, not tuned away. The human layout is not necessarily
 * optimal, and where the packer disagrees that is information about one of them.
 *
 *   node scripts/score.ts            fewest-backplanes (default)
 *   node scripts/score.ts least-te
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pack, type Group } from '../src/packer.ts'
import type { Objective } from '../src/decompose.ts'
import type { SystemId } from '../src/types.ts'

type RefGroup = {
  aeb: number; ioExb: number; com: number
  /** PSC the planner equipped in this group. Not derivable — see Group.psc. */
  psc: number
  sparePsc: number
  backplanes: string[]; te: number
}
type RefLoc = {
  name: string
  sheet: string
  groups: RefGroup[]
  actual: {
    racks: number
    backplanes: Record<string, number>
    psc: number
    sparePsc: number
    com: number
    aeb: number
    io: number
    te: number
  }
  rackTe: number[]
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REF: Record<string, RefLoc[]> = JSON.parse(
  readFileSync(join(HERE, '..', 'fixtures', 'reference.json'), 'utf8'),
)

const objective = (process.argv[2] as Objective) ?? 'fewest-backplanes'

/**
 * Detection mode per workbook, which sets the largest permitted BP-EXB.
 * ABS is dual detection and may use BP-EXB-4; Yard is single and caps at
 * BP-EXB-2. The workbooks confirm it: Yard books zero BP-EXB-4 across all
 * thirteen locations, ABS books ten.
 */
const MAX_EXB: Record<string, number> = { ABS: 4, Yard: 2 }
const CODES = ['BP-PWR-0', 'BP-PWR-4', 'BP-PWR-8', 'BP-EXB-1', 'BP-EXB-2', 'BP-EXB-4']

const mix = (c: Record<string, number>) =>
  CODES.filter((k) => (c[k] ?? 0) > 0).map((k) => `${c[k]}x${k.replace('BP-', '')}`).join(' ')

let exactLayout = 0
let exactRacks = 0
let total = 0
let teUs = 0
let teThem = 0
let bpUs = 0
let bpThem = 0
const notes: string[] = []

console.log(`objective: ${objective}\n`)
console.log(
  `${'proj'.padEnd(5)} ${'location'.padEnd(15)} ${'grp'.padEnd(3)} ` +
  `${'racks'.padEnd(7)} ${'TE'.padEnd(9)} ${'packer mix'.padEnd(34)} ${'workbook mix'.padEnd(34)} verdict`,
)
console.log('-'.repeat(126))

for (const [proj, locs] of Object.entries(REF)) {
  for (const loc of locs) {
    total++
    const groups: Group[] = loc.groups.map((g, i) => ({
      id: `G${i + 1}`,
      system: (i % 2 === 0 ? 'MAIN' : 'REDUNDANT') as SystemId,
      aeb: g.aeb, ioExb: g.ioExb, com: g.com, psc: g.psc,
    }))
    const r = pack({ groups, objective, options: { maxExbSlots: MAX_EXB[proj] ?? 4 } })

    const ourTe = r.racks.reduce((a, x) => a + x.teUsed, 0)
    const ourBp = CODES.reduce((a, k) => a + (r.backplaneCounts[k] ?? 0), 0)
    const theirBp = CODES.reduce((a, k) => a + (loc.actual.backplanes[k] ?? 0), 0)
    teUs += ourTe; teThem += loc.actual.te; bpUs += ourBp; bpThem += theirBp

    const sameMix = CODES.every(
      (k) => (r.backplaneCounts[k] ?? 0) === (loc.actual.backplanes[k] ?? 0),
    )
    const sameRacks = r.rackCount === loc.actual.racks
    if (sameMix) exactLayout++
    if (sameRacks) exactRacks++

    const verdict = sameMix && sameRacks ? 'exact'
      : sameRacks ? 'same racks, different mix'
      : `racks ${r.rackCount} vs ${loc.actual.racks}`

    console.log(
      `${proj.padEnd(5)} ${loc.name.slice(0, 15).padEnd(15)} ${String(groups.length).padEnd(3)} ` +
      `${`${r.rackCount}/${loc.actual.racks}`.padEnd(7)} ${`${ourTe}/${loc.actual.te}`.padEnd(9)} ` +
      `${mix(r.backplaneCounts).padEnd(34)} ${mix(loc.actual.backplanes).padEnd(34)} ${verdict}`,
    )

    if (!sameMix || !sameRacks) {
      const deltas = CODES
        .map((k) => [k, (r.backplaneCounts[k] ?? 0) - (loc.actual.backplanes[k] ?? 0)] as const)
        .filter(([, d]) => d !== 0)
        .map(([k, d]) => `${d > 0 ? '+' : ''}${d} ${k}`)
      notes.push(
        `${proj}/${loc.name}: ${deltas.join(', ') || 'same mix'}; ` +
        `TE ${ourTe} vs ${loc.actual.te}; racks ${r.rackCount} vs ${loc.actual.racks}`,
      )
    }
    if (r.warnings.length) {
      for (const w of r.warnings) notes.push(`${proj}/${loc.name}: ${w}`)
    }
  }
}

console.log()
console.log(`locations              : ${total}`)
console.log(`identical backplane mix: ${exactLayout}/${total}`)
console.log(`identical rack count   : ${exactRacks}/${total}`)
console.log(`TE  packer vs workbook : ${teUs} vs ${teThem}  (${teUs - teThem >= 0 ? '+' : ''}${teUs - teThem})`)
console.log(`backplanes             : ${bpUs} vs ${bpThem}  (${bpUs - bpThem >= 0 ? '+' : ''}${bpUs - bpThem})`)

if (notes.length) {
  console.log('\ndifferences and warnings')
  for (const n of notes) console.log(`  - ${n}`)
}

process.exitCode = exactRacks === total ? 0 : 1
