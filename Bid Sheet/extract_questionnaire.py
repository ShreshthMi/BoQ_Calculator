"""
Extract the Project Questionnaire's shape from the handover workbook.

    python "Bid Sheet/extract_questionnaire.py"

Writes `Bid Sheet/questionnaire.json`: the 22 numbered questions, their options,
the cell each free-text answer lives in, and — the part that matters — which
`ctrlProps` part holds each option's tick.

WHY THIS IS A GENERATED ARTEFACT RATHER THAN A HAND-WRITTEN TABLE

The questionnaire's answers are 62 legacy Form Control checkboxes. They carry no
`FmlaLink`, so the state lives only as `checked="Checked"` inside
`xl/ctrlProps/ctrlPropN.xml` and there is no linked cell to read or write. To
tick "b) NO" under question 18 you have to know which of those 62 files is the
one — and nothing in the workbook says so directly.

What it does say is where each control sits. `xl/drawings/vmlDrawing2.vml` gives
every shape an absolute position, and the sheet's row heights turn that into a
row. Match the row against the option labels in column B and the mapping falls
out. Two traps make it harder than it sounds:

  * the VML mixes units — most positions are in points, one is `9in`
  * the `<control>` anchors in the sheet XML are NOT reliable here. They are
    relative to a row whose height has since changed, so a naive `from.row`
    reading drifts by one over the lower half of the sheet and lands two
    controls on the same option.

The absolute VML position, resolved against real row heights, puts all 62 on a
distinct option row — which is the check this script asserts before writing.

The result is worth reading as evidence in its own right. The reference project
answers "Decentralised" to the architecture question, which is the equipment
rooms; "Separate Evaluator ... Yes", which is why the packer splits DN from UP;
and "Spare Requirement: NO", which is why the submitted BoQ books no spares on
any of its 41 lines.
"""
import json
import os
import re
import zipfile

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BOOK = os.path.join(ROOT, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx')
OUT = os.path.join(HERE, 'questionnaire.json')

SHEET = '4. Project Questionnairre'
SHEET_PART = 'xl/worksheets/sheet3.xml'
RELS_PART = 'xl/worksheets/_rels/sheet3.xml.rels'
VML_PART = 'xl/drawings/vmlDrawing2.vml'

TO_POINTS = {'pt': 1.0, 'in': 72.0, 'cm': 28.3465, 'mm': 2.83465}

# A question opens either "7. Rail Profile" or "10 (A) Station Application".
#
# The trailing "\s+[A-Za-z]" is what keeps the sub-items out: "11.I. Data
# Transmission" and "14.a) LV box" both start with a number and a period, but
# neither has a space before the next token, so neither opens a question. The
# sheet numbers its own sub-items inconsistently — the two under "12. Reset
# Requirement" are labelled 14.a and 14.b — so their number cannot be trusted to
# say where they belong; their shape can.
QUESTION = re.compile(r'^(\d+)\.\s+[A-Za-z]|^(\d+)\s*\([A-C]\)')
OPTION = re.compile(r'^(?:[a-fA-F]\)|[IVX]+\s*\.)', re.I)


def points(style, prop, default=None):
    m = re.search(prop + r':([-\d.]+)(pt|in|cm|mm)', style)
    if not m:
        return default
    return float(m.group(1)) * TO_POINTS[m.group(2)]


def text_of(ws, row, col):
    v = ws.cell(row=row, column=col).value
    if v is None:
        return ''
    return re.sub(r'\s+', ' ', str(v).replace('\xa0', ' ')).strip()


def main():
    wb = openpyxl.load_workbook(BOOK, data_only=True)
    ws = wb[SHEET]
    last = ws.max_row
    default_height = ws.sheet_format.defaultRowHeight or 14.4

    # --- row geometry -------------------------------------------------------
    top, acc = {}, 0.0
    for r in range(1, last + 2):
        top[r] = acc
        d = ws.row_dimensions.get(r)
        acc += (d.height if d is not None and d.height else default_height)

    def row_at(pt):
        for r in range(1, last + 1):
            if top[r] <= pt < top[r + 1]:
                return r
        return last

    # --- controls -----------------------------------------------------------
    z = zipfile.ZipFile(BOOK)
    sheet_xml = z.read(SHEET_PART).decode('utf8', 'replace')
    rels_xml = z.read(RELS_PART).decode('utf8', 'replace')
    vml = z.read(VML_PART).decode('utf8', 'replace')

    shapes = {}
    for sh in re.findall(r'<v:shape\b.*?</v:shape>', vml, re.S):
        sid = re.search(r'id="_x0000_s(\d+)"', sh)
        style = re.search(r"style='([^']*)'", sh, re.S)
        if not sid or not style:
            continue
        flat = re.sub(r'\s+', '', style.group(1))
        mt = points(flat, 'margin-top')
        if mt is None:
            continue
        shapes[sid.group(1)] = {
            'top': mt,
            'left': points(flat, 'margin-left', 0.0),
            'height': points(flat, 'height', 16.2),
        }

    targets = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels_xml))
    controls = []
    for m in re.finditer(r'<control shapeId="(\d+)" r:id="(rId\d+)" name="([^"]*)">', sheet_xml):
        shape, rid, name = m.groups()
        part = 'xl/' + targets[rid].replace('../', '')
        box = shapes[shape]
        controls.append({
            'name': name,
            'part': part,
            'row': row_at(box['top'] + box['height'] / 2),
            'left': round(box['left'], 1),
            'checked': 'checked="Checked"' in z.read(part).decode('utf8', 'replace'),
        })

    # Question 5 is a grid: one row per application, three columns of ticks.
    # Group the horizontal positions so a column can be named.
    lefts = sorted({c['left'] for c in controls})
    bands = []
    for x in lefts:
        if not bands or x - bands[-1][-1] > 20:
            bands.append([x])
        else:
            bands[-1].append(x)
    band_of = {x: i for i, group in enumerate(bands) for x in group}

    # --- questions and options ---------------------------------------------
    by_row = {}
    for c in controls:
        by_row.setdefault(c['row'], []).append(c)

    questions, current = [], None
    for r in range(1, last + 1):
        label = text_of(ws, r, 2)
        if not label:
            continue
        qm = QUESTION.match(label)
        if qm and not OPTION.match(label):
            current = {
                'id': f'q{len(questions) + 1}',
                'number': re.match(r'^\d+(?:\s*\([A-C]\))?', label).group(0).strip(),
                'row': r,
                'text': label,
                'answerCell': None,
                'hint': text_of(ws, r, 4) or None,
                'options': [],
            }
            questions.append(current)
            continue
        if current is None:
            continue
        ticks = by_row.get(r, [])
        if OPTION.match(label) or ticks:
            current['options'].append({
                'row': r,
                'text': label,
                'controls': [
                    {'part': c['part'], 'band': band_of[c['left']], 'checked': c['checked']}
                    for c in sorted(ticks, key=lambda c: c['left'])
                ],
            })

    # A free-text answer sits in column C, on the question's own row or the two
    # below it — before its options start. Searching further would let one
    # question claim the next one's answer.
    starts = [q['row'] for q in questions]
    for i, q in enumerate(questions):
        stop = starts[i + 1] if i + 1 < len(questions) else last + 1
        first_option = min((o['row'] for o in q['options']), default=stop)
        for r in range(q['row'], min(q['row'] + 3, first_option + 1, stop)):
            if text_of(ws, r, 3):
                q['answerCell'] = f'C{r}'
                q['answerValue'] = text_of(ws, r, 3)
                break

    # --- checks: the whole point of generating this rather than typing it ---
    placed = [c for c in controls]
    seen = {}
    for c in placed:
        key = (c['row'], band_of[c['left']])
        assert key not in seen, (
            f'{c["name"]} and {seen[key]} both land on row {c["row"]} band {key[1]}'
        )
        seen[key] = c['name']
    stray = [c for c in placed if not OPTION.match(text_of(ws, c['row'], 2))]
    assert not stray, f'{len(stray)} control(s) not on an option row: ' + \
        ', '.join(f'{c["name"]}@B{c["row"]}' for c in stray[:5])
    mapped = sum(len(o['controls']) for q in questions for o in q['options'])
    assert mapped == len(controls), f'{mapped} controls mapped of {len(controls)}'

    doc = {
        'meta': {
            'workbook': os.path.basename(BOOK),
            'sheet': SHEET,
            'sheetPart': SHEET_PART,
            'controls': len(controls),
            'ticked': sum(1 for c in controls if c['checked']),
            'bands': len(bands),
            'note': 'Generated by Bid Sheet/extract_questionnaire.py. Do not edit by hand.',
        },
        'guidelines': {'cell': 'B151', 'text': text_of(ws, 151, 2)},
        'questions': questions,
    }
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'{len(questions)} questions, '
          f'{sum(len(q["options"]) for q in questions)} options, '
          f'{len(controls)} controls ({doc["meta"]["ticked"]} ticked) -> {OUT}')


if __name__ == '__main__':
    main()
