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
 */
import * as XLSX from 'xlsx'

export type Detection = 'SINGLE' | 'DUAL'

export type LineCounts = { dp: number; ts: number }

/** One block section's worth of a location. ABS locations can sit on two. */
export type Section = { name: string; dn: LineCounts; up: LineCounts }

export type Location = {
  id: string
  name: string
  scope: 'ABS' | 'YARD'
  blockSections: string[]
  /**
   * Per-block-section counts, kept rather than summed away. Durgapura and
   * Sanganer each sit on two sections, and the workbook gives each section its
   * own evaluation system, so the split has to survive import.
   */
  sections: Section[]
  detection: Detection
  /** MAIN-side counts per direction. Redundant mirrors them under DUAL. */
  dn: LineCounts
  up: LineCounts
  /** Totals including redundancy — what the BoQ ultimately books. */
  totalDp: number
  totalTs: number
}

export type Project = {
  source: string
  locations: Location[]
  totals: { dp: number; ts: number; locations: number }
  /** The sheet's own stated figures, for reconciliation. */
  stated: Record<string, number>
  warnings: string[]
}

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
  return parseWorkbook(wb, source)
}

function parseWorkbook(wb: XLSX.WorkBook, path: string): Project {
  const name = wb.SheetNames.find((n) => n.replace(/\s+/g, ' ').trim() === '16.DP TS details')
  if (!name) throw new Error(`sheet '16.DP TS details' not found in ${path}`)
  const ws = wb.Sheets[name]!
  const warnings: string[] = []

  // ---- verify the two block shapes before reading them -------------------
  const yardHeaders = [str(cell(ws, 'G3')), str(cell(ws, 'I3')), str(cell(ws, 'K3'))]
  const absHeaders = [str(cell(ws, 'P3')), str(cell(ws, 'R3')), str(cell(ws, 'T3')), str(cell(ws, 'V3'))]
  if (yardHeaders.join('|') !== 'DN Line|UP Line|MAIN') {
    warnings.push(`unexpected yard block headers: ${yardHeaders.join(' / ')}`)
  }
  if (absHeaders.join('|') !== 'DN Line|UP Line|DN & UP Main|DN & UP Redundant') {
    warnings.push(`unexpected ABS block headers: ${absHeaders.join(' / ')}`)
  }

  const locations: Location[] = []

  // ---- YARD block, rows 5..14 -------------------------------------------
  for (let r = 5; r <= 14; r++) {
    const nm = str(cell(ws, `F${r}`))
    if (!nm) continue
    const dn = { dp: num(cell(ws, `G${r}`)), ts: num(cell(ws, `H${r}`)) }
    const up = { dp: num(cell(ws, `I${r}`)), ts: num(cell(ws, `J${r}`)) }
    const mainDp = num(cell(ws, `K${r}`))
    const mainTs = num(cell(ws, `L${r}`))
    if (dn.dp + up.dp !== mainDp) {
      warnings.push(`${nm}: DN+UP DP ${dn.dp + up.dp} does not equal MAIN ${mainDp} (row ${r})`)
    }
    if (dn.ts + up.ts !== mainTs) {
      warnings.push(`${nm}: DN+UP TS ${dn.ts + up.ts} does not equal MAIN ${mainTs} (row ${r})`)
    }
    locations.push({
      id: `Y${String(locations.length + 1).padStart(2, '0')}`,
      name: nm, scope: 'YARD', blockSections: [],
      sections: [{ name: nm, dn: { ...dn }, up: { ...up } }],
      detection: 'SINGLE',
      dn, up, totalDp: mainDp, totalTs: mainTs,
    })
  }

  // ---- ABS block, rows 5..14, merging repeated locations -----------------
  const byName = new Map<string, Location>()
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
      warnings.push(`${nm}: DN+UP DP ${dn.dp + up.dp} does not equal main ${mainDp} (row ${r})`)
    }
    if (redDp !== mainDp || redTs !== mainTs) {
      warnings.push(`${nm}: redundant ${redDp}/${redTs} does not mirror main ${mainDp}/${mainTs} (row ${r})`)
    }
    const existing = byName.get(nm)
    if (existing) {
      // Durgapura and Sanganer each sit on two block sections.
      existing.dn.dp += dn.dp; existing.dn.ts += dn.ts
      existing.up.dp += up.dp; existing.up.ts += up.ts
      existing.totalDp += mainDp + redDp
      existing.totalTs += mainTs + redTs
      existing.sections.push({ name: section, dn: { ...dn }, up: { ...up } })
      if (section && !existing.blockSections.includes(section)) existing.blockSections.push(section)
      continue
    }
    const loc: Location = {
      id: `A${String(byName.size + 1).padStart(2, '0')}`,
      name: nm, scope: 'ABS', blockSections: section ? [section] : [],
      sections: [{ name: section, dn: { ...dn }, up: { ...up } }],
      detection: 'DUAL', dn, up,
      totalDp: mainDp + redDp, totalTs: mainTs + redTs,
    }
    byName.set(nm, loc)
    locations.push(loc)
  }

  // ---- reconcile against the sheet's own stated totals -------------------
  const stated: Record<string, number> = {}
  for (let r = 22; r <= 28; r++) {
    const k = str(cell(ws, `N${r}`))
    if (k) stated[k] = num(cell(ws, `O${r}`))
  }
  const abs = locations.filter((l) => l.scope === 'ABS')
  const yard = locations.filter((l) => l.scope === 'YARD')
  const sum = (ls: Location[], f: (l: Location) => number) => ls.reduce((a, l) => a + f(l), 0)

  const checks: [string, number, number | undefined][] = [
    ['Total DP ABS', sum(abs, (l) => l.totalDp), stated['Total DP ABS']],
    ['Total TS ABS', sum(abs, (l) => l.totalTs), stated['Total TS ABS']],
    ['Total DP YARD', sum(yard, (l) => l.totalDp), stated['Total DP YARD']],
    ['Total TS YARD', sum(yard, (l) => l.totalTs), stated['Total TS YARD']],
    ['No of Location', locations.length, stated['No of Location']],
  ]
  for (const [label, got, want] of checks) {
    if (want != null && got !== want) {
      warnings.push(`${label}: imported ${got}, sheet states ${want}`)
    }
  }

  return {
    source: path,
    locations,
    totals: {
      dp: sum(locations, (l) => l.totalDp),
      ts: sum(locations, (l) => l.totalTs),
      locations: locations.length,
    },
    stated,
    warnings,
  }
}
