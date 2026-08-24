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
  | { kind: 'blank' }

/** Edits to one worksheet part, keyed by A1 address. */
export type SheetEdits = Record<string, CellEdit>

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Match one cell by address, self-closing or paired. Order matters: `/>` first. */
const cellPattern = (addr: string): RegExp =>
  new RegExp(`<c r="${addr}"((?:\\s[^>]*?)?)(?:/>|>([\\s\\S]*?)</c>)`)

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
function writeCell(xml: string, addr: string, edit: CellEdit): string | null {
  const m = cellPattern(addr).exec(xml)
  if (!m) return null
  const attrs = m[1] ?? ''
  const body = m[2] ?? ''
  const style = /\ss="\d+"/.exec(attrs)?.[0] ?? ''
  const formula = /<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>)/.exec(body)?.[0] ?? ''

  let replacement: string
  if (edit.kind === 'blank') {
    replacement = formula
      ? `<c r="${addr}"${style}>${formula}</c>`
      : `<c r="${addr}"${style}/>`
  } else if (edit.kind === 'number') {
    replacement = `<c r="${addr}"${style}>${formula}<v>${edit.value}</v></c>`
  } else {
    // An inline string, so `sharedStrings.xml` and every index into it are left
    // exactly as they were. Excel and SheetJS both read them.
    replacement = `<c r="${addr}"${style} t="inlineStr"><is><t xml:space="preserve">`
      + `${escapeXml(edit.value)}</t></is></c>`
  }
  return xml.slice(0, m.index) + replacement + xml.slice(m.index + m[0].length)
}

export type PatchWarning = string

/** Apply edits to one worksheet part. Missing cells are reported, not created. */
export function patchSheet(
  xml: string,
  edits: SheetEdits,
): { xml: string; warnings: PatchWarning[] } {
  const warnings: PatchWarning[] = []
  let out = xml
  for (const [addr, edit] of Object.entries(edits)) {
    const next = writeCell(out, addr, edit)
    if (next === null) warnings.push(`cell ${addr} is not in the sheet, so it was not written`)
    else out = next
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

  private constructor(zip: JSZip, parts: string[]) {
    this.zip = zip
    this.parts = parts
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

  async edit(part: string, fn: (xml: string) => string): Promise<void> {
    this.write(part, fn(await this.read(part)))
  }

  /** Which worksheet part backs a sheet name, via the workbook's own rels. */
  async sheetPart(name: string): Promise<string> {
    const wb = await this.read('xl/workbook.xml')
    const rels = await this.read('xl/_rels/workbook.xml.rels')
    const target = new Map(
      [...rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]),
    )
    for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
      const sheetName = (m[1] ?? '').replace(/&amp;/g, '&')
      if (sheetName.replace(/\s+/g, ' ').trim() === name.replace(/\s+/g, ' ').trim()) {
        return 'xl/' + (target.get(m[2] ?? '') ?? '').replace(/^\.\//, '')
      }
    }
    throw new Error(`sheet '${name}' is not in this workbook`)
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
