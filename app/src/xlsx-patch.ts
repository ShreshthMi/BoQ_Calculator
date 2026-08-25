/**
 * Cell-level surgery on an .xlsx, at the zip level.
 *
 * WHY NOT ExcelJS. An .xlsx is a zip of XML parts, and most of what makes the
 * handover workbook that document lives in parts no JavaScript spreadsheet
 * library models. Measured against the real file: loading it with ExcelJS and
 * writing it straight back destroys 98 of its 128 parts — all 62 checkbox
 * `ctrlProps`, both VML drawings, both external links, every printer setting,
 * the custom XML and the Power Query connections. ExcelJS's own object model
 * reports that round trip as clean, because it cannot see what it does not
 * model, which is exactly the trap.
 *
 * Patching the zip keeps all 128. Everything this module does not name comes
 * out byte-identical, because it is never decoded in the first place.
 *
 * The cost is that cells have to be edited as XML rather than as objects, which
 * is what the rest of this file is. It is narrow on purpose: it edits cells that
 * already exist and does not create rows, columns or sheets.
 */
import JSZip from 'jszip'

/** What to put in one cell. */
export type CellEdit =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  /**
   * Replace the cell's formula outright, and its cached value with it.
   *
   * The other three kinds never remove a formula — `number` and `blank` carry it
   * through untouched — which is why the Bid Process Sheet writer could ignore
   * `xl/calcChain.xml` entirely. This one does remove it, so anything using it
   * has to drop the calc chain as well. See `Workbook.dropCalcChain`.
   */
  | { kind: 'formula'; formula: string; value: number | string }
  | { kind: 'blank' }

/** Edits to one worksheet part, keyed by A1 address. */
export type SheetEdits = Record<string, CellEdit>

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Match one cell by address, self-closing or paired. Order matters: `/>` first. */
const cellPattern = (addr: string): RegExp =>
  new RegExp(`<c r="${addr}"((?:\\s[^>]*?)?)(?:/>|>([\\s\\S]*?)</c>)`)

/** The same, unanchored, for a single sweep over every cell in a sheet. */
const ANY_CELL = /<c r="([A-Z]+\d+)"((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/c>)/g

/**
 * Rewrite one cell, keeping its style and its formula.
 *
 * The style index `s="68"` is the cell's entire appearance — border, fill, font,
 * number format — so it is carried through untouched. A formula is kept too and
 * only its CACHED value is replaced: on this sheet `K5 = G5+I5` is a shared
 * formula that Excel will recompute on open, but SheetJS reads the cache, so a
 * writer that updates `G5` and leaves `K5`'s cache alone produces a file that
 * re-imports with warnings about numbers that no longer add up.
 */
function rebuildCell(addr: string, attrs: string, body: string, edit: CellEdit): string {
  const style = /\ss="\d+"/.exec(attrs)?.[0] ?? ''
  const formula = /<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/.exec(body)?.[0] ?? ''

  let replacement: string
  if (edit.kind === 'blank') {
    replacement = formula
      ? `<c r="${addr}"${style}>${formula}</c>`
      : `<c r="${addr}"${style}/>`
  } else if (edit.kind === 'number') {
    replacement = `<c r="${addr}"${style}>${formula}<v>${edit.value}</v></c>`
  } else if (edit.kind === 'formula') {
    // A plain, unshared formula — deliberately, even where a shared one stood.
    // `patchSheet` has already checked that the whole shared group is being
    // rewritten, so no dependent is left pointing at a master that has gone.
    const v = typeof edit.value === 'number'
      ? `<v>${edit.value}</v>`
      : `<v>${escapeXml(edit.value)}</v>`
    const t = typeof edit.value === 'number' ? '' : ' t="str"'
    replacement = `<c r="${addr}"${style}${t}>`
      + `<f>${escapeXml(edit.formula.replace(/^=/, ''))}</f>${v}</c>`
  } else {
    // An inline string, so `sharedStrings.xml` and every index into it are left
    // exactly as they were. Excel and SheetJS both read them.
    replacement = `<c r="${addr}"${style} t="inlineStr"><is><t xml:space="preserve">`
      + `${escapeXml(edit.value)}</t></is></c>`
  }
  return replacement
}

export type PatchWarning = string

/** `'AB'` -> 28. */
const colIndex = (col: string): number =>
  [...col].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0)

/** 28 -> `'AB'`. */
export function colName(index: number): string {
  let n = index
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = (n - r - 1) / 26
  }
  return out
}

/** Every address in an A1 range, `'I43:AK43'` -> `['I43', 'J43', ...]`. */
function expandRange(ref: string): string[] {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
  if (!m) return [ref]
  const [c0, r0, c1, r1] = [colIndex(m[1]!), +m[2]!, colIndex(m[3]!), +m[4]!]
  const out: string[] = []
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(colName(c) + r)
  return out
}

/**
 * Every shared-formula MASTER in a sheet, with the range it speaks for.
 *
 * A shared formula is stored once — `<f t="shared" ref="I43:AK43" si="11">I42</f>`
 * — and its dependents are empty stubs, `<f t="shared" si="11"/>`. Replace the
 * master and every stub is left pointing at a formula that no longer exists,
 * which Excel reports as a damaged file. Dependents may be replaced freely.
 */
function sharedMasters(xml: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const re = /<c r="([A-Z]+\d+)"[^>]*>\s*<f\b[^>]*\bt="shared"[^>]*\bref="([^"]+)"/g
  for (const m of xml.matchAll(re)) out.set(m[1]!, expandRange(m[2]!))
  return out
}

/** Would this edit take the formula out of the cell? */
const removesFormula = (edit: CellEdit): boolean =>
  edit.kind === 'text' || edit.kind === 'formula'

/**
 * Apply edits to one worksheet part. Missing cells are reported, not created.
 *
 * An edit that would orphan a shared formula's dependents is REFUSED rather than
 * applied — writing over a master silently produces a workbook Excel offers to
 * repair, which is the worst possible failure here because it looks like our
 * data is corrupt when only the bookkeeping is. Rewriting the master's whole
 * range in one call is allowed, because then nothing is left pointing at it.
 */
export function patchSheet(
  xml: string,
  edits: SheetEdits,
): { xml: string; warnings: PatchWarning[] } {
  const warnings: PatchWarning[] = []
  const masters = sharedMasters(xml)
  const covered = new Set(Object.keys(edits))
  const written = new Set<string>()

  // ONE SWEEP, not one per edit.
  //
  // The obvious shape — find this address, splice the string, repeat — is
  // quadratic, and a location sheet takes several hundred edits against a
  // megabyte of XML. Measured on the two calculators before this: 21.5 seconds
  // to write both, which in a browser is a frozen tab rather than a slow one.
  // Sweeping every cell once and consulting a map takes a fraction of that.
  const out = xml.replace(ANY_CELL, (whole, addr: string, attrs: string, body: string) => {
    const edit = edits[addr]
    if (!edit) return whole
    const group = masters.get(addr)
    if (group && removesFormula(edit)) {
      const orphans = group.filter((a) => a !== addr && !covered.has(a))
      if (orphans.length) {
        warnings.push(
          `${addr} is the master of shared formula ${group[0]}:${group[group.length - 1]} `
          + `and ${orphans.length} cell(s) still depend on it, so it was not written`,
        )
        written.add(addr)
        return whole
      }
    }
    written.add(addr)
    return rebuildCell(addr, attrs ?? '', body ?? '', edit)
  })

  for (const addr of covered) {
    if (!written.has(addr)) {
      warnings.push(`cell ${addr} is not in the sheet, so it was not written`)
    }
  }
  return { xml: out, warnings }
}

/**
 * Restyle a run of cells.
 *
 * Used to clear the reference tender's own annotations — row 13 of the DP/TS
 * sheet is set in red beside the note "To Match the Quantity", and a new
 * project should not inherit either.
 */
export function restyle(xml: string, addrs: string[], style: string): string {
  let out = xml
  for (const addr of addrs) {
    const m = cellPattern(addr).exec(out)
    if (!m) continue
    const rebuilt = m[0].replace(/\ss="\d+"/, ` s="${style}"`)
    out = out.slice(0, m.index) + rebuilt + out.slice(m.index + m[0].length)
  }
  return out
}

/**
 * Tick or clear one legacy Form Control checkbox.
 *
 * The questionnaire's answers are 62 of these and they carry no `FmlaLink`, so
 * the state lives only here — as a `checked` attribute on `formControlPr` in
 * `xl/ctrlProps/ctrlPropN.xml`. No spreadsheet library can author them; as a zip
 * entry it is one attribute.
 */
export function setChecked(xml: string, checked: boolean): string {
  const cleared = xml.replace(/\schecked="[^"]*"/g, '')
  if (!checked) return cleared
  return cleared.replace(/<formControlPr\b/, '<formControlPr checked="Checked"')
}

/**
 * Show or hide one sheet.
 *
 * Nothing recomputes this. In the BRC calculators a location sheet is visible
 * exactly when it is populated — the correlation holds across all sixty sheets
 * of both workbooks — so a generated sheet that is filled in but left hidden is
 * a location the bid engineer cannot see.
 */
export function setSheetState(
  workbookXml: string,
  sheetName: string,
  state: 'visible' | 'hidden',
): string {
  const re = new RegExp(`<sheet[^>]*name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`)
  const m = re.exec(workbookXml)
  if (!m) return workbookXml
  const stripped = m[0].replace(/\sstate="[^"]*"/, '')
  const rebuilt = state === 'visible'
    ? stripped
    : stripped.replace(/\sr:id=/, ' state="hidden" r:id=')
  return workbookXml.slice(0, m.index) + rebuilt + workbookXml.slice(m.index + m[0].length)
}

/** Make Excel recompute on open, since cached values elsewhere are now stale. */
export function forceFullCalc(workbookXml: string): string {
  if (/<calcPr\b[^>]*\/>/.test(workbookXml)) {
    return workbookXml.replace(/<calcPr\b([^>]*)\/>/, (_m, attrs: string) =>
      `<calcPr${attrs.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`)
  }
  return workbookXml.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>')
}

/**
 * A workbook open for patching.
 *
 * Parts are read and written as text on demand; anything never asked for is
 * carried through as the bytes it arrived as.
 */
export class Workbook {
  // Written out rather than declared as constructor parameter properties: Node
  // runs this file through type stripping, which cannot erase those.
  private zip: JSZip
  readonly parts: string[]
  /** Sheet name -> worksheet part, resolved once. */
  private sheets: Map<string, string> | null

  private constructor(zip: JSZip, parts: string[]) {
    this.zip = zip
    this.parts = parts
    this.sheets = null
  }

  static async open(bytes: ArrayBuffer | Uint8Array): Promise<Workbook> {
    const zip = await JSZip.loadAsync(bytes)
    return new Workbook(zip, Object.keys(zip.files).sort())
  }

  async read(part: string): Promise<string> {
    const f = this.zip.file(part)
    if (!f) throw new Error(`${part} is not in this workbook`)
    return f.async('string')
  }

  write(part: string, xml: string): void {
    this.zip.file(part, xml)
  }

  /**
   * Read a part, transform it, and write it back — unless nothing changed.
   *
   * The skip is not only a saving. JSZip carries an untouched entry through as
   * the bytes it arrived as and re-deflates a written one, so writing back an
   * identical string costs a compression pass AND makes the part differ from
   * the template at the byte level for no reason, which is exactly what the
   * parity check exists to notice.
   */
  async edit(part: string, fn: (xml: string) => string): Promise<void> {
    const before = await this.read(part)
    const after = fn(before)
    if (after !== before) this.write(part, after)
  }

  has(part: string): boolean {
    return this.zip.file(part) !== null
  }

  /**
   * Delete `xl/calcChain.xml`, and the two places that declare it.
   *
   * The calc chain is Excel's index of where the formulas are. It is a
   * performance cache and holds no data — but it must agree with the sheets,
   * and the moment a writer replaces a formula cell with a literal it stops
   * agreeing. Excel then reports the whole workbook as needing repair, which
   * reads to a bid engineer as *our numbers are corrupt* when in fact only the
   * bookkeeping is. Excel rebuilds the chain silently on first open.
   *
   * The part, its relationship and its content-type override go together,
   * because a dangling relationship is itself a repair prompt.
   */
  async dropCalcChain(): Promise<boolean> {
    const part = 'xl/calcChain.xml'
    if (!this.has(part)) return false
    this.zip.remove(part)
    await this.edit('xl/_rels/workbook.xml.rels', (xml) =>
      xml.replace(/<Relationship[^>]*calcChain\.xml"[^>]*\/>/g, ''))
    await this.edit('[Content_Types].xml', (xml) =>
      xml.replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''))
    return true
  }

  /**
   * Which worksheet part backs a sheet name, via the workbook's own rels.
   *
   * Resolved once and kept: a workbook with thirty location sheets asks this
   * thirty times, and each answer otherwise costs decompressing and scanning
   * `workbook.xml` and its rels again.
   */
  async sheetPart(name: string): Promise<string> {
    if (!this.sheets) {
      const wb = await this.read('xl/workbook.xml')
      const rels = await this.read('xl/_rels/workbook.xml.rels')
      const target = new Map(
        [...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]),
      )
      this.sheets = new Map()
      for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
        const sheetName = (m[1] ?? '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
        this.sheets.set(sheetName, 'xl/' + (target.get(m[2] ?? '') ?? '').replace(/^\.\//, ''))
      }
    }
    const part = this.sheets.get(name.replace(/\s+/g, ' ').trim())
    if (!part) throw new Error(`sheet '${name}' is not in this workbook`)
    return part
  }

  async toBytes(): Promise<ArrayBuffer> {
    const out = await this.zip.generateAsync({
      type: 'arraybuffer',
      compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    return out
  }
}
