/**
 * Stage 1 — import and normalise.
 *
 * Reads sheet `16.DP TS details` of the handover workbook. The sheet carries two
 * blocks side by side with different shapes, exactly as the proposal anticipated:
 *
 *   E:L   YARD, 10 stations.  headers 'DN Line' / 'UP Line' / 'MAIN'
 *         G,H = DN DP,TS   I,J = UP DP,TS   K,L = MAIN DP,TS
 *         Single detection. MAIN is the sum of the two directions.
 *
 *   N:W   ABS, 10 rows over 8 unique locations. headers 'DN Line' / 'UP Line' /
 *         'DN & UP Main' / 'DN & UP Redundant'
 *         P,Q = DN DP,TS   R,S = UP DP,TS   T,U = main DP,TS   V,W = redundant
 *         Dual detection. Durgapura and Sanganer each appear on two block
 *         sections and must be merged.
 *
 * The sheet's own totals at row 16 and the summary at N22:O28 are read back as a
 * check rather than trusted: 176/164 ABS, 374/303 Yard, 550/467 project, 18
 * locations.
 *
 * This module reads a WORKBOOK. It does not own the project shape — `project.ts`
 * does, and the hand-entry route builds the same shape from plain data. All the
 * reader does is turn cells into `ProjectInput` and hand it over, so the two
 * routes cannot drift apart: there is one derivation and one set of checks.
 */
import * as XLSX from 'xlsx'
import {
  buildProject,
  type LocationInput, type Project, type ProjectInput, type SectionInput,
} from './project.ts'

export type {
  Detection, Scope, Application, LineCounts, Section, Room, CableCounts,
  CableSource, Location, Project,
  SectionInput, RoomInput, LocationInput, ProjectInput,
} from './project.ts'

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (v == null ? '' : String(v).trim())

function cell(ws: XLSX.WorkSheet, addr: string): unknown {
  const c = ws[addr] as { v?: unknown } | undefined
  return c?.v
}

/**
 * Parse an already-loaded workbook. The browser build hands a File's ArrayBuffer
 * straight in here, which is why the reader takes bytes rather than a path.
 */
export function importProjectFromBuffer(buf: Uint8Array, source = '(buffer)'): Project {
  const wb = XLSX.read(buf, { type: 'buffer' })
  return buildProject(readWorkbook(wb, source))
}

/**
 * The workbook as entered data, before any derivation.
 *
 * Exposed separately because it is exactly what the Locations screen edits: an
 * imported project and a hand-built one are the same object from here on.
 */
export function readWorkbookInput(buf: Uint8Array, source = '(buffer)'): ProjectInput {
  return readWorkbook(XLSX.read(buf, { type: 'buffer' }), source)
}

function readWorkbook(wb: XLSX.WorkBook, path: string): ProjectInput {
  const name = wb.SheetNames.find((n) => n.replace(/\s+/g, ' ').trim() === '16.DP TS details')
  if (!name) throw new Error(`sheet '16.DP TS details' not found in ${path}`)
  const ws = wb.Sheets[name]!
  const sourceWarnings: string[] = []

  // ---- verify the two block shapes before reading them -------------------
  const yardHeaders = [str(cell(ws, 'G3')), str(cell(ws, 'I3')), str(cell(ws, 'K3'))]
  const absHeaders = [str(cell(ws, 'P3')), str(cell(ws, 'R3')), str(cell(ws, 'T3')), str(cell(ws, 'V3'))]
  if (yardHeaders.join('|') !== 'DN Line|UP Line|MAIN') {
    sourceWarnings.push(`unexpected yard block headers: ${yardHeaders.join(' / ')}`)
  }
  if (absHeaders.join('|') !== 'DN Line|UP Line|DN & UP Main|DN & UP Redundant') {
    sourceWarnings.push(`unexpected ABS block headers: ${absHeaders.join(' / ')}`)
  }

  const locations: LocationInput[] = []

  // ---- YARD block, rows 5..14 -------------------------------------------
  for (let r = 5; r <= 14; r++) {
    const nm = str(cell(ws, `F${r}`))
    if (!nm) continue
    const dn = { dp: num(cell(ws, `G${r}`)), ts: num(cell(ws, `H${r}`)) }
    const up = { dp: num(cell(ws, `I${r}`)), ts: num(cell(ws, `J${r}`)) }
    const mainDp = num(cell(ws, `K${r}`))
    const mainTs = num(cell(ws, `L${r}`))
    if (dn.dp + up.dp !== mainDp) {
      sourceWarnings.push(`${nm}: DN+UP DP ${dn.dp + up.dp} does not equal MAIN ${mainDp} (row ${r})`)
    }
    if (dn.ts + up.ts !== mainTs) {
      sourceWarnings.push(`${nm}: DN+UP TS ${dn.ts + up.ts} does not equal MAIN ${mainTs} (row ${r})`)
    }
    locations.push({
      // Minted here, not derived from position later: an id that is re-derived
      // on every rebuild moves when a location is deleted.
      id: `Y${String(locations.length + 1).padStart(2, '0')}`,
      name: nm,
      scope: 'YARD',
      blockSections: [],
      sections: [{ name: nm, dn, up }],
    })
  }

  // ---- ABS block, rows 5..14, merging repeated locations -----------------
  //
  // The sheet has no field for an equipment room, so every location imports as
  // one. Where the planner actually used two — the calculators carry 21 location
  // sheets against this sheet's 18 rows — it has to be declared on the Locations
  // screen afterwards.
  const byName = new Map<string, LocationInput>()
  let section = ''
  for (let r = 5; r <= 14; r++) {
    const sec = str(cell(ws, `N${r}`))
    if (sec) section = sec
    const nm = str(cell(ws, `O${r}`))
    if (!nm) continue
    const dn = { dp: num(cell(ws, `P${r}`)), ts: num(cell(ws, `Q${r}`)) }
    const up = { dp: num(cell(ws, `R${r}`)), ts: num(cell(ws, `S${r}`)) }
    const mainDp = num(cell(ws, `T${r}`))
    const mainTs = num(cell(ws, `U${r}`))
    const redDp = num(cell(ws, `V${r}`))
    const redTs = num(cell(ws, `W${r}`))
    if (dn.dp + up.dp !== mainDp) {
      sourceWarnings.push(`${nm}: DN+UP DP ${dn.dp + up.dp} does not equal main ${mainDp} (row ${r})`)
    }
    if (redDp !== mainDp || redTs !== mainTs) {
      sourceWarnings.push(`${nm}: redundant ${redDp}/${redTs} does not mirror main ${mainDp}/${mainTs} (row ${r})`)
    }
    const entry: SectionInput = { name: section, dn, up }
    const existing = byName.get(nm)
    if (existing) {
      // Durgapura and Sanganer each sit on two block sections. Their per-section
      // counts are kept rather than summed away: the workbook gives each section
      // its own evaluation system, and that is what makes their rack count 3.
      existing.sections!.push(entry)
      if (section && !existing.blockSections!.includes(section)) {
        existing.blockSections!.push(section)
      }
      continue
    }
    const loc: LocationInput = {
      id: `A${String(byName.size + 1).padStart(2, '0')}`,
      name: nm,
      scope: 'ABS',
      blockSections: section ? [section] : [],
      sections: [entry],
    }
    byName.set(nm, loc)
    locations.push(loc)
  }

  // ---- the sheet's own stated figures, for reconciliation ----------------
  const stated: Record<string, number> = {}
  for (let r = 22; r <= 28; r++) {
    const k = str(cell(ws, `N${r}`))
    if (k) stated[k] = num(cell(ws, `O${r}`))
  }

  return { source: path, locations, stated, cableSource: 'guideline', sourceWarnings }
}
