/**
 * Browser-side wiring of the same pipeline the CLI runs.
 *
 * Nothing here re-implements anything: import, packing, rules, BoQ assembly and
 * the diff are the modules `demo/` and `packer/` already ship, and the rule seed
 * and part master are bundled at build time. The only difference from the CLI is
 * where the input comes from — an uploaded File, or the Locations screen.
 *
 * THE PROJECT IS ALWAYS BUILT, NEVER MUTATED. Both routes produce a
 * `ProjectInput` — plain entered data — and `buildProject` turns it into the
 * `Project` everything downstream reads. Editing a count replaces the input and
 * rebuilds; there is no in-place mutation, so totals, per-section counts and the
 * reconciliation warnings cannot drift out of step with each other.
 */
import {
  readWorkbookInput, importProjectFromBuffer,
} from '../../demo/src/import.ts'
import {
  buildProject, toInput, blankProject, blankLocation, blankSection, setRoomCount,
  deriveLocation, deriveTotals, systemsOf, nextLocationId,
  APPLICATIONS, APPLICATION_LABEL, defaultApplication, defaultDetection,
  type Project, type ProjectInput, type LocationInput, type RoomInput,
  type SectionInput, type Location, type Section, type Room, type Scope,
  type Application, type CableCounts, type CableSource, type Detection,
  type LineCounts,
} from '../../demo/src/project.ts'
import {
  parseRules, planLocation, buildDrivers, buildDriversFor, runRulesOverLocations,
  columnsOf, DEFAULT_DECLARATIONS,
  type Declarations, type LocationPlan, type SeedRule, type Resolved,
} from '../../demo/src/engine.ts'
import {
  assemble, readSubmittedBoqFromBuffer, buildPartIndexFrom, diffAgainstSubmitted,
  type BoqLine, type Override, type SubmittedLine, type DiffRow,
} from '../../demo/src/boq.ts'
import { splitByLength, type CableSplit } from '../../demo/src/cable.ts'
import rulesJson from '../../Rule Map/rules.seed.json'
import partsJson from '../../Part Catalogue/parts.json'

export type {
  Project, ProjectInput, LocationInput, RoomInput, SectionInput,
  Location, Section, Room, Scope, Application, CableCounts, CableSource,
  Detection, LineCounts,
  Declarations, LocationPlan, BoqLine, Override, DiffRow, SeedRule, Resolved,
  CableSplit,
}
export {
  DEFAULT_DECLARATIONS, buildProject, toInput, blankProject, blankLocation,
  blankSection, setRoomCount, deriveLocation, deriveTotals, systemsOf, nextLocationId,
  APPLICATIONS, APPLICATION_LABEL, defaultApplication, defaultDetection,
  importProjectFromBuffer,
}

export const RULES: SeedRule[] = parseRules(rulesJson as never)
const PART_INDEX = buildPartIndexFrom(partsJson as never)
export const PART_ALIASES = PART_INDEX.aliases

/**
 * A SAP code to a catalogue part, across all four code systems plus the alias
 * table. The Bid Process Sheet writes codes the rules do not use — `24422` for
 * the rail deflector where the rule carries `101950` — so anything matching a
 * generated line against that workbook has to come through here.
 */
export const partKeyOf = (code: string): string | undefined => PART_INDEX.index.get(code)

/**
 * Where a project came from.
 *
 * A workbook also carries the BoQ that was actually submitted, which is what
 * makes the diff possible. A hand-entered project has nothing to diff against,
 * and says so rather than pretending the comparison is empty.
 */
export type Origin =
  | { kind: 'workbook'; fileName: string; submitted: SubmittedLine[]; submittedError: string | null }
  | { kind: 'manual' }

export type Loaded = { origin: Origin; input: ProjectInput }

export const submittedOf = (origin: Origin): SubmittedLine[] =>
  (origin.kind === 'workbook' ? origin.submitted : [])

export const labelOf = (loaded: Loaded): string =>
  (loaded.origin.kind === 'workbook'
    ? loaded.origin.fileName
    : loaded.input.source || 'entered by hand')

/** Read an uploaded workbook. Both the input sheet and the submitted BoQ live in it. */
export async function loadWorkbook(file: File): Promise<Loaded> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const input = readWorkbookInput(buf, file.name)
  let submitted: SubmittedLine[] = []
  let submittedError: string | null = null
  try {
    submitted = readSubmittedBoqFromBuffer(buf)
  } catch (err) {
    submittedError = (err as Error).message
  }
  return {
    origin: { kind: 'workbook', fileName: file.name, submitted, submittedError },
    input,
  }
}

/** Start with nothing — the second route in, for a project with no workbook. */
export function startEmpty(name: string): Loaded {
  return {
    origin: { kind: 'manual' },
    input: { ...blankProject(), source: name.trim() || 'Untitled project' },
  }
}

export type RunResult = {
  plans: LocationPlan[]
  /** One per equipment room where any are declared, else one per location. */
  columns: LocationPlan[]
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
  const columns = columnsOf(plans)
  const { resolved, problems } = runRulesOverLocations(
    RULES,
    columns.map((p) => buildDriversFor(p, decl, project.cableSource)),
    buildDrivers(project, plans, decl),
    decl,
    (key) => overrides.find((o) => o.partKey === key)?.qty ?? null,
  )
  const lines = assemble(resolved, overrides)
  return {
    plans, columns, resolved, problems, lines,
    diff: diffAgainstSubmitted(lines, submitted, PART_INDEX.index),
    cable: splitByLength(project.locations, project.cableSource),
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
export function explain(line: BoqLine, res: Resolved | undefined, cable?: CableSplit): string[] {
  if (!res) return ['No rule is attached to this line.']
  const r = res.rule
  const out: string[] = []
  if (r.driver === 'MANUAL' || !r.expression) {
    out.push('No rule exists for this part. A quantity has to be entered by hand.')
  } else {
    out.push(`${r.id} · driver ${r.driver} · ${r.scope ?? 'location'} scope`)
    out.push(`quantity = ${r.expression}${r.rounding !== 'NONE' ? `, rounded ${r.rounding.toLowerCase()}` : ''}`)
    if ((r.scope ?? 'location') === 'location') {
      out.push('Evaluated per column and summed, as Gesamt does — the sum of ceilings is not the ceiling of the sum.')
    }
  }
  // The three trackside kit lines are the only ones whose DRIVER has a source of
  // its own, and which of the two it is changes what the number means. When the
  // runs were counted, the seed's own provenance is SUPPRESSED rather than
  // printed alongside: a panel that cites the questionnaire under a measured
  // number is asserting two stories at once, and one of them is false.
  const measuredCable = r.driver === 'CABLE' && cable?.source === 'measured'
  if (r.driver === 'CABLE' && cable) {
    out.push(measuredCable
      ? 'Counted from the cable plan entered per location. The questionnaire guideline is '
        + `switched off for this project, not overridden — it would have said `
        + `${cable.guideline.m5} / ${cable.guideline.m10} / ${cable.guideline.m15}.`
      : 'Estimated from questionnaire B151 item 16, applied per location by application '
        + 'type. Switch the project to measured runs once a cable plan exists.')
    if (cable.unmeasured.length > 0) {
      out.push(`No runs counted at ${list(cable.unmeasured)}.`)
    }
    if (cable.mismatched.length > 0) {
      out.push(`Runs do not add up to the detection points at ${list(cable.mismatched)}. `
        + 'Every detection point takes one kit, so the three lines have to total what the '
        + 'sensor line books.')
    }
  }
  if (r.condition) out.push(`Gated on the ${r.condition} declaration.`)
  if (res.blockedBy) out.push(`Blocked: ${res.blockedBy}.`)
  if (!measuredCable) {
    if (r.source) out.push(`Recovered from ${r.source}`)
    if (r.note) out.push(r.note)
  }
  return out
}

/** Name a few and count the rest — a list of eighteen stops being read. */
function list(names: string[], cap = 4): string {
  return names.length <= cap
    ? names.join(', ')
    : `${names.slice(0, cap).join(', ')} and ${names.length - cap} more`
}

/**
 * Project state as a single file, per the proposal.
 *
 * What is written is the INPUT, not the derived project: the entered data, the
 * declarations and the overrides. Reading it back and rebuilding reproduces
 * every derived figure, which is the only way to be sure the file is complete.
 */
export function exportProject(
  loaded: Loaded, decl: Declarations, overrides: Override[],
): string {
  return JSON.stringify({
    version: 2,
    source: loaded.origin.kind === 'workbook' ? loaded.origin.fileName : loaded.input.source,
    origin: loaded.origin.kind,
    input: loaded.input,
    declarations: decl,
    overrides,
  }, null, 2)
}

export type LoadedState = { loaded: Loaded; declarations: Declarations; overrides: Override[] }

/**
 * Read back a file written by `exportProject`.
 *
 * A workbook-sourced project loses its submitted BoQ — that lived in the .xlsx,
 * not in this file — so the diff is unavailable until the workbook is dropped in
 * again. Everything else round-trips exactly.
 */
export function importProjectState(text: string): LoadedState {
  let raw: {
    version?: number
    input?: ProjectInput
    project?: LegacyProject
    declarations?: Partial<Declarations>
    overrides?: Override[]
  }
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('that file is not JSON. Choose a project state exported from here.')
  }
  const input = raw.input ?? (raw.project ? fromLegacy(raw.project) : null)
  if (!input || !Array.isArray(input.locations)) {
    throw new Error('not a project state file — no locations in it')
  }
  // Check the shape HERE, where the caller can catch it. `buildProject` runs a
  // render later inside a useMemo, so anything that throws there takes the whole
  // app down with it and loses whatever was open — a hand-edited file should
  // produce a message, not a white screen.
  const bad = input.locations.findIndex((l) => !isLocationInput(l))
  if (bad >= 0) {
    throw new Error(
      `location ${bad + 1} in that file is not readable — every location needs a name and a `
      + 'scope of ABS or YARD, and every section a dn and an up count.',
    )
  }
  return {
    loaded: { origin: { kind: 'manual' }, input },
    declarations: { ...DEFAULT_DECLARATIONS, ...(raw.declarations ?? {}) },
    overrides: Array.isArray(raw.overrides) ? raw.overrides : [],
  }
}

const isCounts = (c: unknown): boolean =>
  typeof c === 'object' && c !== null
  && typeof (c as LineCounts).dp === 'number' && typeof (c as LineCounts).ts === 'number'

const isSection = (s: unknown): boolean =>
  typeof s === 'object' && s !== null
  && isCounts((s as SectionInput).dn) && isCounts((s as SectionInput).up)

function isLocationInput(l: unknown): boolean {
  if (typeof l !== 'object' || l === null) return false
  const x = l as LocationInput
  if (typeof x.name !== 'string') return false
  if (x.scope !== 'ABS' && x.scope !== 'YARD') return false
  if (x.sections && (!Array.isArray(x.sections) || !x.sections.every(isSection))) return false
  if (x.rooms) {
    if (!Array.isArray(x.rooms)) return false
    if (!x.rooms.every((r) => typeof r === 'object' && r !== null
      && Array.isArray((r as RoomInput).sections)
      && (r as RoomInput).sections.every(isSection))) return false
  }
  return true
}

/**
 * A version-1 file, which wrote the derived project rather than the input.
 *
 * It predates equipment rooms, application type and measured cable runs, so
 * those fields are simply absent and take their defaults — which is exactly
 * what the file meant when it was written.
 */
type LegacyProject = {
  source?: string
  stated?: Record<string, number>
  locations?: {
    id?: string
    name?: string
    scope?: Scope
    detection?: Detection
    blockSections?: string[]
    sections?: { name?: string; dn?: LineCounts; up?: LineCounts }[]
  }[]
}

function fromLegacy(p: LegacyProject): ProjectInput {
  return {
    source: p.source,
    stated: p.stated ?? {},
    cableSource: 'guideline',
    locations: (p.locations ?? []).map((l) => ({
      id: l.id,
      name: l.name ?? '',
      scope: l.scope ?? 'YARD',
      detection: l.detection,
      blockSections: l.blockSections,
      sections: (l.sections ?? []).map((s) => ({
        name: s.name,
        dn: s.dn ?? { dp: 0, ts: 0 },
        up: s.up ?? { dp: 0, ts: 0 },
      })),
    })),
  }
}

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
