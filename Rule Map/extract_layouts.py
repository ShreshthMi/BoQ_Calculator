#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_layouts.py  -  Frauscher BoQ Calc / Rule Map

Parses the hand-built SLOT GRID on every populated location sheet of the two
tender workbooks and emits the ground-truth rack layout fixture

    Rule Map/fixtures/actual-layouts.json

then reconciles every extracted total against the Gesamt golden values in
    Rule Map/fixtures/expected-abs.json
    Rule Map/fixtures/expected-yard.json

READ ONLY.  The .xlsm files are never opened for writing.

Grid geometry (verified, see verify_geometry()):
  fixed period of 14 rows, block k (1-based) starts at row b = 56 + 14*(k-1)
    b+0  'Pos.'    derived backplane ordinal
    b+1  rack/backplane header   C = 'BGT07' | D..W = 'BP-PWR-n' / 'BP-EXB-n'
    b+2  board token per slot    D..W
    b+3  TE width per slot       D..W   (+ AC.. aggregation band)
    b+4  'ZP'   counting point
    b+5  'FMA1' track section 1
    b+6  'FMA2' track section 2
    b+7  'ID'   (unused)
    b+8  spacer
    b+9  'PSC'  version token R1/R2/NR/NE at the BP-PWR start column
    b+10 'Can IN'
    b+11 'Can OUT'
    b+12 'LB-EXB'
    b+13 spacer
  Slot columns are D..W  (openpyxl 4..23).

Backplane geometry:
  BP-PWR-n : 1 head slot of 8 TE (PSC family) + n slots of 4 TE  => 8 + 4n TE
  BP-EXB-n : 1 head slot of 4 TE (AEB)       + n slots of 6 TE  => 4 + 6n TE
"""

import json
import os
import re
import sys
import warnings
from collections import OrderedDict

warnings.filterwarnings('ignore')

import openpyxl
from openpyxl.utils import get_column_letter as gcl

ROOT = r"D:/Frauscher/BoQ Calc"
BOOKS = OrderedDict([
    ("ABS",  os.path.join(ROOT, "BOM CAL", "ABS V.1_2025-BRC with BD BOM.xlsm")),
    ("Yard", os.path.join(ROOT, "BOM CAL", "Yard V.1_2025-BRC with BD BOM.xlsm")),
])
FIXTURES = os.path.join(ROOT, "Rule Map", "fixtures")
EXPECTED = {"ABS": os.path.join(FIXTURES, "expected-abs.json"),
            "Yard": os.path.join(FIXTURES, "expected-yard.json")}
OUT = os.path.join(FIXTURES, "actual-layouts.json")

BLOCK0 = 56          # first block base row
PERIOD = 14          # rows per rack block
NBLOCK = 8           # blocks scaffolded per sheet
COL_FIRST, COL_LAST = 4, 23        # D..W
COL_RACK = 3                       # C

RACK_TE = {"BGT07": 84, "BGT08": 42}

# TE width per board token - the 11-way lookup of grid row b+3
TE_OF_TOKEN = {
    "PSC": 8, "PSC-R": 8, "spare-PSC": 8,
    "AEB": 4, "COM-AdC": 4, "COM-xxx": 4, "leer": 4, "spare": 4,
    "IO-EXB": 6, "CO-EXB": 6, "spare IO": 6,
}
PWR_HEAD_TOKENS = {"PSC", "PSC-R", "spare-PSC"}
PWR_BODY_TOKENS = {"AEB", "COM-AdC", "COM-xxx", "leer", "spare"}
EXB_HEAD_TOKENS = {"AEB"}
EXB_BODY_TOKENS = {"IO-EXB", "CO-EXB", "spare IO"}

BP_RE = re.compile(r"^BP-(PWR|EXB)-(\d+)$")
TABELLE_RE = re.compile(r"^Tabelle\s+\d+$", re.I)

# Set by --book.  A GENERATED workbook has not been opened in Excel yet, so every
# formula in it still carries the template's cached value: the TE widths, the
# 'Pos.' prefix sums, Gesamt row 4 and the whole aggregation band are stale by
# construction, and `fullCalcOnLoad` is what fixes them on open.  In that mode
# this script checks only what it can read as LITERALS - the drawn grid itself,
# which is the thing under test - and says plainly which checks it skipped.
GENERATED = False

# every orderable backplane variant that has a Gesamt BoM row
BP_VARIANTS = (["BP-PWR-%d" % n for n in (0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16)] +
               ["BP-EXB-%d" % n for n in (0, 1, 2, 3, 4, 6, 8, 10, 12)])
BOARD_TOKENS = list(TE_OF_TOKEN.keys())


def bp_key(name):
    """'BP-PWR-8' -> 'bpPwr8'   'BP-EXB-2' -> 'bpExb2'"""
    m = BP_RE.match(name)
    fam = "Pwr" if m.group(1) == "PWR" else "Exb"
    return "bp%s%s" % (fam, m.group(2))


def bp_slot_count(name):
    """number of slot columns a backplane occupies = 1 head + n body"""
    return int(BP_RE.match(name).group(2)) + 1


def bp_te(name):
    m = BP_RE.match(name)
    n = int(m.group(2))
    return 8 + 4 * n if m.group(1) == "PWR" else 4 + 6 * n


def cv(ws, row, col):
    v = ws.cell(row=row, column=col).value
    if isinstance(v, str):
        v = v.strip()
        if v == "":
            return None
    return v


def as_int(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(str(v).strip())
    except Exception:
        return None


# ---------------------------------------------------------------- parsing ---

def parse_block(ws, sheet, base, anomalies):
    """Parse one 14-row rack block. Returns a rack dict or None if unpopulated."""
    rack_type = cv(ws, base + 1, COL_RACK)
    hdr = {c: cv(ws, base + 1, c) for c in range(COL_FIRST, COL_LAST + 1)}
    boards = {c: cv(ws, base + 2, c) for c in range(COL_FIRST, COL_LAST + 1)}
    tes = {c: as_int(cv(ws, base + 3, c)) for c in range(COL_FIRST, COL_LAST + 1)}
    zps = {c: as_int(cv(ws, base + 4, c)) for c in range(COL_FIRST, COL_LAST + 1)}
    fma1 = {c: as_int(cv(ws, base + 5, c)) for c in range(COL_FIRST, COL_LAST + 1)}
    fma2 = {c: as_int(cv(ws, base + 6, c)) for c in range(COL_FIRST, COL_LAST + 1)}
    pscv = {c: cv(ws, base + 9, c) for c in range(COL_FIRST, COL_LAST + 1)}
    canin = {c: cv(ws, base + 10, c) for c in range(COL_FIRST, COL_LAST + 1)}
    canout = {c: cv(ws, base + 11, c) for c in range(COL_FIRST, COL_LAST + 1)}

    has_hdr = any(v for v in hdr.values())
    has_board = any(v for v in boards.values())

    if not rack_type and not has_hdr and not has_board:
        return None
    if not rack_type:
        anomalies.append("%s block@%d: slot content present but rack cell C%d is empty "
                         "- block is invisible to the rack COUNTIF" % (sheet, base, base + 1))
    if rack_type and rack_type not in RACK_TE:
        anomalies.append("%s C%d: unknown rack type %r" % (sheet, base + 1, rack_type))

    backplanes = []
    c = COL_FIRST
    pos = 0
    while c <= COL_LAST:
        name = hdr[c]
        if not name:
            if boards[c]:
                anomalies.append("%s %s%d: board %r sits in a column with no backplane header"
                                 % (sheet, gcl(c), base + 2, boards[c]))
            c += 1
            continue
        if not BP_RE.match(str(name)):
            anomalies.append("%s %s%d: unparseable backplane token %r"
                             % (sheet, gcl(c), base + 1, name))
            c += 1
            continue
        name = str(name)
        pos += 1
        nslots = bp_slot_count(name)
        fam = BP_RE.match(name).group(1)

        slots = []
        for k in range(nslots):
            cc = c + k
            if cc > COL_LAST:
                anomalies.append("%s %s%d: backplane %s overruns the grid (needs %d slots)"
                                 % (sheet, gcl(c), base + 1, name, nslots))
                break
            if k > 0 and hdr[cc]:
                anomalies.append("%s %s%d: backplane %s (%d slots) overlaps the next header %r"
                                 % (sheet, gcl(c), base + 1, name, nslots, hdr[cc]))
                break
            tok = boards[cc]
            te = tes[cc]
            if tok is None:
                anomalies.append("%s %s%d: slot %d of %s has no board token"
                                 % (sheet, gcl(cc), base + 2, k, name))
            else:
                tok = str(tok)
                if tok not in TE_OF_TOKEN:
                    anomalies.append("%s %s%d: unknown board token %r"
                                     % (sheet, gcl(cc), base + 2, tok))
                elif not GENERATED and te is not None and te != TE_OF_TOKEN[tok]:
                    anomalies.append("%s %s%d: TE %r does not match token %r (expected %d)"
                                     % (sheet, gcl(cc), base + 3, te, tok, TE_OF_TOKEN[tok]))
                # head / body role check
                if k == 0:
                    ok = tok in (PWR_HEAD_TOKENS if fam == "PWR" else EXB_HEAD_TOKENS)
                else:
                    ok = tok in (PWR_BODY_TOKENS if fam == "PWR" else EXB_BODY_TOKENS)
                if not ok:
                    anomalies.append("%s %s%d: token %r is not legal at slot %d of %s"
                                     % (sheet, gcl(cc), base + 2, tok, k, name))
            fma = [x for x in (fma1[cc], fma2[cc]) if x is not None]
            slot = OrderedDict()
            slot["col"] = gcl(cc)
            slot["board"] = tok
            # In generated mode the width cell is a formula Excel has not run
            # yet, so the token's own width is the honest answer.
            if GENERATED:
                slot["te"] = TE_OF_TOKEN.get(tok or "", 0)
            else:
                slot["te"] = te if te is not None else (TE_OF_TOKEN.get(tok or "", 0))
            slot["zp"] = zps[cc]
            slot["fma"] = fma
            slots.append(slot)

        te_sum = sum(s["te"] or 0 for s in slots)
        if te_sum != bp_te(name):
            anomalies.append("%s %s%d: %s slot TE sums to %d, geometry says %d"
                             % (sheet, gcl(c), base + 1, name, te_sum, bp_te(name)))

        bp = OrderedDict()
        bp["pos"] = pos
        bp["type"] = name
        bp["te"] = bp_te(name)
        bp["startCol"] = gcl(c)
        bp["pscVersion"] = str(pscv[c]) if pscv[c] is not None else None
        bp["canIn"] = bool(canin[c])
        bp["canOut"] = bool(canout[c])
        zpv = [s["zp"] for s in slots if s["zp"] is not None]
        bp["zpRange"] = [min(zpv), max(zpv)] if zpv else None
        bp["hasCom"] = any(s["board"] in ("COM-AdC", "COM-xxx") for s in slots)
        bp["hasPsc"] = any(s["board"] in ("PSC", "PSC-R") for s in slots)
        bp["slots"] = slots
        backplanes.append(bp)

        # cross-check the sheet's own derived 'Pos.' ordinal
        declared = None if GENERATED else as_int(cv(ws, base, c))
        if declared is not None and declared != pos:
            anomalies.append("%s %s%d: derived Pos. is %r, positional order says %d"
                             % (sheet, gcl(c), base, declared, pos))
        c += nslots

    if GENERATED:
        te_used = sum(s["te"] or 0 for bp in backplanes for s in bp["slots"])
    else:
        te_used = sum(t for t in tes.values() if t)
    budget = RACK_TE.get(str(rack_type), None)
    rack = OrderedDict()
    rack["type"] = rack_type
    rack["baseRow"] = base
    rack["teUsed"] = te_used
    rack["teFree"] = (budget - te_used) if budget is not None else None
    if budget is not None and te_used > budget:
        anomalies.append("%s block@%d: %d TE used exceeds the %d TE %s budget"
                         % (sheet, base, te_used, budget, rack_type))
    # cross-check against the sheet's own 'Rest of 84 TE' cell AC(base+3)
    rest = None if GENERATED else as_int(cv(ws, base + 3, 29))
    rack["_restCell"] = rest
    if budget == 84 and rest is not None and rest != rack["teFree"]:
        anomalies.append("%s AC%d: sheet says %d TE free, parsed grid says %d"
                         % (sheet, base + 3, rest, rack["teFree"]))
    rack["backplanes"] = backplanes
    return rack


def zero_totals():
    t = OrderedDict()
    t["racks"] = 0
    t["bgt08"] = 0
    for k in ("aeb", "ioExb", "psc", "pscR", "pscTotal", "comAdc", "comXxx",
              "coExb", "leer", "spare", "spareIo", "sparePsc"):
        t[k] = 0
    for v in BP_VARIANTS:
        t[bp_key(v)] = 0
    t["bpTotal"] = 0
    t["connectorBpExb"] = 0
    t["plate4tePsc"] = 0
    t["plate4teAeb"] = 0
    t["plate6teIo"] = 0
    t["teUsed"] = 0
    t["teFree"] = 0
    t["evaluatingSections"] = 0
    t["relayOutputSections"] = 0
    t["trackSections"] = 0
    return t


TOKEN2KEY = {"AEB": "aeb", "IO-EXB": "ioExb", "PSC": "psc", "PSC-R": "pscR",
             "COM-AdC": "comAdc", "COM-xxx": "comXxx", "CO-EXB": "coExb",
             "leer": "leer", "spare": "spare", "spare IO": "spareIo",
             "spare-PSC": "sparePsc"}


def totals_from_racks(racks):
    t = zero_totals()
    for r in racks:
        if r["type"] == "BGT07":
            t["racks"] += 1
        elif r["type"] == "BGT08":
            t["bgt08"] += 1
        t["teUsed"] += r["teUsed"] or 0
        t["teFree"] += r["teFree"] or 0
        for bp in r["backplanes"]:
            k = bp_key(bp["type"])
            if k not in t:
                t[k] = 0
            t[k] += 1
            t["bpTotal"] += 1
            for s in bp["slots"]:
                key = TOKEN2KEY.get(s["board"] or "")
                if key:
                    t[key] += 1
                # track sections: FMA under an IO-EXB is a relay output section,
                # FMA under an AEB is a section evaluated on the board itself
                if s["board"] == "IO-EXB":
                    t["relayOutputSections"] += len(s["fma"])
                elif s["board"] == "AEB":
                    t["evaluatingSections"] += len(s["fma"])
    t["pscTotal"] = t["psc"] + t["pscR"]
    t["connectorBpExb"] = (t.get("bpExb1", 0) * 1 + t.get("bpExb2", 0) * 2 +
                           t.get("bpExb4", 0) * 4 + t.get("bpExb8", 0) * 8)
    t["plate4tePsc"] = t["sparePsc"] * 2
    t["plate4teAeb"] = t["spare"]
    t["plate6teIo"] = t["spareIo"]
    t["trackSections"] = t["relayOutputSections"] + t["evaluatingSections"]
    return t


def zp_systems(racks, sheet, anomalies):
    """Group AEB slots into independent evaluation systems.

    ZP numbering restarts at 1 for each independent evaluation system, so a
    new system begins at every AEB whose ZP is 1 (after the first).  A merely
    *decreasing* ZP is NOT a system boundary - the engineers routinely give
    the head AEB of a BP-EXB a number out of column order (e.g. Yard!08 R3/BP3
    slot R holds ZP 20 after ZP 29), and treating that as a boundary produces
    false 'two systems on one backplane' reports.
    """
    seq = []
    for ri, r in enumerate(racks, 1):
        for bp in r["backplanes"]:
            for s in bp["slots"]:
                if s["board"] == "AEB" and s["zp"] is not None:
                    seq.append((s["zp"], ri, bp["pos"], bp["type"], s["col"],
                                bp.get("hasCom", False)))
    systems = []
    cur = None
    for zp, ri, pos, btype, col, hascom in seq:
        if cur is None or zp == 1:
            cur = OrderedDict([("zpMin", zp), ("zpMax", zp), ("aeb", 0),
                               ("zps", []), ("comBoards", 0), ("backplanes", [])])
            systems.append(cur)
        cur["zpMin"] = min(cur["zpMin"], zp)
        cur["zpMax"] = max(cur["zpMax"], zp)
        cur["aeb"] += 1
        cur["zps"].append(zp)
        tag = "R%d/BP%d %s" % (ri, pos, btype)
        if tag not in cur["backplanes"]:
            cur["backplanes"].append(tag)
            if hascom:
                cur["comBoards"] += 1
    for i, sy in enumerate(systems, 1):
        got = sorted(sy["zps"])
        want = list(range(1, len(got) + 1))
        if got != want:
            anomalies.append("%s: ZP system %d is not a contiguous 1..n run "
                             "(ZPs %s)" % (sheet, i, got))
        del sy["zps"]
    return systems


def parse_workbook(tag, path, anomalies):
    wbv = openpyxl.load_workbook(path, data_only=True, read_only=False)
    g = wbv["Gesamt"]
    project = wbv["01"]["A1"].value
    locations = []
    for i in range(1, 31):
        col = 2 + i                      # C = location 1
        sheet = "%02d" % i
        ws = wbv[sheet]
        sheet_name = cv(ws, 2, 1)
        if GENERATED:
            # Gesamt row 4 is ='NN'!$A2 - a formula, and therefore stale in a
            # workbook Excel has not opened.  A2 itself is the literal a human
            # (or the writer) types, so it is the one to trust here.
            name = sheet_name
            if name is None or TABELLE_RE.match(str(name)):
                continue
        else:
            name = cv(g, 4, col)
            if name is None or TABELLE_RE.match(str(name)):
                continue
            if sheet_name is not None and str(sheet_name) != str(name):
                anomalies.append("%s %s: sheet A2 name %r != Gesamt!%s4 %r"
                                 % (tag, sheet, sheet_name, gcl(col), name))
        racks = []
        for b in range(NBLOCK):
            base = BLOCK0 + PERIOD * b
            rk = parse_block(ws, "%s!%s" % (tag, sheet), base, anomalies)
            if rk is None:
                # a later populated block after an empty one would break the
                # "racks are contiguous" assumption - flag it
                continue
            if racks and rk["baseRow"] != racks[-1]["baseRow"] + PERIOD:
                anomalies.append("%s %s: rack block at row %d follows a gap"
                                 % (tag, sheet, rk["baseRow"]))
            rk["index"] = len(racks) + 1
            racks.append(rk)

        tot = totals_from_racks(racks)
        loc = OrderedDict()
        loc["id"] = "L%02d" % i
        loc["name"] = str(name)
        loc["sheet"] = sheet
        loc["col"] = gcl(col)
        loc["dp"] = as_int(cv(g, 62, col)) or 0
        loc["ts"] = as_int(cv(g, 63, col)) or 0
        # the sheet's own aggregation cells, for cross-checking the parse
        loc["sheetCells"] = OrderedDict([
            ("racksB14", as_int(cv(ws, 14, 2))),
            ("aebAG3", as_int(cv(ws, 3, 33))),
            ("ioExbAK3", as_int(cv(ws, 3, 37))),
            ("pscAF3", as_int(cv(ws, 3, 32))),
            ("pscRAM3", as_int(cv(ws, 3, 39))),
            ("comAdcAH3", as_int(cv(ws, 3, 34))),
            ("comXxxAI3", as_int(cv(ws, 3, 35))),
            ("connectorAL3", as_int(cv(ws, 3, 38))),
            ("evalSectAN3", as_int(cv(ws, 3, 40))),
            ("relaySectAO3", as_int(cv(ws, 3, 41))),
        ])
        ordered_racks = []
        for r in racks:
            o = OrderedDict()
            o["index"] = r["index"]
            o["type"] = r["type"]
            o["baseRow"] = r["baseRow"]
            o["teUsed"] = r["teUsed"]
            o["teFree"] = r["teFree"]
            o["backplanes"] = r["backplanes"]
            ordered_racks.append(o)
        loc["racks"] = ordered_racks
        loc["zpSystems"] = zp_systems(racks, "%s!%s" % (tag, sheet), anomalies)
        loc["totals"] = tot
        locations.append(loc)

    wbv.close()
    return OrderedDict([("project", str(project) if project else None),
                        ("workbookFile", os.path.basename(path)),
                        ("locations", locations)])


# ---------------------------------------------------------- reconciliation ---

# Gesamt row -> key in the computed totals
ROW2KEY = {
    14: "racks", 15: "bgt08",
    16: "bpPwr0", 17: "bpPwr1", 18: "bpPwr2", 19: "bpPwr3", 20: "bpPwr4",
    21: "bpPwr6", 22: "bpPwr8", 23: "bpPwr10", 24: "bpPwr12", 25: "bpPwr14",
    26: "bpPwr16",
    28: "bpExb0", 29: "bpExb1", 30: "bpExb2", 31: "bpExb3", 32: "bpExb4",
    33: "bpExb6", 34: "bpExb8", 42: "bpExb10", 43: "bpExb12",
    35: "pscTotal", 36: "comAdc", 37: "comXxx",
    39: "aeb", 40: "ioExb", 41: "connectorBpExb",
    45: "plate4tePsc", 46: "plate4teAeb", 47: "plate6teIo",
    62: "aeb",            # counting heads == AEB count by construction (=B5=AG3)
    63: "relayOutputSections",
}


def reconcile(tag, extracted, expected):
    exp_rows = {g["row"]: g for g in expected["gesamt"]}
    by_id = {l["id"]: l for l in extracted["locations"]}
    checks = []          # (locId, row, label, key, expected, actual, ok)
    for loc in extracted["locations"]:
        for row, key in sorted(ROW2KEY.items()):
            g = exp_rows.get(row)
            if g is None:
                continue
            e = g["byLocation"].get(loc["id"])
            if e is None:
                continue
            a = loc["totals"].get(key, 0)
            checks.append((loc["id"], row, g["label"], key, int(e), int(a), int(e) == int(a)))
    # workbook-level totals
    tot_checks = []
    for row, key in sorted(ROW2KEY.items()):
        g = exp_rows.get(row)
        if g is None:
            continue
        a = sum(l["totals"].get(key, 0) for l in extracted["locations"])
        tot_checks.append((row, g["label"], key, int(g["total"]), a, int(g["total"]) == a))
    return checks, tot_checks


# BD BOM line -> key in the computed totals
BD2KEY = {
    "BD005": "aeb", "BD008": "aeb", "BD011": "aeb", "BD013": "aeb",
    "BD015": "aeb", "BD017": "aeb", "BD018": "aeb", "BD019": "aeb",
    "BD031": "aeb",                       # all trackside lines are 1 per AEB
    "BD032": "racks",
    "BD034": "bpPwr4", "BD035": "bpPwr8",
    "BD036": "bpExb1", "BD037": "bpExb2", "BD038": "bpExb4",
    "BD039": "pscTotal", "BD040": "comAdc", "BD041": "aeb", "BD042": "ioExb",
    "BD043": "connectorBpExb",
}


def reconcile_bdbom(tag, extracted, expected):
    """Second, independent golden set: the BD BOM sheet."""
    print("")
    print("BD BOM reconciliation (%s)" % tag)
    bad = 0
    for line in expected.get("bdBom", []):
        key = BD2KEY.get(line["key"])
        if key is None:
            print("   ?  %s %-45s no mapping" % (line["key"], line["description"][:45]))
            continue
        perloc = []
        for loc in extracted["locations"]:
            e = line["byLocation"].get(loc["id"])
            a = loc["totals"].get(key, 0)
            if e is not None and int(e) != int(a):
                perloc.append("%s exp %d got %d" % (loc["id"], e, a))
        a_tot = sum(l["totals"].get(key, 0) for l in extracted["locations"])
        ok = (a_tot == line["total"]) and not perloc
        if not ok:
            bad += 1
            print("   MISMATCH %s %-45s total exp %-5d got %-5d  %s"
                  % (line["key"], line["description"][:45], line["total"], a_tot,
                     "; ".join(perloc[:6])))
    if not bad:
        print("   all %d BD BOM lines match" % len(expected.get("bdBom", [])))
    return bad


def print_table(tag, extracted, checks, tot_checks):
    by_loc = OrderedDict()
    for c in checks:
        by_loc.setdefault(c[0], []).append(c)
    print("")
    print("=" * 100)
    print("RECONCILIATION  %s  (%s)" % (tag, extracted["project"]))
    print("=" * 100)
    hdr = ("%-5s %-16s %5s %5s %5s %5s %5s %5s %5s  %-6s %s"
           % ("id", "location", "racks", "AEB", "IO", "PSC", "COM", "BP", "TE?", "result", "failing rows"))
    print(hdr)
    print("-" * 100)
    npass = 0
    for loc in extracted["locations"]:
        cs = by_loc.get(loc["id"], [])
        fails = [c for c in cs if not c[6]]
        t = loc["totals"]
        te_ok = all(r["teFree"] is not None and r["teFree"] >= 0 for r in loc["racks"])
        res = "PASS" if not fails else "FAIL"
        if not fails:
            npass += 1
        detail = ", ".join("r%d %s exp %d got %d" % (f[1], f[3], f[4], f[5]) for f in fails)
        print("%-5s %-16s %5d %5d %5d %5d %5d %5d %5s  %-6s %s"
              % (loc["id"], loc["name"][:16], t["racks"], t["aeb"], t["ioExb"],
                 t["pscTotal"], t["comAdc"], t["bpTotal"], "ok" if te_ok else "OVER",
                 res, detail[:200]))
    print("-" * 100)
    print("locations passing all Gesamt checks: %d / %d" % (npass, len(extracted["locations"])))
    print("")
    print("workbook-level totals:")
    bad = [t for t in tot_checks if not t[5]]
    for row, label, key, e, a, ok in tot_checks:
        if not ok:
            print("   MISMATCH row %-3d %-45s expected %-6d extracted %-6d" % (row, label, e, a))
    if not bad:
        print("   all %d Gesamt total rows match" % len(tot_checks))
    return npass, bad


def print_sheetcell_crosscheck(tag, extracted):
    """Compare the parse against each sheet's OWN derived aggregation cells."""
    pairs = [("racksB14", "racks"), ("aebAG3", "aeb"), ("ioExbAK3", "ioExb"),
             ("pscAF3", "pscTotal"), ("pscRAM3", "pscR"), ("comAdcAH3", "comAdc"),
             ("comXxxAI3", "comXxx"), ("connectorAL3", "connectorBpExb"),
             ("evalSectAN3", "evaluatingSections"),
             ("relaySectAO3", "relayOutputSections")]
    bad = []
    for loc in extracted["locations"]:
        for cell, key in pairs:
            e = loc["sheetCells"][cell]
            a = loc["totals"].get(key, 0)
            if e is None:
                continue
            if int(e) != int(a):
                bad.append((loc["id"], loc["name"], cell, int(e), int(a)))
    print("")
    print("sheet-cell cross-check (%s): %s" % (tag, "clean" if not bad else "%d mismatches" % len(bad)))
    for b in bad:
        print("   %s %-16s %-14s sheet=%-4d parsed=%-4d" % b)
    return bad


def verify_geometry(anomalies):
    print("")
    print("geometry anomalies: %s" % ("none" if not anomalies else len(anomalies)))
    for a in anomalies:
        print("   ! %s" % a)


def audit_pos_formulas(tag, path):
    """The b+0 'Pos.' row is a hand-copied prefix sum over the BT..CM helper
    band.  Verify every one of the 30x8x20 formulas against the canonical
    pattern and report deviations.  (The row is read by nothing, so a
    deviation is cosmetic - but it is a real defect.)"""
    wb = openpyxl.load_workbook(path, data_only=False)
    wbv = openpyxl.load_workbook(path, data_only=True)
    helper = [gcl(c) for c in range(72, 92)]     # BT..CM, 1:1 with D..W
    bad = []
    for i in range(1, 31):
        s = "%02d" % i
        ws, wsv = wb[s], wbv[s]
        for b in range(NBLOCK):
            base = BLOCK0 + PERIOD * b
            for idx, c in enumerate(range(COL_FIRST, COL_LAST + 1)):
                f = ws.cell(row=base, column=c).value
                if not isinstance(f, str) or not f.startswith("="):
                    continue
                want = '=IF(%s%d<>"",%s,0)' % (
                    gcl(c), base + 1, "+".join(h + str(base) for h in helper[:idx + 1]))
                if f.replace(" ", "") != want.replace(" ", ""):
                    terms = re.findall(r"\b([A-Z]{2})%d\b" % base, f)
                    visible = wsv.cell(row=base, column=c).value
                    bad.append((s, "%s%d" % (gcl(c), base), terms[0] if terms else "?",
                                terms[-1] if terms else "?", len(terms), idx + 1, visible))
    wb.close(); wbv.close()
    print("")
    print("Pos-row (b+0) prefix-sum audit (%s): %s"
          % (tag, "all 4800 formulas canonical" if not bad else "%d DEVIATIONS" % len(bad)))
    for s, ref, t0, t1, n, want_n, vis in bad:
        print("   ! %s!%s sums %s..%s (%d terms), canonical is BT..%s (%d terms); "
              "cell renders %r" % (tag, s + "!" + ref, t0, t1, n,
                                   gcl(72 + want_n - 1), want_n, vis))
    return bad


def audit_redundancy(tag, extracted):
    """The authoritative constraint: main and redundant AEBs must NOT share a
    backplane; they MAY share a rack if on a different backplane with a
    different COM board.  ZP numbering restarts per independent evaluation
    system, so 'system' == a maximal non-decreasing ZP run."""
    print("")
    print("redundancy-constraint audit (%s)" % tag)
    print("  %-5s %-16s %-4s %s" % ("id", "location", "sys", "system -> ZP range / AEB / backplanes"))
    violations = []
    shared_racks = 0
    for loc in extracted["locations"]:
        syss = loc["zpSystems"]
        # map backplane tag -> set of system indexes
        owner = {}
        for si, sy in enumerate(syss, 1):
            for tagbp in sy["backplanes"]:
                owner.setdefault(tagbp, set()).add(si)
        for tagbp, ss in owner.items():
            if len(ss) > 1:
                violations.append((loc["id"], loc["name"], tagbp, sorted(ss)))
        rack_owner = {}
        for si, sy in enumerate(syss, 1):
            for tagbp in sy["backplanes"]:
                rack_owner.setdefault(tagbp.split("/")[0], set()).add(si)
        shared_racks += sum(1 for v in rack_owner.values() if len(v) > 1)
        print("  %-5s %-16s %-4d %s" % (
            loc["id"], loc["name"][:16], len(syss),
            " | ".join("S%d ZP%d-%d n=%d [%s]" % (i, s["zpMin"], s["zpMax"], s["aeb"],
                                                  ", ".join(s["backplanes"]))
                       for i, s in enumerate(syss, 1))[:150]))
    print("  backplanes carrying AEBs of >1 evaluation system: %d %s"
          % (len(violations), "(constraint holds)" if not violations else "(VIOLATION)"))
    for v in violations:
        print("     ! %s %s  backplane %s carries systems %s" % v)
    print("  racks hosting >1 evaluation system (allowed by the rule): %d" % shared_racks)

    # the rule's second half: a shared rack needs "a different COM board".
    # Find every powered backplane (equipped PSC) that carries no COM board,
    # and every evaluation system with no COM board at all.
    no_com_bp = []
    no_com_sys = []
    for loc in extracted["locations"]:
        for r in loc["racks"]:
            for bp in r["backplanes"]:
                if bp.get("hasPsc") and not bp.get("hasCom"):
                    no_com_bp.append((loc["id"], loc["name"], r["index"], bp["pos"],
                                      bp["type"], bp["startCol"], r["baseRow"]))
        for si, sy in enumerate(loc["zpSystems"], 1):
            if sy["comBoards"] == 0:
                no_com_sys.append((loc["id"], loc["name"], si, sy["aeb"]))
    print("  powered backplanes (PSC equipped) carrying NO COM board: %d" % len(no_com_bp))
    for a in no_com_bp:
        print("     ! %s %-16s rack %d BP%d %s at %s%d - PSC but no COM-AdC"
              % (a[0], a[1], a[2], a[3], a[4], a[5], a[6] + 2))
    print("  evaluation systems with NO COM board at all: %d" % len(no_com_sys))
    for a in no_com_sys:
        print("     ! %s %-16s system S%d (%d AEB) has no COM board" % a)
    return violations


def inspect_generated(paths):
    """Re-read a GENERATED calculator and check the grid we drew into it.

    This is the round trip: the writer puts literals on the page, and this reads
    them back with a different language, a different library and a parser that
    predates the writer by several commits.  What it can check is everything the
    grid asserts about itself - the token vocabulary, the head/body role of every
    slot, backplane widths against their own geometry, counting points running
    1..n without a gap in each evaluation group, and the main/redundant
    separation constraint.

    What it deliberately does NOT check is anything downstream of a formula.  A
    generated workbook carries the template's cached values until Excel opens it
    and `fullCalcOnLoad` fires, so Gesamt, BD BOM and the sheet's own row 3 are
    stale by construction and reconciling against them would be theatre.
    """
    global GENERATED
    GENERATED = True
    print("GENERATED-WORKBOOK MODE")
    print("  checking: the drawn grid, read back as literals.")
    print("  skipping: Gesamt, BD BOM, row 3 and the TE band - all cached formula")
    print("            values, stale until Excel recalculates on open.")
    bad = 0
    for path in paths:
        tag = os.path.basename(path)
        anom = []
        data = parse_workbook(tag, path, anom)
        print("")
        print("=" * 100)
        print("%s  -  project %r" % (tag, data["project"]))
        print("=" * 100)
        print("%-5s %-18s %-6s %-6s %-5s %-5s %-5s %-5s %s"
              % ("id", "location", "racks", "BP", "AEB", "IO", "PSC", "COM", "TE"))
        print("-" * 100)
        for loc in data["locations"]:
            t = loc["totals"]
            print("%-5s %-18s %-6d %-6d %-5d %-5d %-5d %-5d %d"
                  % (loc["id"], loc["name"][:18], t["racks"], t["bpTotal"], t["aeb"],
                     t["ioExb"], t["pscTotal"], t["comAdc"], t["teUsed"]))
        print("-" * 100)
        tot = lambda k: sum(l["totals"].get(k, 0) for l in data["locations"])
        print("%-24s %-6d %-6d %-5d %-5d %-5d %-5d %d"
              % ("TOTAL", tot("racks"), tot("bpTotal"), tot("aeb"), tot("ioExb"),
                 tot("pscTotal"), tot("comAdc"), tot("teUsed")))
        print("track sections (FMA): %d" % tot("trackSections"))
        audit_redundancy(tag, data)
        verify_geometry(anom)
        bad += len(anom)
    print("")
    print("OVERALL: %s" % ("the drawn grid reads back clean" if bad == 0
                           else "%d geometry anomalies" % bad))
    return 1 if bad else 0


def main():
    argv = sys.argv[1:]
    if "--book" in argv:
        paths = [a for a in argv[argv.index("--book") + 1:] if not a.startswith("-")]
        if not paths:
            print("usage: extract_layouts.py --book <generated.xlsm> [more.xlsm ...]")
            return 2
        missing = [p for p in paths if not os.path.exists(p)]
        if missing:
            print("not found: %s" % ", ".join(missing))
            return 2
        return inspect_generated(paths)

    all_anom = []
    out = OrderedDict()
    per_book = {}
    for tag, path in BOOKS.items():
        anom = []
        data = parse_workbook(tag, path, anom)
        per_book[tag] = (data, anom)
        all_anom.extend("%s: %s" % (tag, a) for a in anom)
        out[tag] = data

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    print("wrote %s" % OUT)
    print("locations extracted: %s" % ", ".join(
        "%s=%d" % (t, len(out[t]["locations"])) for t in out))
    print("racks extracted:     %s" % ", ".join(
        "%s=%d" % (t, sum(len(l["racks"]) for l in out[t]["locations"])) for t in out))

    fails = 0
    posbad = []
    viol = []
    for tag in BOOKS:
        data, anom = per_book[tag]
        expected = json.load(open(EXPECTED[tag], encoding="utf-8"))
        checks, tot_checks = reconcile(tag, data, expected)
        npass, bad = print_table(tag, data, checks, tot_checks)
        sc = print_sheetcell_crosscheck(tag, data)
        bd = reconcile_bdbom(tag, data, expected)
        fails += (len(data["locations"]) - npass) + len(bad) + len(sc) + bd
        posbad += audit_pos_formulas(tag, BOOKS[tag])
        viol += audit_redundancy(tag, data)

    verify_geometry(all_anom)
    print("")
    print("OVERALL: %s" % ("all checks pass" if fails == 0 and not all_anom
                           else "%d reconciliation failures, %d geometry anomalies"
                                % (fails, len(all_anom))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
