/**
 * Stage 5 + 6 — the override layer, BoQ assembly, and the diff against the
 * BoQ the bid team actually submitted.
 */
import * as XLSX from 'xlsx'
import { partRefs } from './expr.ts'
import { applyAliases, type AliasReport } from './aliases.ts'
import type { Resolved, SeedRule } from './engine.ts'

export type Provenance = 'derived' | 'override' | 'stale' | 'manual' | 'blank' | 'dormant'

export type BoqLine = {
  ruleId: string
  partKey: string | null
  code: string | null
  description: string
  group: string
  /** Main quantity. `qty` is main + spare, which is what the BoQ's Total column holds. */
  main: number | null
  /** Spare quantity, folded in from the SPARE rules that reference this part. */
  spare: number
  qty: number | null
  /**
   * What the rules produced for the MAIN quantity, before any override and
   * before spares. This is the number staleness is judged against, so it must
   * not include the spare column or every override reads stale on entry.
   */
  derived: number | null
  provenance: Provenance
  /** Why the line is blank, when it is. */
  note: string | null
  confidence: string
}

/**
 * A hand-entered quantity, carrying the derived value it was entered against.
 *
 * On regeneration the derived value is recomputed; if it has moved since, the
 * override is marked STALE and needs confirming. Never silently kept, never
 * silently dropped.
 */
export type Override = {
  partKey: string
  qty: number
  /** The derived value at the moment the override was made. */
  driverSnapshot: number | null
  reason: string
  by: string
  at: string
}

export function assemble(
  resolved: Map<string, Resolved>,
  overrides: Override[],
): BoqLine[] {
  const byPart = new Map(overrides.map((o) => [o.partKey, o]))
  const lines: BoqLine[] = []

  // Spares are not their own BoQ lines. The submitted BoQ carries Main Qty /
  // Spare / Total columns, and a spare rule ('part(BD005) * 0.05') feeds the
  // Spare column of the line it references.
  const spareOf = new Map<string, number>()
  const spareRuleIds = new Set<string>()
  for (const r of resolved.values()) {
    if (r.rule.group !== 'SPARE' || !r.rule.expression) continue
    spareRuleIds.add(r.rule.id)
    const target = partRefs(r.rule.expression)[0]
    if (target && r.qty !== null) spareOf.set(target, (spareOf.get(target) ?? 0) + r.qty)
  }

  for (const r of resolved.values()) {
    if (spareRuleIds.has(r.rule.id)) continue
    const rule: SeedRule = r.rule
    const ov = rule.partKey ? byPart.get(rule.partKey) : undefined
    let qty = r.qty
    let provenance: Provenance =
      r.status === 'dormant' ? 'dormant'
      : r.status === 'blank' ? (rule.driver === 'MANUAL' ? 'manual' : 'blank')
      : 'derived'
    let note = r.blockedBy

    if (ov) {
      qty = ov.qty
      const moved = ov.driverSnapshot !== r.qty
      provenance = moved ? 'stale' : 'override'
      note = moved
        ? `entered against ${fmt(ov.driverSnapshot)}, rules now say ${fmt(r.qty)} — ${ov.reason}`
        : ov.reason
    }

    const spare = rule.partKey ? (spareOf.get(rule.partKey) ?? 0) : 0
    lines.push({
      ruleId: rule.id,
      partKey: rule.partKey,
      code: rule.part,
      description: rule.partDescription ?? shortLabel(rule.note, rule.group),
      group: rule.group,
      main: qty,
      spare,
      qty: qty === null ? null : qty + spare,
      derived: r.qty,
      provenance,
      note,
      confidence: rule.confidence,
    })
  }

  const ORDER = ['OUTDOOR', 'INDOOR', 'CUBICAL', 'RESET', 'SWITCH', 'MISC', 'SERVICE', 'TOOLS', 'SPARE']
  lines.sort((a, b) => {
    const g = ORDER.indexOf(a.group) - ORDER.indexOf(b.group)
    return g !== 0 ? g : a.ruleId.localeCompare(b.ruleId)
  })
  return lines
}

const fmt = (n: number | null) => (n === null ? 'blank' : String(n))

/**
 * A display name for a line that has no catalogue part.
 *
 * Those rules carry only an engineering note, and a note is a paragraph — it
 * belongs in the audit trail, not in a Description column. The first sentence of
 * one reads as a name ("Active fan", "Patch cable", "4 TE blanking plate for
 * spare PSC slots"), so that is what is used.
 */
function shortLabel(note: string | undefined, fallback: string): string {
  if (!note) return fallback
  const first = note.split(/\.\s|\.$/)[0]?.trim()
  if (!first) return fallback
  return first.length > 72 ? `${first.slice(0, 69)}...` : first
}

// ---------------------------------------------------------------------------
// the submitted BoQ, for the diff
// ---------------------------------------------------------------------------

export type SubmittedLine = {
  row: number
  group: string
  code: string
  description: string
  main: number
  spare: number
  total: number
}

/**
 * Read sheet `10.  BOQ` — note the double space. A hidden older sheet
 * `10. BoQ` disagrees with it on several lines; the double-space one is the
 * artefact that shipped.
 */
export function readSubmittedBoqFromBuffer(buf: Uint8Array): SubmittedLine[] {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const name = wb.SheetNames.find((n) => n === '10.  BOQ')
  if (!name) throw new Error("sheet '10.  BOQ' not found")
  const ws = wb.Sheets[name]!
  const val = (a: string): unknown => (ws[a] as { v?: unknown } | undefined)?.v
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  const out: SubmittedLine[] = []
  let group = ''
  for (let r = 3; r <= 43; r++) {
    const g = String(val(`A${r}`) ?? '').trim()
    if (g) group = g.replace(/\.$/, '')
    const codeRaw = val(`C${r}`)
    if (codeRaw == null) continue
    const code = typeof codeRaw === 'number' ? String(codeRaw) : String(codeRaw).trim()
    out.push({
      row: r, group, code,
      description: String(val(`D${r}`) ?? '').replace(/\s+/g, ' ').trim(),
      main: num(val(`E${r}`)), spare: num(val(`F${r}`)), total: num(val(`G${r}`)),
    })
  }
  return out
}

export type PartIndex = Map<string, string> // any code -> partKey

/**
 * Build the code index from an already-parsed parts.json, then merge the
 * explicit alias table over it. The report is returned rather than swallowed: an
 * alias whose target is missing, or one the catalogue has since absorbed, is a
 * defect worth surfacing.
 */
export function buildPartIndexFrom(
  raw: { parts: { key: string; codes: Record<string, string> }[] },
): { index: PartIndex; aliases: AliasReport } {
  const index: PartIndex = new Map()
  for (const p of raw.parts) {
    for (const c of Object.values(p.codes)) {
      if (c && !index.has(c)) index.set(c, p.key)
    }
  }
  const aliases = applyAliases(index, new Set(raw.parts.map((p) => p.key)))
  return { index, aliases }
}

export type DiffRow = {
  code: string
  description: string
  group: string
  submitted: number
  generated: number | null
  provenance: Provenance | 'not-produced'
  verdict: 'match' | 'differs' | 'blank' | 'missing'
  delta: number | null
}

export function diffAgainstSubmitted(
  lines: BoqLine[],
  submitted: SubmittedLine[],
  index: PartIndex,
): { rows: DiffRow[]; summary: Record<string, number> } {
  const byPartKey = new Map<string, BoqLine>()
  for (const l of lines) if (l.partKey) byPartKey.set(l.partKey, l)

  const rows: DiffRow[] = []
  for (const s of submitted) {
    const key = index.get(s.code)
    const line = key ? byPartKey.get(key) : undefined
    // Compare main-to-main. The submitted BoQ's Spare column is zero on all 41
    // lines, so comparing our Total (main + spare) against theirs would show a
    // difference on every spared line that is really about spares policy.
    const generated = line ? line.main : null
    const verdict: DiffRow['verdict'] =
      !line ? 'missing'
      : generated === null ? 'blank'
      : generated === s.main ? 'match'
      : 'differs'
    rows.push({
      code: s.code, description: s.description, group: s.group,
      submitted: s.main, generated,
      provenance: line ? line.provenance : 'not-produced',
      verdict,
      delta: generated === null ? null : generated - s.main,
    })
  }

  const summary: Record<string, number> = { match: 0, differs: 0, blank: 0, missing: 0 }
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] ?? 0) + 1
  return { rows, summary }
}
