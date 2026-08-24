/**
 * Browser-side wiring of the same pipeline the CLI runs.
 *
 * Nothing here re-implements anything: import, packing, rules, BoQ assembly and
 * the diff are the modules `demo/` and `packer/` already ship, and the rule seed
 * and part master are bundled at build time. The only difference from the CLI is
 * where the workbook comes from — an uploaded File rather than a path.
 */
import {
  importProjectFromBuffer, type Project, type Location,
} from '../../demo/src/import.ts'
import {
  parseRules, planLocation, buildDrivers, buildDriversFor, runRulesOverLocations,
  DEFAULT_DECLARATIONS, type Declarations, type LocationPlan, type SeedRule,
  type Resolved,
} from '../../demo/src/engine.ts'
import {
  assemble, readSubmittedBoqFromBuffer, buildPartIndexFrom, diffAgainstSubmitted,
  type BoqLine, type Override, type SubmittedLine, type DiffRow,
} from '../../demo/src/boq.ts'
import { splitByLength, type CableSplit } from '../../demo/src/cable.ts'
import rulesJson from '../../Rule Map/rules.seed.json'
import partsJson from '../../Part Catalogue/parts.json'

export type { Project, Location, Declarations, LocationPlan, BoqLine, Override, DiffRow, SeedRule, Resolved }
export { DEFAULT_DECLARATIONS }

export const RULES: SeedRule[] = parseRules(rulesJson as never)
const PART_INDEX = buildPartIndexFrom(partsJson as never)
export const PART_ALIASES = PART_INDEX.aliases

export type Loaded = {
  fileName: string
  project: Project
  /** The BoQ that was actually submitted, if the workbook carries one. */
  submitted: SubmittedLine[]
  submittedError: string | null
}

/** Read an uploaded workbook. Both the input sheet and the submitted BoQ live in it. */
export async function loadWorkbook(file: File): Promise<Loaded> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const project = importProjectFromBuffer(buf, file.name)
  let submitted: SubmittedLine[] = []
  let submittedError: string | null = null
  try {
    submitted = readSubmittedBoqFromBuffer(buf)
  } catch (err) {
    submittedError = (err as Error).message
  }
  return { fileName: file.name, project, submitted, submittedError }
}

export type RunResult = {
  plans: LocationPlan[]
  resolved: Map<string, Resolved>
  problems: string[]
  lines: BoqLine[]
  diff: { rows: DiffRow[]; summary: Record<string, number> }
  cable: CableSplit
  totals: { racks: number; groups: number; cubicles: number; cubiclesByCapacity: number }
}

/** One full pass. Cheap enough to run on every keystroke. */
export function run(
  project: Project,
  decl: Declarations,
  overrides: Override[],
  submitted: SubmittedLine[],
): RunResult {
  const plans = project.locations.map((l) => planLocation(l, decl))
  const { resolved, problems } = runRulesOverLocations(
    RULES,
    plans.map((p) => buildDriversFor(p, decl)),
    buildDrivers(project, plans, decl),
    decl,
    (key) => overrides.find((o) => o.partKey === key)?.qty ?? null,
  )
  const lines = assemble(resolved, overrides)
  return {
    plans, resolved, problems, lines,
    diff: diffAgainstSubmitted(lines, submitted, PART_INDEX.index),
    cable: splitByLength(project.locations),
    totals: {
      racks: plans.reduce((a, p) => a + p.pack.rackCount, 0),
      groups: plans.reduce((a, p) => a + p.groups.length, 0),
      cubicles: plans.reduce((a, p) => a + p.cubicles.excelCount, 0),
      cubiclesByCapacity: plans.reduce((a, p) => a + p.cubicles.total, 0),
    },
  }
}

/**
 * Explain one line: the rule, the driver it read, and the arithmetic.
 * This is what makes a generated number arguable rather than merely asserted.
 */
export function explain(line: BoqLine, res: Resolved | undefined): string[] {
  if (!res) return ['No rule is attached to this line.']
  const r = res.rule
  const out: string[] = []
  if (r.driver === 'MANUAL' || !r.expression) {
    out.push('No rule exists for this part. A quantity has to be entered by hand.')
  } else {
    out.push(`${r.id} · driver ${r.driver} · ${r.scope ?? 'location'} scope`)
    out.push(`quantity = ${r.expression}${r.rounding !== 'NONE' ? `, rounded ${r.rounding.toLowerCase()}` : ''}`)
    if ((r.scope ?? 'location') === 'location') {
      out.push('Evaluated per location and summed, as Gesamt does — the sum of ceilings is not the ceiling of the sum.')
    }
  }
  if (r.condition) out.push(`Gated on the ${r.condition} declaration.`)
  if (res.blockedBy) out.push(`Blocked: ${res.blockedBy}.`)
  if (r.source) out.push(`Recovered from ${r.source}`)
  if (r.note) out.push(r.note)
  return out
}

/** Project state as a single file, per the proposal. */
export function exportProject(
  loaded: Loaded, decl: Declarations, overrides: Override[],
): string {
  return JSON.stringify({
    version: 1,
    source: loaded.fileName,
    project: loaded.project,
    declarations: decl,
    overrides,
  }, null, 2)
}

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
