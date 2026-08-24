/**
 * Write the BoQ in the bid team's own format.
 *
 * Not a generic dump — this reproduces the layout of sheet `10.  BOQ` in the
 * handover workbook so the output is a drop-in replacement rather than something
 * that has to be reformatted before it can be used:
 *
 *   row 1        empty
 *   row 2        header, B:G — Column1 · SAP CODE · Description · Main Qty · Spare · Total
 *   rows 3..n    data, with column A carrying the group name merged down the
 *                block and rotated 90 degrees
 *
 * The measurements are taken from the workbook itself rather than guessed: fill
 * FFBDD7EE, medium border around the group cells and thin elsewhere, and column
 * widths 9.1 / 10.6 / 23 / 66.7 / 10.9 / 8.3 / 9.1.
 *
 * SheetJS is still used to READ workbooks; it cannot write cell styling in the
 * community build, which is why this one export uses ExcelJS. It is imported
 * dynamically so its weight only lands when someone actually exports.
 */
import type { BoqLine } from './pipeline.ts'

const FILL = 'FFBDD7EE'      // the data + group fill used throughout the sheet
const HEADER = 'FF1F4E79'    // dark navy header, white bold text
const EDGE = 'FF8EA9DB'      // border colour

const WIDTHS = [9.1, 10.6, 23, 66.7, 10.9, 8.3, 9.1]
const HEADERS = ['Column1', 'SAP CODE', 'Description', 'Main Qty', 'Spare', 'Total']

/** OUTDOOR -> Outdoor, MISC -> Misc. — the casing the sheet uses. */
function groupLabel(g: string): string {
  const t = g.charAt(0) + g.slice(1).toLowerCase()
  return t === 'Misc' ? 'Misc.' : t
}

export async function exportStyledBoq(lines: BoqLine[]): Promise<ArrayBuffer> {
  // ExcelJS ships CommonJS, so the namespace shape differs between the bundler's
  // interop and Node's. Accept either rather than depending on one.
  const mod = await import('exceljs')
  const ExcelJS = ((mod as unknown as { default?: typeof mod }).default ?? mod)
  const wb = new ExcelJS.Workbook()
  wb.creator = 'BoQ Calculator'
  wb.created = new Date()

  // -------------------------------------------------------------- sheet 1
  const ws = wb.addWorksheet('BoQ', { views: [{ state: 'frozen', ySplit: 2 }] })
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w })

  const thin = { style: 'thin' as const, color: { argb: EDGE } }
  const medium = { style: 'medium' as const, color: { argb: EDGE } }

  // header at row 2, columns B..G — row 1 stays empty, as in the original
  const header = ws.getRow(2)
  HEADERS.forEach((h, i) => {
    const c = header.getCell(i + 2)
    c.value = h
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } }
    c.alignment = { horizontal: i === 2 ? 'left' : 'center', vertical: 'middle' }
    c.border = { top: medium, left: medium, bottom: medium, right: medium }
  })
  header.height = 20

  // ---------------------------------------------------------------- rows
  let r = 3
  const blocks: { label: string; from: number; to: number }[] = []
  let current: { label: string; from: number; to: number } | null = null

  for (const l of lines) {
    const label = groupLabel(l.group)
    if (!current || current.label !== label) {
      current = { label, from: r, to: r }
      blocks.push(current)
    } else {
      current.to = r
    }

    const row = ws.getRow(r)
    row.getCell(2).value = 'L'
    row.getCell(3).value = l.code ? (/^\d+$/.test(l.code) ? Number(l.code) : l.code) : ''
    row.getCell(4).value = l.description
    // A blank line means no rule produced a quantity. It is left EMPTY, never
    // zero — a zero would read as a real answer of "none required".
    row.getCell(5).value = l.main ?? ''
    row.getCell(6).value = l.spare || 0
    row.getCell(7).value = l.qty ?? ''

    for (let c = 2; c <= 7; c++) {
      const cell = row.getCell(c)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL } }
      cell.border = { top: thin, left: thin, bottom: thin, right: thin }
      cell.alignment = { horizontal: c === 4 ? 'left' : 'center', vertical: 'middle' }
      if (c >= 5) cell.numFmt = '#,##0'
    }
    r++
  }
  const last = r - 1

  // ------------------------------------------------- column A group blocks
  for (const b of blocks) {
    if (b.to > b.from) ws.mergeCells(b.from, 1, b.to, 1)
    const cell = ws.getCell(b.from, 1)
    cell.value = b.label
    cell.font = { bold: true, size: 11 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL } }
    // 90 degrees, reading bottom-to-top, exactly as the source sheet sets it.
    cell.alignment = { horizontal: 'center', vertical: 'middle', textRotation: 90 }
    for (let rr = b.from; rr <= b.to; rr++) {
      ws.getCell(rr, 1).border = { top: medium, left: medium, bottom: medium, right: medium }
    }
  }

  ws.autoFilter = { from: { row: 2, column: 2 }, to: { row: last, column: 7 } }

  // -------------------------------------------------------------- sheet 2
  // The audit trail. Kept off sheet 1 so that stays a drop-in match.
  const prov = wb.addWorksheet('Provenance')
  prov.columns = [
    { header: 'Rule', key: 'rule', width: 9 },
    { header: 'SAP Code', key: 'code', width: 14 },
    { header: 'Description', key: 'desc', width: 52 },
    { header: 'Group', key: 'group', width: 12 },
    { header: 'Main', key: 'main', width: 10 },
    { header: 'Spare', key: 'spare', width: 9 },
    { header: 'Total', key: 'total', width: 10 },
    { header: 'Provenance', key: 'prov', width: 13 },
    { header: 'Derived', key: 'derived', width: 10 },
    { header: 'Note', key: 'note', width: 70 },
  ]
  prov.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  prov.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER } }
  prov.views = [{ state: 'frozen', ySplit: 1 }]
  for (const l of lines) {
    prov.addRow({
      rule: l.ruleId, code: l.code ?? '', desc: l.description, group: groupLabel(l.group),
      main: l.main ?? '', spare: l.spare || 0, total: l.qty ?? '',
      prov: l.provenance, derived: l.derived ?? '', note: l.note ?? '',
    })
  }
  prov.autoFilter = { from: { row: 1, column: 1 }, to: { row: lines.length + 1, column: 10 } }

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>
}
