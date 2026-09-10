# -*- coding: utf-8 -*-
"""Cross-check the extracted catalogue against two independent references:
   1. sum of per-location quantities == the workbook's own BG total
   2. ABS + Yard total == the handover sheet's '10.  BOQ' total, matched on part number
"""
import csv, io, json, openpyxl, warnings
warnings.filterwarnings('ignore')

parts = json.load(io.open('Part Catalogue/parts.json', encoding='utf-8'))['parts']

# 1. internal consistency -------------------------------------------------
bad = []
for p in parts:
    for proj, q in p['quantities'].items():
        s = sum(e['qty'] for e in q['by_location'])
        if s != q['total']:
            bad.append((p['key'], proj, s, q['total']))
print('1. per-location sums vs workbook BG total : %s'
      % ('all %d parts x 2 projects agree' % len(parts) if not bad else 'MISMATCH %s' % bad))

# 2. against the handover BoQ ---------------------------------------------
wb = openpyxl.load_workbook('BOM CAL/Handover BID Process Sheet Version 11.xlsx', data_only=True)
ws = wb['10.  BOQ']
boq = {}
for r in range(3, 44):
    c, t = ws.cell(r, 3).value, ws.cell(r, 7).value
    if c is not None and isinstance(t, (int, float)):
        boq[str(int(c)) if isinstance(c, float) and c.is_integer() else str(c).strip()] = t
wb.close()

agree, differ, absent = [], [], []
for p in parts:
    codes = [c for c in p['codes'].values() if c]
    hit = next((c for c in codes if c in boq), None)
    tot = p['quantities']['ABS']['total'] + p['quantities']['Yard']['total']
    if hit is None:
        if tot:
            absent.append((p['key'], p['description'][:46], tot))
        continue
    (agree if boq[hit] == tot else differ).append((p['key'], hit, p['description'][:46], tot, boq[hit]))

print('2. catalogue total vs handover "10.  BOQ" total')
print('   matched on part number : %d lines' % (len(agree) + len(differ)))
print('   identical              : %d' % len(agree))
print('   differing              : %d' % len(differ))
for k, c, d, a, b in differ:
    print('      %s %-9s %-46s catalogue=%-8s handover=%s' % (k, c, d, a, b))
print('   in catalogue with qty but absent from handover BoQ : %d' % len(absent))
for k, d, t in absent:
    print('      %s %-46s %s' % (k, d, t))
