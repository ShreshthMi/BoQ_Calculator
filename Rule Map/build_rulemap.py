# -*- coding: utf-8 -*-
"""Build the rule map, the rule-engine seed and the Phase-0 fixtures.

Inputs
    Part Catalogue/parts.json                     the extracted part master
    BOM CAL/{ABS,Yard} ... .xlsm                  Gesamt + BD BOM actuals
    BOM CAL DESIGN/BOM Calculator.dc.html         the prototype's 28 rules

Outputs (all under Rule Map/)
    rules.seed.json          rules conforming to the proposal's Rule type
    rule-map.md              the mapping document
    fixtures/locations.json  normalised Location[] per project
    fixtures/expected-*.json per-location per-line golden set
"""
import openpyxl, json, os, re, io, warnings
from collections import Counter, OrderedDict
warnings.filterwarnings('ignore')

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(ROOT)
OUT = ROOT
FIX = os.path.join(OUT, 'fixtures')
SRC = {'ABS':  os.path.join(BASE, 'BOM CAL', 'ABS V.1_2025-BRC with BD BOM.xlsm'),
       'Yard': os.path.join(BASE, 'BOM CAL', 'Yard V.1_2025-BRC with BD BOM.xlsm')}
DESIGN = os.path.join(BASE, 'BOM CAL DESIGN', 'BOM Calculator.dc.html')
CATALOGUE = os.path.join(BASE, 'Part Catalogue', 'parts.json')

# --------------------------------------------------------------------------
# part master, for code resolution
# --------------------------------------------------------------------------
PARTS = {p['key']: p for p in json.load(io.open(CATALOGUE, encoding='utf-8'))['parts']}


def part_of(bd):
    """Resolve a BD key to (code, description). Prefers IN Sales Cloud."""
    if bd is None:
        return None, None
    p = PARTS[bd]
    c = p['codes']
    code = c['in_sales_cloud'] or c['ramco_erp'] or c['at_sales_cloud'] or None
    return code, p['description']


# --------------------------------------------------------------------------
# The recovered rules. Hand-authored from the formulas traced through
# BD BOM -> Gesamt -> sheet '01'. `src` is the cell the rule was read from;
# `bd` is the catalogue row that carries an orderable part number.
#
# confidence:
#   confirmed  Excel and prototype agree
#   inverted   same quantity, opposite direction (Excel sums a manual layout)
#   conflict   both have a rule and they disagree
#   recovered  works in Gesamt but never reaches BD BOM
#   manual     no formula anywhere; a human types it
# --------------------------------------------------------------------------
R = [
 # ---- Outdoor -----------------------------------------------------------
 dict(id='G05', bd='BD005', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src="Gesamt!5 <- '01'!B5 = AG3", confidence='inverted', proto='R01',
      split=[('BD005', 100.0), ('BD006', 0.0), ('BD007', 0.0)],
      note='Excel sums AEB slots; DP is the true driver. Split across 5/10/15 m tails '
           'is set to 100% 5 m in the workbook, but the tender shipped 350/163/37.'),
 dict(id='G06a', bd='BD008', group='OUTDOOR', driver='PART_REF', expression='part(BD005)',
      rounding='NONE', src='BD BOM!H8 = H5', confidence='confirmed', proto=None,
      note='Protection tube follows the 5 m sensor 1:1.'),
 dict(id='G06b', bd='BD009', group='OUTDOOR', driver='PART_REF', expression='part(BD006)',
      rounding='NONE', src='BD BOM!H9 = H6', confidence='confirmed', proto=None),
 dict(id='G06c', bd='BD010', group='OUTDOOR', driver='PART_REF', expression='part(BD007)',
      rounding='NONE', src='BD BOM!H10 = H7', confidence='confirmed', proto=None),
 dict(id='G07', bd='BD011', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src='BD BOM!H11 = H5+H6+H7', confidence='confirmed', proto='R02',
      note='Prototype books this as FMA-001; the real part is SK140-011.'),
 dict(id='G07b', bd='BD013', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src='BD BOM!H13 = H5+H6+H7', confidence='recovered', proto=None,
      note='Rail claw plate. Prototype folds claw and plate into one line.'),
 dict(id='G08', bd='BD015', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src='BD BOM!H15 = H5+H6+H7', confidence='recovered', proto=None),
 dict(id='G09', bd='BD017', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src='BD BOM!H17 = H5+H6+H7', confidence='placeholder', proto='R03',
      note='Prototype books TB-OD-12 at DP/2. That part is invented; TLJB-01 is 1:1.'),
 dict(id='G09b', bd='BD018', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src='BD BOM!H18 = H5+H6+H7', confidence='recovered', proto=None),
 dict(id='G09c', bd='BD019', group='OUTDOOR', driver='DP', expression='DP', rounding='NONE',
      src='BD BOM!H19 = H5+H6+H7', confidence='recovered', proto=None),
 dict(id='G10', bd='BD030', group='OUTDOOR', driver='BOARD', expression='AEB/25', rounding='UP',
      src="Gesamt!10 <- '01'!B10 = ROUNDUP(AG3/25,0)", confidence='recovered', proto=None,
      note='One testing plate per 25 evaluation boards.'),
 dict(id='G12', bd='BD024', group='OUTDOOR', driver='BOARD', expression='AEB/25', rounding='UP',
      src="Gesamt!12 <- '01'!B12", confidence='recovered', proto=None),
 dict(id='G13', bd='BD031', group='INDOOR', driver='DP', expression='DP', rounding='NONE',
      src="Gesamt!13 <- '01'!B13 = B5", confidence='confirmed', proto='R18',
      note='Prototype books SURGE-24V; the real part is BSI004. Same 1:1 per DP.'),

 # ---- Trackside kits: the cable-length split ----------------------------
 # Not in either calculator - BD BOM rows 6/7 and 9/10 carry no formula and
 # Gesamt has no length dimension. The rule is written in the handover sheet's
 # questionnaire, cell B151 item 16, and reproduces the hidden BoQ sheet exactly.
 dict(id='K01', bd='BD096', group='OUTDOOR', driver='CABLE', expression='dp_5m',
      rounding='NONE', scope='project',
      src="Handover '4. Project Questionnairre'!B151 item 16",
      confidence='guideline', proto='R26',
      note='Trackside kit, 4.8 m tube. Station 75%, auto block 50%.'),
 dict(id='K02', bd='BD129', group='OUTDOOR', driver='CABLE', expression='dp_10m',
      rounding='NONE', scope='project',
      src="Handover '4. Project Questionnairre'!B151 item 16",
      confidence='guideline', proto='R26',
      note='Trackside kit, 9.8 m tube. Station 15%, auto block 50%, dual-redundant 75%.'),
 dict(id='K03', bd='BD127', group='OUTDOOR', driver='CABLE', expression='dp_15m',
      rounding='NONE', scope='project',
      src="Handover '4. Project Questionnairre'!B151 item 16",
      confidence='guideline', proto='R26',
      note='Trackside kit, 14.8 m tube. Station 10%, dual-redundant 25%.'),

 # ---- Indoor: racks and backplanes (all from the packer) ----------------
 dict(id='G14', bd='BD032', group='INDOOR', driver='RACK', expression='racks', rounding='NONE',
      src="Gesamt!14 <- '01'!B14 = COUNTIF(C56:C163,\"BGT07\")", confidence='inverted', proto='R06',
      note='Excel counts rack labels a human typed. The packer must produce this.'),
 dict(id='G15', bd='BD085', group='INDOOR', driver='RACK', expression='racks42', rounding='NONE',
      src="Gesamt!15 <- '01'!B15 = COUNTIF(C56:C163,\"BGT08\")", confidence='inverted', proto=None,
      note='42 TE rack. Unused on this tender; the prototype has no 42 TE variant.'),
 dict(id='G16', bd='BD033', group='INDOOR', driver='BACKPLANE', expression='bp_pwr_0',
      rounding='NONE', src="Gesamt!16 <- '01'!B24 = AP3", confidence='inverted', proto=None),
 dict(id='G20', bd='BD034', group='INDOOR', driver='BACKPLANE', expression='bp_pwr_4',
      rounding='NONE', src="Gesamt!20 <- '01'!B28 = AT3", confidence='inverted', proto=None,
      note='24 TE = 8 (PSC) + 4x4 (AEB).'),
 dict(id='G22', bd='BD035', group='INDOOR', driver='BACKPLANE', expression='bp_pwr_8',
      rounding='NONE', src="Gesamt!22 <- '01'!B30 = AV3", confidence='inverted', proto='R07',
      note='40 TE = 8 (PSC) + 8x4 (AEB).'),
 dict(id='G29', bd='BD036', group='INDOOR', driver='BACKPLANE', expression='bp_exb_1',
      rounding='NONE', src="Gesamt!29 <- '01'!B37 = BB3", confidence='inverted', proto='R09',
      note='10 TE = 4 + 1x6 (IO-EXB).'),
 dict(id='G30', bd='BD037', group='INDOOR', driver='BACKPLANE', expression='bp_exb_2',
      rounding='NONE', src="Gesamt!30 <- '01'!B38 = BC3", confidence='inverted', proto='R08',
      note='16 TE = 4 + 2x6.'),
 dict(id='G32', bd='BD038', group='INDOOR', driver='BACKPLANE', expression='bp_exb_4',
      rounding='NONE', src="Gesamt!32 <- '01'!B40 = BE3", confidence='inverted', proto=None,
      note='28 TE = 4 + 4x6. Dual detection only; Yard books zero, ABS books ten.'),
 dict(id='G35', bd='BD039', group='INDOOR', driver='BOARD', expression='PSC + psc_r',
      rounding='NONE', src="Gesamt!35 <- '01'!AF3 = SUM(AF59:AF167)+AM3",
      confidence='conflict', proto='R11',
      note='AF59 is COUNTIF(D58:X58,"PSC") - it counts EQUIPPED PSC boards, not '
           'BP-PWR backplanes. ALH-1 has four BP-PWR and two PSC, the other two '
           'power slots carrying a spare-PSC blank. Prototype R11 books one PSU '
           'per power backplane, which over-books. AM3 (PSC-R) is 0 on this tender.'),
 dict(id='G36', bd='BD040', group='INDOOR', driver='BOARD', expression='COM_ADC',
      rounding='NONE', src="Gesamt!36 <- '01'!B18 = AH3", confidence='inverted', proto=None,
      note='ONE COM BOARD PER EVALUATION GROUP. A COM board is one CAN segment, and '
           'Gesamt!AI88 "Redundancy COM" is set on this project, so each segment '
           'carries one COM per system - one per group. Gesamt!BJ3 = COM / AL95 where '
           'AL95 = 2 states the same thing from the other side (AL90 = 1 is the '
           'non-redundant divisor, unused here). Exact at 17 of 21 locations; the four '
           'exceptions - Jaipur JN, Durgapura, Sanganer, Sheodaspura - each omit the '
           'redundant COM, so the shipped BoQ under-books 4 boards.'),
 dict(id='G39', bd='BD041', group='INDOOR', driver='DP', expression='DP', rounding='NONE',
      src="Gesamt!39 <- '01'!B17 = AG3", confidence='inverted', proto='R04',
      note='One evaluation board per detection point.'),
 dict(id='G40', bd='BD042', group='INDOOR', driver='BOARD', expression='IO_EXB',
      rounding='NONE', src="Gesamt!40 <- '01'!B21 = AK3", confidence='inverted', proto='R05',
      note='One IO-EXB per two track sections - the grid gives each board an FMA1 and '
           'an FMA2 row, so 2 TS per board is structural. But the ceiling applies PER '
           'EVALUATION GROUP, not per location: ceil(ts/2) summed over groups gives 244 '
           'and matches the workbook at all 18 locations, while ceil(TS/2) per location '
           'gives 237. The packer already seats them correctly, so this reads its count '
           'rather than recomputing. No separate data-transmission allowance is needed.'),
 dict(id='G41', bd='BD043', group='INDOOR', driver='BACKPLANE',
      expression='bp_exb_1*1 + bp_exb_2*2 + bp_exb_4*4 + bp_exb_8*8', rounding='NONE',
      src="Gesamt!41 <- '01'!B22 = AL3", confidence='conflict', proto=None,
      note='DEFECT. BD BOM!H43 instead uses = IO-EXB 1:1, giving 88 where Gesamt '
           'gives 92 on ABS. The BoQ ships the smaller number.'),
 dict(id='G45', bd=None, group='INDOOR', driver='RACK', expression='spare_psc_slots*2',
      rounding='NONE', src='Gesamt!45 = COUNTIF(\'01\'!C56:AB166,"spare-PSC")*2',
      confidence='recovered', proto='R10', note='4 TE blanking plate for spare PSC slots.'),
 dict(id='G46', bd=None, group='INDOOR', driver='RACK', expression='spare_aeb_slots',
      rounding='NONE', src='Gesamt!46 = COUNTIF(\'01\'!C56:AB166,"spare")',
      confidence='recovered', proto='R10', note='4 TE blanking plate for spare AEB slots.'),
 dict(id='G47', bd=None, group='INDOOR', driver='RACK', expression='spare_io_slots',
      rounding='NONE', src='Gesamt!47 = COUNTIF(\'01\'!C56:AB166,"spare IO")',
      confidence='recovered', proto='R10', note='6 TE blanking plate for spare IO slots.'),
 dict(id='G59', bd=None, group='INDOOR', driver='BACKPLANE',
      expression='2*bp_all - COM_ADC - COM_XXX', rounding='NONE',
      src='Gesamt!59 = 2*(C20+C22+C27+C29+C30+C32+C34)-C36-C37',
      confidence='recovered', proto=None,
      note='Patch cable. Sums only the backplane variants in use, so it silently '
           'misses PWR-0/1/2/3/6/10/12/14/16 and EXB-0/3/6.'),

 # ---- Cubicle -----------------------------------------------------------
 dict(id='G55', bd='BD087', group='CUBICAL', driver='RACK', expression='racks/6', rounding='UP',
      src="Gesamt!55 <- '01'!B46 = IF(AI82<>\"\",ROUNDUP(B14/6,0),0)",
      condition='cubiclesEnabled', confidence='recovered', proto=None,
      note='THE headline orphan. Cubicles are not rule-less; the rule is switched '
           'off by a blank flag on Gesamt!AI82, so 22 were typed by hand.'),
 dict(id='G56', bd=None, group='CUBICAL', driver='CUBICLE', expression='cubicles',
      rounding='NONE', src="Gesamt!56 <- '01'!BN3 = IF(BP3/1000*BQ3>120,BL3,0)",
      condition='powerAbove120W', confidence='conflict', proto='R27',
      note='Active fan. Confirms the 120 W threshold, but quantity is per cubicle, '
           'not the 2-per-cubicle the prototype assumes.'),
 dict(id='G57', bd=None, group='CUBICAL', driver='RACK', expression='floor(racks/2)',
      rounding='NONE', src="Gesamt!57 <- '01'!BM3 step table over B14+B15",
      condition='cubiclesEnabled', confidence='recovered', proto=None,
      note='19in slot fan. Step table 1..8 racks -> 0,1,1,2,2,3,3,4 = floor(racks/2).'),
 dict(id='G58', bd=None, group='CUBICAL', driver='CUBICLE', expression='cubicles',
      rounding='NONE', src='Gesamt!58 = C55', confidence='recovered', proto=None,
      note='Wiring, one per cubicle.'),

 # ---- Reset / Switch: prototype-only, no Excel rule ----------------------
 dict(id='M01', bd='BD045', group='RESET', driver='MANUAL', expression='', rounding='NONE',
      src=None, confidence='manual', proto='R12',
      note='Reset box. 315 typed by hand. Prototype guesses one per TS, centralised only.'),
 dict(id='M02', bd='BD050', group='RESET', driver='MANUAL', expression='', rounding='NONE',
      src=None, confidence='manual', proto=None, note='Reset cubicle. 16 typed by hand.'),
 dict(id='M03', bd='BD051', group='RESET', driver='MANUAL', expression='', rounding='NONE',
      src=None, confidence='manual', proto=None,
      note='Co-operation reset panel. 11 typed by hand.'),
 dict(id='M04', bd='BD023', group='OUTDOOR', driver='MANUAL', expression='', rounding='NONE',
      src=None, confidence='manual', proto=None,
      note='Line Verification Box. 189 typed by hand.'),

 # ---- Misc --------------------------------------------------------------
 dict(id='G53', bd='BD044', group='MISC', driver='BOARD',
      expression='(AEB + COM_ADC + COM_XXX + IO_EXB)/110', rounding='UP',
      src="Gesamt!53 <- '01'!B45 = BK3", condition='fdsRequired',
      confidence='conflict', proto='R19',
      note='Divisor is 110 per the Bid team. The workbook reads /150 identically in '
           'all 60 location sheets - a latent defect. The tender cannot expose it: '
           'the largest location carries 64 boards, so both give 1 FDS everywhere.'),
 dict(id='G54', bd=None, group='MISC', driver='PART_REF', expression='part(BD044)',
      rounding='NONE', src='Gesamt!54 = IF(C55>0,C53,0)', condition='cubiclesEnabled',
      confidence='recovered', proto=None, note='Wiring FDS, only where cubicles exist.'),

 # ---- Services ----------------------------------------------------------
 dict(id='G49', bd=None, group='SERVICE', driver='LOCATION', expression='locations',
      rounding='NONE', src='Gesamt!49 = IF(AI82<>"",C55,1)', condition='planningIncluded',
      confidence='recovered', proto='R21',
      note='Planning basic cost. Per cubicle when cubicles are enabled, else per location.'),
 dict(id='G50', bd=None, group='SERVICE', driver='BOARD', expression='AEB + COM_ADC + COM_XXX',
      rounding='NONE', src='Gesamt!50 = IF(AI83<>"",SUM(C36,C37,C39),0)',
      condition='planningIncluded', confidence='recovered', proto=None,
      note='Configuration file creation, per board.'),
 dict(id='G51', bd=None, group='SERVICE', driver='BOARD', expression='AEB + COM_ADC + COM_XXX',
      rounding='NONE', src='Gesamt!51 = IF(AI83<>"",SUM(C37,C36,C39),0)',
      condition='planningIncluded', confidence='recovered', proto='R22',
      note='Configuration, labelling and testing, per board.'),
]

# ---- Spares: per-part percentage, Gesamt rows 73-101 ---------------------
SPARES = [('G73', 'BD005', 0.05, 'Spare RSR', 'R23'), ('G74', 'BD031', 0.01, 'Spare BSI', None),
          ('G75', 'BD039', 0.01, 'Spare PSC', None), ('G77', 'BD041', 0.01, 'Spare AEB', 'R24'),
          ('G82', 'BD034', 0.01, 'Spare BP-PWR-4', None),
          ('G84', 'BD035', 0.01, 'Spare BP-PWR-8', None),
          ('G90', 'BD036', 0.01, 'Spare BP-EXB-1', None),
          ('G91', 'BD037', 0.01, 'Spare BP-EXB-2', None),
          ('G93', 'BD038', 0.01, 'Spare BP-EXB-4', None),
          ('G99', 'BD040', 0.01, 'Spare COM-AdC', None),
          ('G101', 'BD042', 0.01, 'Spare IO-EXB', 'R25')]
for rid, bd, pct, label, proto in SPARES:
    R.append(dict(id=rid, bd=bd, group='SPARE', driver='PART_REF',
                  expression='part(%s) * %s' % (bd, pct), rounding='UP',
                  src='Gesamt!%s = ROUNDUP(<ref> * %s, 0)' % (rid[1:], pct),
                  condition='sparesIncluded', confidence='conflict' if proto else 'recovered',
                  proto=proto, note='%s. Excel spares 27 lines at per-part factors; the '
                                    'prototype has one global %% over three parts.' % label))

# --------------------------------------------------------------------------
# the prototype's 28 rules, parsed from the design file
# --------------------------------------------------------------------------
html = io.open(DESIGN, encoding='utf-8').read()
block = re.search(r'RULES\s*=\s*\[(.*?)\n  \];', html, re.S).group(1)
PROTO = OrderedDict()
for line in re.findall(r"\{id:'(R\d+)'.*?\}", block):
    pass
for m in re.finditer(r"\{(id:'R\d+'.*?)\}(?:,|\s*$)", block):
    body = m.group(1)
    d = dict(re.findall(r"(\w+):'((?:[^'\\]|\\.)*)'", body))
    for k, v in re.findall(r"(\w+):(\d+)(?=[,}])", body):
        d.setdefault(k, v)
    PROTO[d['id']] = d

# --------------------------------------------------------------------------
# fixtures from the workbooks
# --------------------------------------------------------------------------
def build_fixtures():
    locs_all, expected_all = {}, {}
    for proj, path in SRC.items():
        wv = openpyxl.load_workbook(path, data_only=True)
        g, bd = wv['Gesamt'], wv['BD BOM']
        # keyed by id, never by name: the Yard workbook labels two columns
        # 'Devpura Acc-2', and a name-keyed map silently drops one of them
        cols = []
        for c in range(3, 33):
            nm = g.cell(4, c).value
            nm = str(nm).strip() if nm is not None else ''
            if nm and not re.fullmatch(r'(Tabelle|Loc)\s*\d+', nm):
                cols.append((c, nm, 'L%02d' % (len(cols) + 1)))
        locs = [{'id': lid, 'col': openpyxl.utils.get_column_letter(c), 'name': nm,
                 'dp': g.cell(62, c).value or 0, 'ts': g.cell(63, c).value or 0}
                for c, nm, lid in cols]
        locs_all[proj] = {'project': str(wv['Revision'].cell(21, 2).value or '').strip(),
                          'locations': locs,
                          'totalDP': sum(l['dp'] for l in locs),
                          'totalTS': sum(l['ts'] for l in locs)}

        gesamt = []
        for r in range(5, 64):
            lab = g.cell(r, 2).value
            if not lab or str(lab).strip() in ('0', 'Additional equipment', 'Spare parts'):
                continue
            vals = {lid: (g.cell(r, c).value or 0) for c, nm, lid in cols}
            gesamt.append({'row': r, 'label': str(lab).strip(),
                           'byLocation': vals, 'total': sum(vals.values())})
        spares = []
        for r in range(73, 102):
            lab = g.cell(r, 2).value
            if not lab:
                continue
            vals = {lid: (g.cell(r, c).value or 0) for c, nm, lid in cols}
            spares.append({'row': r, 'label': str(lab).strip(), 'factor': g.cell(r, 1).value,
                           'byLocation': vals, 'total': sum(vals.values())})
        bdbom = []
        for r in range(4, 145):
            desc = bd.cell(r, 6).value
            if not desc:
                continue
            vals = {lid: (bd.cell(r, 8 + i).value or 0)
                    for i, (c, nm, lid) in enumerate(cols)}
            tot = bd.cell(r, 59).value or 0
            if tot:
                bdbom.append({'key': 'BD%03d' % r,
                              'code': (bd.cell(r, 3).value or bd.cell(r, 2).value),
                              'description': re.sub(r'\s+', ' ', str(desc)).strip(),
                              'byLocation': vals, 'total': tot})
        expected_all[proj] = {'project': locs_all[proj]['project'], 'locations': locs,
                              'gesamt': gesamt, 'spares': spares, 'bdBom': bdbom}
        wv.close()
    return locs_all, expected_all


LOCS, EXPECTED = build_fixtures()

# --------------------------------------------------------------------------
# emit
# --------------------------------------------------------------------------
os.makedirs(FIX, exist_ok=True)

seed = []
for r in R:
    code, desc = part_of(r.get('bd'))
    p = PARTS.get(r.get('bd'))
    entry = OrderedDict()
    entry['id'] = r['id']
    entry['part'] = code
    entry['partKey'] = r.get('bd')
    entry['partDescription'] = desc
    entry['partMissing'] = code is None
    if p:
        entry['altCodes'] = {k: v for k, v in p['codes'].items() if v}
    entry['group'] = r['group']
    entry['driver'] = r['driver']
    # Gesamt computes every row per location column and sums across. Rounding
    # makes that different from applying the rule to a project total:
    # ceil(550/25) = 22, but the sum of ceil(loc/25) over 18 locations is 18.
    #
    # PART_REF rules are the exception: part(BD005) names a PROJECT quantity, and
    # it must see the override layer's effective value. A 1:1 follow-on of an
    # overridden line has to move with it, and a spare percentage has to be a
    # percentage of what is actually being bought.
    entry['scope'] = r.get('scope', 'project' if r['driver'] == 'PART_REF' else 'location')
    entry['expression'] = r['expression']
    entry['rounding'] = r['rounding']
    if r.get('condition'):
        entry['condition'] = r['condition']
    if r.get('split'):
        entry['split'] = [{'part': part_of(b)[0], 'partKey': b, 'pct': q}
                          for b, q in r['split']]
    entry['confidence'] = r['confidence']
    entry['prototypeRule'] = r.get('proto')
    entry['source'] = r.get('src')
    if r.get('note'):
        entry['note'] = r['note']
    seed.append(entry)

json.dump({'meta': {
    'description': 'Rule seed recovered from the BRC workbooks, mapped against the '
                   'prototype rules R01-R28.',
    'partKeyedOn': 'IN Item Code (Sales Cloud); alternates retained in altCodes',
    'typeExtensions': [
        "driver 'PART_REF' - spares as a percentage of another line; the proposal's "
        "enum cannot express this and 11 seeded rules need it",
        "driver 'MANUAL' - no formula anywhere; surfaces as a flagged blank",
        "source / sourceFormula - provenance back to sheet and cell",
        "confidence - confirmed | inverted | conflict | recovered | placeholder | manual",
        "partMissing - rule is computable but has no orderable part number"],
    'counts': dict(Counter(s['confidence'] for s in seed))},
    'rules': seed},
    io.open(os.path.join(OUT, 'rules.seed.json'), 'w', encoding='utf-8'),
    indent=2, ensure_ascii=False)

json.dump(LOCS, io.open(os.path.join(FIX, 'locations.json'), 'w', encoding='utf-8'),
          indent=2, ensure_ascii=False)
for proj in EXPECTED:
    json.dump(EXPECTED[proj],
              io.open(os.path.join(FIX, 'expected-%s.json' % proj.lower()), 'w', encoding='utf-8'),
              indent=2, ensure_ascii=False)

# --------------------------------------------------------------------------
# rule-map.md, generated from the seed so the two cannot drift
# --------------------------------------------------------------------------
VERDICT = OrderedDict([
    ('confirmed', 'Excel and prototype agree on both driver and arithmetic.'),
    ('inverted', 'Same quantity, opposite direction. Excel **sums a layout a human '
                 'built**; the prototype **generates** the layout. Correct as designed — '
                 'these are the numbers the packing algorithm has to earn.'),
    ('conflict', 'Both sides have a rule and they disagree. Resolve before shipping.'),
    ('placeholder', 'Prototype rule built on an invented part; the real catalogue settles it.'),
    ('recovered', 'Works in `Gesamt`, never reaches `BD BOM`. A rule the Bid team '
                  'already owns but retypes by hand every tender.'),
    ('guideline', 'Not in either calculator. Written down in prose in the handover '
                  'questionnaire, and recoverable from there.'),
    ('manual', 'No formula anywhere. Genuinely unknown.')])
GROUPS = ['OUTDOOR', 'INDOOR', 'CUBICAL', 'RESET', 'MISC', 'SERVICE', 'SPARE']
by_conf = Counter(s['confidence'] for s in seed)
mapped = {s['prototypeRule'] for s in seed if s['prototypeRule']}
rev = {}
for s in seed:
    if s['prototypeRule']:
        rev.setdefault(s['prototypeRule'], []).append(s)

L = []
w = L.append
w('# Rule map — BRC workbooks to prototype rules `R01`–`R28`')
w('')
w('Generated by `build_rulemap.py`. Verified by `verify_rulemap.py`.')
w('')
w('%d rules recovered from the workbooks, mapped against the prototype\'s 28. '
  'Part numbers are IN Item Code (Sales Cloud), with the other three systems kept '
  'in `altCodes`. Pricing is out of scope.' % len(seed))
w('')
w('| Verdict | Count | Meaning |')
w('|---|---|---|')
for k, d in VERDICT.items():
    w('| `%s` | %d | %s |' % (k, by_conf.get(k, 0), d))
w('')
w('## The headline')
w('')
w('`Gesamt` computes 58 line items. `BD BOM` consumes 13. **%d recovered rules '
  'never reach the commercial BoQ** — they are computed correctly and then dropped '
  'between two sheets of the same workbook. Cubicles, FDS, fans, blanking plates, '
  'patch cable, planning services and every spare line sit in that gap, which is '
  'exactly what the prototype flags as *"no rule exists"* and what the Bid team '
  'retypes each tender.' % by_conf.get('recovered', 0))
w('')
w('The second finding shapes the build: the Excel derives board counts by **counting '
  'a hand-built slot grid**, not by formula. `AEB = SUM(\'01\'!AG59:AG167)` sums a '
  'grid an engineer fills in; `BGT07 = COUNTIF(C56:C163,"BGT07")` counts rack labels '
  'they typed. The prototype does not re-implement the workbook — it inverts it. '
  'The %d `inverted` rules below are the ones the packer has to earn.'
  % by_conf.get('inverted', 0))
w('')
w('## The mapping')
w('')
w('| Rule | Part | Description | Driver · expression | Round | Prototype | Verdict |')
w('|---|---|---|---|---|---|---|')
for g in GROUPS:
    for s in [x for x in seed if x['group'] == g]:
        w('| `%s` | %s | %s | `%s`%s | %s | %s | `%s` |'
          % (s['id'], s['part'] or '—', (s['partDescription'] or '—')[:44],
             s['driver'], (' · `%s`' % s['expression']) if s['expression'] else '',
             s['rounding'], ('`%s`' % s['prototypeRule']) if s['prototypeRule'] else '—',
             s['confidence']))
w('')
w('## Reverse view — the 28 prototype rules')
w('')
w('| Prototype | Part | Rule text | Status |')
w('|---|---|---|---|')
for rid, p in PROTO.items():
    hits = rev.get(rid, [])
    if hits:
        st = ', '.join('`%s` %s' % (h['id'], h['confidence']) for h in hits)
    else:
        st = '**prototype-only** — no Excel counterpart'
    w('| `%s` | `%s` | %s | %s |' % (rid, p.get('part', ''), p.get('text', ''), st))
w('')
w('The %d unmapped rules (%s) are genuine prototype inventions: reset keys, the '
  'switch family, engraved labels, tool kits, cable and cubicle earth bars. Nothing '
  'in the workbook computes them, and nothing in the BoQ contradicts them — they are '
  'proposals, not recoveries, and should be marked as such in the UI.'
  % (len(PROTO) - len(mapped), ', '.join('`%s`' % r for r in sorted(set(PROTO) - mapped))))
w('')
w('## The conflicts')
w('')
for s in [x for x in seed if x['confidence'] in ('conflict', 'placeholder')]:
    w('### `%s` %s — %s' % (s['id'], s['part'] or '(no part)',
                            s['partDescription'] or s['group'].title()))
    w('')
    w('- **Excel** `%s`%s' % (s['driver'],
                              (' · `%s`' % s['expression']) if s['expression'] else ''))
    if s['prototypeRule']:
        p = PROTO[s['prototypeRule']]
        w('- **Prototype** `%s` — %s' % (s['prototypeRule'], p.get('text', '')))
    w('- **Source** `%s`' % s['source'])
    if s.get('note'):
        w('- %s' % s['note'])
    w('')
w('## The cable-length split — a rule from outside the calculator')
w('')
w('Every wheel sensor ships with its tail cable already attached, in 5 m, 10 m or '
  '15 m. Which length is needed depends on how far that sensor sits from its '
  'junction box, and tenders frequently do not state the distances.')
w('')
w('So the bid process carries a fallback: a fixed percentage mix chosen by '
  'application type. It is written in prose, in the handover workbook — sheet '
  '`4. Project Questionnairre`, cell **B151 item 16**, "Cable Length if not '
  'specified in tender document". Neither calculator contains it. `BD BOM` rows '
  '6/7 and 9/10 carry no formula in any location column of either workbook, and '
  '`Gesamt` has no length dimension at all.')
w('')
w('| Application | 5 m | 10 m | 15 m |')
w('|---|---|---|---|')
w('| Station — single, or the main half of dual | 75 % | 15 % | 10 % |')
w('| Station — redundant half of dual | — | 75 % | 25 % |')
w('| Auto block | 50 % | 50 % | — |')
w('| IBH / absolute block — single | 100 % | — | — |')
w('| IBH / absolute block — dual | 50 % | 50 % | — |')
w('')
w('Applied to this tender, where Yard is 374 DP of station work and ABS is 176 DP '
  'of auto block:')
w('')
w('```')
w('5 m    0.75 x 374  +  0.50 x 176   =  368.5  ->  369')
w('10 m   0.15 x 374  +  0.50 x 176   =  144.1  ->  144')
w('15 m   0.10 x 374                  =   37.4  ->   37')
w('```')
w('')
w('Fractions accumulate across the whole project and round once at the end. '
  'Rounding per location would drift — eighteen separate roundings of a 75/15/10 '
  'split do not sum to the same answer.')
w('')
w('**369 / 144 / 37 is exactly what the hidden older BoQ sheet `10. BoQ` books.** '
  'The shipped sheet `10.  BOQ` reads 350 / 163 / 37 — nineteen units moved from '
  '5 m to 10 m, by hand, after the fact, with no reason recorded anywhere. The '
  'rule reproduces what the engineer first computed; the gap to what shipped is '
  'one undocumented override.')
w('')
w('Seeded as `K01` / `K02` / `K03` against the three trackside kit codes '
  '`102058` / `101880` / `102428`. Note the standing caveat: this is a stated '
  'default for missing information, not a measurement. It holds only until '
  'someone has the real cable plan, at which point the rule should be switched '
  'off rather than overridden line by line.')
w('')
w('## Recovered but never wired')
w('')
w('These have working formulas in `Gesamt` and no path to `BD BOM`.')
w('')
w('| Rule | Line | Source | Prototype |')
w('|---|---|---|---|')
for s in [x for x in seed if x['confidence'] == 'recovered']:
    w('| `%s` | %s | `%s` | %s |'
      % (s['id'], (s['partDescription'] or s['note'] or '')[:46], s['source'],
         ('`%s`' % s['prototypeRule']) if s['prototypeRule'] else '— none'))
w('')
w('## Computable, but not orderable')
w('')
w('%d rules produce a quantity with no part number anywhere in `BD BOM`, so they '
  'cannot be put on a BoQ even once wired up. Each needs a code from the part master '
  'before it is worth automating.' % sum(1 for s in seed if s['partMissing']))
w('')
for s in [x for x in seed if x['partMissing']]:
    w('- `%s` — %s' % (s['id'], (s.get('note') or s['group']).split('.')[0]))
w('')
w('## Defects found in the workbook')
w('')
w('1. **FDS divisor.** The sheet reads `/150` identically in all 60 location sheets '
  'across both workbooks; the Bid team\'s rule is `/110`. The tender cannot expose '
  'the difference — the largest location carries 64 boards, so both give 1 FDS '
  'everywhere. It first bites above 110 boards at one location. Seeded as `/110`.')
w('2. **Two competing connector rules.** `Gesamt!41` computes '
  '`EXB-1×1 + EXB-2×2 + EXB-4×4 + EXB-8×8` = 92 on ABS. `BD BOM!H43` uses '
  '`= IO-EXB` 1:1 = 88. The BoQ ships 88 — **4 connectors under-booked on ABS '
  'alone**, and more wherever wider backplanes are used. Seeded as `G41` with the '
  '`Gesamt` arithmetic.')
w('3. **Patch cable misses variants.** `Gesamt!59` sums only the backplane types in '
  'use, so `PWR-0/1/2/3/6/10/12/14/16` and `EXB-0/3/6` are silently excluded. '
  'Harmless today, wrong the moment a project uses one.')
w('4. **Rules switched off by blank flags.** `Gesamt!AI81`–`AI84` gate FDS, '
  'cubicles, planning and ASM. A blank cell zeroes a whole rule family with no '
  'warning — this is why cubicles read 0 while 22 were typed into the BoQ. The seed '
  'carries these as named conditions so a dormant rule shows as dormant, not absent.')
w('')
w('## Open')
w('')
w('**COM-AdC is now recovered.** It was the last unresolved driver. A COM board is '
  'one CAN segment; `Gesamt!AI88` "Redundancy COM" is set on this project, so each '
  'segment carries one COM per system, which is one per evaluation group. '
  '`Gesamt!BJ3 = COM / AL95` with `AL95 = 2` says the same thing in reverse, and '
  '`AL90 = 1` is the unused non-redundant divisor.')
w('')
w('It holds exactly at 17 of the 21 locations, Yard at 13 of 13. The four ABS '
  'exceptions each omit the redundant COM board, so **the shipped BoQ '
  'under-books four COM-AdC101**. Seeded as `G36`.')
w('')
w('Still open: nothing in the rule set. The remaining gaps are inputs a planner '
  'chooses (group structure, PSC count) rather than rules waiting to be found - and '
  'guideline item 1 states outright that "PSC quantity can be decided as per '
  'technical requirement", which settles that one as a judgement call by policy.')
w('')
w('Settled since the proposal: main and redundant AEBs **do not share a backplane**, '
  'but **may share a rack** on different backplanes with a different COM board. The '
  'packer must partition before decomposition, allocate a COM per set, and leave '
  'bin-packing unconstrained across sets.')
w('')

io.open(os.path.join(OUT, 'rule-map.md'), 'w', encoding='utf-8').write('\n'.join(L))

# --------------------------------------------------------------------------
# summary
# --------------------------------------------------------------------------
print('rules seeded      : %d' % len(seed))
print('  by confidence   : %s' % dict(Counter(s['confidence'] for s in seed)))
print('  no part number  : %d  (%s)'
      % (sum(1 for s in seed if s['partMissing']),
         ', '.join(s['id'] for s in seed if s['partMissing'])))
mapped = {s['prototypeRule'] for s in seed if s['prototypeRule']}
print('prototype rules   : %d parsed, %d mapped, %d unmapped'
      % (len(PROTO), len(mapped), len(PROTO) - len(mapped)))
print('  unmapped        : %s' % ', '.join(sorted(set(PROTO) - mapped)))
for proj in LOCS:
    print('fixture %-5s     : %d locations, DP=%d TS=%d, %d Gesamt lines, %d BoQ lines'
          % (proj, len(LOCS[proj]['locations']), LOCS[proj]['totalDP'],
             LOCS[proj]['totalTS'], len(EXPECTED[proj]['gesamt']),
             len(EXPECTED[proj]['bdBom'])))
