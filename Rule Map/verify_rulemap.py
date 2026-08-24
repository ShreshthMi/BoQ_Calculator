# -*- coding: utf-8 -*-
"""The five verification checks for the rule seed and fixtures."""
import json, io, os, re, openpyxl, warnings
warnings.filterwarnings('ignore')

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(ROOT)
seed = json.load(io.open(os.path.join(ROOT, 'rules.seed.json'), encoding='utf-8'))
RULES = seed['rules']
LOCS = json.load(io.open(os.path.join(ROOT, 'fixtures', 'locations.json'), encoding='utf-8'))
EXP = {p: json.load(io.open(os.path.join(ROOT, 'fixtures', 'expected-%s.json' % p.lower()),
                            encoding='utf-8')) for p in ('ABS', 'Yard')}
PARTS = {p['key']: p for p in json.load(
    io.open(os.path.join(BASE, 'Part Catalogue', 'parts.json'), encoding='utf-8'))['parts']}
fails = []


def check(n, ok, detail=''):
    print('%s %s%s' % ('PASS' if ok else 'FAIL', n, ('  ' + detail) if detail else ''))
    if not ok:
        fails.append(n)


# 1 -- source references resolve to real cells ------------------------------
wb = openpyxl.load_workbook(os.path.join(BASE, 'BOM CAL', 'ABS V.1_2025-BRC with BD BOM.xlsm'),
                            data_only=False)
bad = []
for r in RULES:
    s = r.get('source')
    if not s:
        continue
    # A rule may cite the handover questionnaire rather than the calculator —
    # the cable-length guideline lives there and nowhere else.
    hq = re.match(r"^Handover '([^']+)'!\$?([A-Z]{1,2})\$?(\d+)", s)
    if hq:
        hb = openpyxl.load_workbook(
            os.path.join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx'),
            data_only=True)
        if hq.group(1) not in hb.sheetnames:
            bad.append((r['id'], s))
        elif hb[hq.group(1)]['%s%s' % (hq.group(2), hq.group(3))].value is None:
            bad.append((r['id'], s))
        hb.close()
        continue
    m = re.match(r"^(Gesamt|BD BOM)!\$?([A-Z]{0,2})\$?(\d+)", s)
    if not m:
        bad.append((r['id'], s))
        continue
    ws = wb[m.group(1)]
    col, row = m.group(2), int(m.group(3))
    if not (1 <= row <= ws.max_row):
        bad.append((r['id'], s))
    elif col and openpyxl.utils.column_index_from_string(col) > ws.max_column:
        bad.append((r['id'], s))
wb.close()
check('1. every source reference resolves to a real cell',
      not bad, '%d of %d rules carry provenance'
      % (sum(1 for r in RULES if r.get('source')), len(RULES)))

# 2 -- rule/part join is total ---------------------------------------------
unresolved = [r['id'] for r in RULES if r['partKey'] and r['partKey'] not in PARTS]
mismatch = [r['id'] for r in RULES if r['partKey'] and not r['partMissing']
            and r['part'] not in PARTS[r['partKey']]['codes'].values()]
check('2. every rule part resolves against the catalogue',
      not unresolved and not mismatch,
      '%d rules, %d without an orderable part number'
      % (len(RULES), sum(1 for r in RULES if r['partMissing'])))

# 3 -- every quantity-bearing part is reachable from some rule --------------
seeded = {r['partKey'] for r in RULES if r['partKey']}
withqty = {p['key'] for p in PARTS.values()
           if p['quantities']['ABS']['total'] or p['quantities']['Yard']['total']}
check('3. every part carrying a quantity is reachable from a rule',
      withqty <= seeded, '%d of %d covered; missing %s'
      % (len(withqty & seeded), len(withqty), sorted(withqty - seeded) or 'none'))

# 4 -- fixtures reconcile to the independently validated totals -------------
TARGET = {'Evaluation board AEB': 550, 'Input/Output board IO-EXB': 244,
          'Board rack BGT07 84 TE': 68, 'Backplane BP-PWR-4': 19,
          'Backplane BP-PWR-8': 56, 'Backplane BP-EXB-1': 27,
          'Backplane BP-EXB-2': 92, 'Backplane BP-EXB-4': 10,
          'Power supply with Crowbar PSC': 61, 'Communication board COM-AdC': 42,
          'Wheel sensor RSR180': 550, 'Overvoltage protection board BSI': 550}
got = {}
for proj in EXP:
    for row in EXP[proj]['gesamt']:
        got[row['label']] = got.get(row['label'], 0) + row['total']
diff = {k: (v, got.get(k)) for k, v in TARGET.items() if got.get(k) != v}
check('4. fixture totals match the validated BoQ figures', not diff,
      '%d of %d line totals agree%s'
      % (len(TARGET) - len(diff), len(TARGET), '' if not diff else '  %s' % diff))

dp = sum(LOCS[p]['totalDP'] for p in LOCS)
check('4a. total detection points = 550 (NIT)', dp == 550, 'got %d' % dp)
ts = LOCS['Yard']['totalTS']
check('4b. Yard track sections = 303 (16.DP TS details)', ts == 303, 'got %d' % ts)

# 5 -- the four hand-validated locations ------------------------------------
bgt = next(g for g in EXP['ABS']['gesamt'] if g['label'] == 'Board rack BGT07 84 TE')
byname = {l['name']: l['id'] for l in LOCS['ABS']['locations']}
want = {'Jaipur JN': 1, 'ALH-1': 3, 'Durgapura': 3, 'ALH-2': 4}
racks = {n: bgt['byLocation'][byname[n]] for n in want}
check('5. rack counts at the four hand-validated locations', racks == want, str(racks))

print()
print('ALL CHECKS PASSED' if not fails else 'FAILURES: %s' % fails)
