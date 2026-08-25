# Handover — generate the BD/BRC calculator workbooks

Paste this whole file as the opening message of the next session.

---

## The task

The tool now reads the Bid Process Sheet **and writes it back**. What it cannot
yet produce is the pair of calculators the bid team actually works in:

```
BOM CAL/ABS V.1_2025-BRC with BD BOM.xlsm
BOM CAL/Yard V.1_2025-BRC with BD BOM.xlsm
```

**Generate one of these for a project**, filled from the packer's own output, so
a bid engineer gets a live workbook they can open, edit and hand on — not a dump.

The scoping is done and the answer is encouraging: **the two workbooks are the
same file.** Every cell of `Gesamt`, `BD BOM`, `Vorlagen`, `Info` and sheets
14–30 is identical between them. Only the project name and the drawn slot grids
differ. They are already a template with data typed into it.

A location sheet is roughly **93 % template**. What a human types is about 150
cells, in a strict 14-row rhythm, in 22 columns — and the packer already
produces exactly that structure.

---

## Where things are

Repo: **https://github.com/ShreshthMi/BoQ_Calculator** (private, `main`).

```
app/              React + TS browser app, and BOTH workbook writers
app/src/xlsx-patch.ts        zip-level cell surgery — THE MECHANISM TO REUSE
app/src/export-bid-sheet.ts  what goes in which cell, for the handover sheet
Bid Sheet/        the questionnaire map, generated, plus the reasoning
demo/src/         the pipeline — project, import, engine, boq, cable, expr
demo/src/node-io.ts          THE ONLY MODULE THAT TOUCHES THE FILESYSTEM
packer/src/       decomposition, packing, cubicles. Zero dependencies
packer/fixtures/reference.json   THE GROUND TRUTH, extracted from these workbooks
Rule Map/         57 rules (rules.seed.json), the mapping doc, fixtures
Part Catalogue/   141-part master (parts.json)
BOM CAL/          source workbooks — inputs, never modified
```

Read [`README.md`](README.md), then [`Bid Sheet/README.md`](Bid%20Sheet/README.md),
[`demo/README.md`](demo/README.md) and [`packer/README.md`](packer/README.md).
They carry the reasoning, not just the API.

### Run and verify

```bash
cd packer && npm test                    # 90 tests, no install needed
cd demo && npm install && npm test       # 74 tests
cd demo && npm run typecheck
cd demo && npm run demo                  # 11 match · 10 differ · 4 blank · 16 not produced
cd app && npm install && npm run dev     # http://localhost:5173
cd app && npm run verify-bid-sheet       # generate a Bid Process Sheet, check it 3 ways
cd app && npm run typecheck && npm run build
```

Node 24+ is required — TypeScript runs through type stripping, no build step.
Python 3.9+ with `openpyxl` for the extraction scripts.

---

## What shipped last session

**`5828532` — a second way in.** `demo/src/project.ts` owns the project shape,
every derivation and both sets of checks, with no dependencies. `import.ts` is
now only a workbook reader that hands it a `ProjectInput`; `buildProject` takes
the same shape from anyone who typed it. `demo/fixtures/nwr-jaipur-manual.json`
is the reference project as plain typed data, and the test asserts it builds
into the imported project field for field.

Three fields the input sheet cannot express are now declarable, and two of them
close differences outright:

| Declared | Effect |
|---|---|
| Equipment rooms at Devpura and Snaganer | 66 → **68** racks, the shipped figure |
| Measured cable runs | 369/144/37 → **350/163/37**, the shipped figures |
| Application type | makes the IBH and absolute-block guideline rows reachable |

Both together take the diff from **11 matches to 14**.

**`44a4ccb` — the whole Bid Process Sheet.** Clicking *Bid Process Sheet* writes
a workbook in the template's format with this project in it. The generated file
re-imports into the tool as the same project with zero warnings.

---

## The mechanism, and why it is not negotiable

An `.xlsx` is a zip of XML parts. The handover workbook has 128; the calculators
have 152. Measured against the real files rather than assumed:

| Approach | Result |
|---|---|
| Load with ExcelJS, write it straight back | **98 of 128 parts destroyed** |
| Load the zip, patch what you own, rewrite | **128 of 128 kept** |
| The same, on the `.xlsm` | **152 of 152 kept, `vbaProject.bin` included** |

What ExcelJS drops is not incidental — every checkbox `ctrlProps`, both VML
drawings, the external links, every printer setting, the custom XML. Its own
object model reports that round trip as clean, because it cannot see what it
does not model. The sheet count, the images and the data validations all
survive, so a surface check passes while the document stops being the document.

**I got this wrong first**, on exactly that evidence, and only caught it by
listing the zip entries. Do not re-litigate it; `app/scripts/verify-bid-sheet.ts`
asserts zip parity on every run for this reason.

`app/src/xlsx-patch.ts` is the reusable half: `Workbook.open/read/edit/toBytes`,
`patchSheet` (keeps the style index, keeps the formula, replaces only the
value), `restyle`, `setChecked`, `forceFullCalc`. Strings are written as
**inline strings**, so `sharedStrings.xml` and every index into it are left
alone. It edits cells that already exist and does not create rows.

---

## The calculators — verified facts

41 sheets, ~55,000 formulas, 2.7 MB. `xl/styles.xml` alone is 4.5 MB (22,716
`dxf` records driving 438–514 conditional-format rules per location sheet). None
of that is rebuildable and none of it needs to be — it is inherited.

**Sheet inventory.** `Revision` (the project name is `B21`), `01`–`13` per
location (`09`–`13` hidden on ABS), `14`–`30` pristine unused copies, `Gesamt`,
`Vorlagen` (the backplane strip palette a planner copies from), `BD BOM`,
`Info` (a bilingual string table every label resolves through), `Info1/2/3`,
`Preisliste` (zeroed), `Rev`, `BGT Aufkleber` (broken, `#REF!` in both files).

**The location name is `A2`.** Not row 4 — row 4 is empty. `Gesamt!C4 = '01'!$A2`
and `'01'!A1 = Revision!B21`.

**The sentinel is load-bearing.** Each column guards on its own:

```
Gesamt!AF5 = IF($AF$4="Tabelle 30", 0, '30'!$B5)
```

A pristine sheet reports **0 AEB but 8 PSC and 4 racks for itself**. So to
disable a location you restore `A2` to exactly `Tabelle NN`. Never clear the
grid and leave a real name — `Gesamt` will silently absorb phantom hardware.

**The slot grid.** 8 blocks at base rows 56, 70, 84, 98, 112, 126, 140, 154 —
period 14 — in columns C…X. Per block:

| Row | Holds | Written by |
|---|---|---|
| base+1 | `C` = rack type (`BGT07`); backplane code at each backplane's start column | the generator |
| base+2 | the board token row — write **literals**, the COUNTIFs read text | the generator |
| base+3 | TE width per slot (formula) | inherited |
| base+4 | `ZP` counting-point numbers | the generator |
| base+5 / +6 | `FMA1` / `FMA2` track-section numbers | the generator |
| base+9 | `PSC` = `R1` / `R2` / `NE` | the generator |
| base+10 / +11 | `Can IN` / `Can OUT` markers | the generator |

Tokens are `PSC`, `PSC-R`, `spare-PSC`, `COM-AdC`, `COM-xxx`, `AEB`, `IO-EXB`,
`CO-EXB`, `spare`, `leer`, `spare IO`. The template seeds row base+2 with three
formula flavours and the planner types over them where the derivation cannot
work — writing literals sidesteps that entirely.

**Sheet totals in row 3**, fed by per-block `COUNTIF`s at base+3:
`AF` PSC, `AG` AEB, `AH` COM-AdC, `AI` COM-xxx, `AK` IO-EXB, `AP`…`BI`
backplane variants, `BJ` CAN segments, `BK` FDS, `BL` cubicle. Verified against
Chaksu: `AG3 = 31`, `AH3 = 2`, `AK3 = 13`, `B14 = 4` — exactly what
`packer/fixtures/reference.json` records.

**`Gesamt` declarations**, typed `"x"` beside a label in column `AJ`:
`AI79` RSR180, `AI81` FDS, `AI82` cubicles (blank on this tender — which is why
22 were typed by hand), `AI83` planning, `AI84` ASM, `AI88` redundancy COM,
`AL95 = IF(AI88="x",2,1)`.

**`BD BOM`** carries the 141-part catalogue but only **16 of 143 rows are wired**
to `Gesamt`. Row 43 is `=H42` — the known connector defect that copies the
IO-EXB row instead of the slot-weighted count.

**VBA is cosmetic.** 38 modules, 37 empty stubs; only `Tabelle32` (= `Gesamt`)
has code — 188 lines of `Worksheet_SelectionChange` that hides a column when its
row-4 cell reads `"Tabelle N"`. Preserve it and it keeps working.

**One external link**, a SharePoint URL feeding `BD BOM!B1` only, cached `1.5`.
Worth replacing with the literal so Excel stops prompting.

---

## What the repo already has that feeds this

`packer/fixtures/reference.json` is the ground truth, extracted from these very
workbooks by `packer/scripts/extract_reference.py` — 21 locations with their
groups, the actual drawn layout, the `Gesamt` reconciliation and per-rack TE. It
reconciles grid against `Gesamt` with **zero mismatches**, and that same
reconciliation loop is exactly the right test to run against generated output.

The packer's `PackResult` already carries `racks[].backplanes[].contents` — the
board tokens in slot order — which is what row base+2 needs. `planLocation` in
`demo/src/engine.ts` produces it, per equipment room where rooms are declared.

**Not captured anywhere yet:** the `Info` string table, the `Gesamt` declaration
block as a schema, `Vorlagen`, and the row-58 formula-flavour choice
(`extract_reference.py` reads cached values, so it never sees it).

---

## Decisions already taken — do not re-open

- **Bid Process Sheet first, then BRC.** Done; this is the BRC.
- **The ~125 dead `BD BOM` rows get filled from the recovered rules AND
  flagged**, so the generated file's disagreement with the real calculator is
  visible in the file rather than discovered later.
- Under a measured cable plan, `K01`–`K03` keep deriving rather than going
  dormant. Reasoning in `demo/README.md`.

---

## Domain facts already recovered — do not re-derive these

Verified against the workbooks.

**Backplane geometry**
```
BP-PWR-n : one 8 TE PSC slot + n slots of 4 TE (AEB *or* COM)  => 8 + 4n TE
BP-EXB-n : one 4 TE slot holding an AEB + n slots of 6 TE (IO) => 4 + 6n TE
```
Every BP-EXB carries an AEB. TE pitch: PSC 8, AEB/COM 4, IO-EXB 6. BGT07 = 84 TE.

**Evaluation groups** are the unit of separation — own ZP numbering restarting
at 1, own backplanes outright. Zero backplanes mix groups across all 21
reference locations; racks freely share them. The grid does not record which
group is main and which redundant.

**An equipment room is a `Gesamt` column, and a CAN-segment boundary.** Three
Yard stations split their down and up lines across two rooms, which is why 18
input rows become 21 location sheets. Declaring one moves every location-scoped
rule — cubicles, testing plates, service displays, planning and FDS — not just
the rack line. A station small enough to fold its directions into one group
gains a second group when split, and with it a second COM and PSC.

**COM = one per evaluation group.** A COM board is one CAN segment;
`Gesamt!AI88` is set, so each segment carries one per system. Exact at 17 of 21
locations; the four exceptions omit the redundant board, so the shipped BoQ
under-books 4.

**PSC is not derivable.** Guideline item 1 says outright it is "decided as per
technical requirement". One per group on ABS, more on Yard. It is an input.

**IO-EXB = ceil(TS / 2) per GROUP**, not per location. Per group gives 244 and
matches the workbook everywhere; per location gives 237.

**Single detection caps at BP-EXB-2.** Dual allows BP-EXB-4.

**Cable-length split** — questionnaire `B151` item 16:

| Application | 5 m | 10 m | 15 m |
|---|---|---|---|
| Station — single, or main half of dual | 75 % | 15 % | 10 % |
| Station — redundant half of dual | — | 75 % | 25 % |
| Auto block | 50 % | 50 % | — |
| IBH / absolute block — single | 100 % | — | — |
| IBH / absolute block — dual | 50 % | 50 % | — |

**FDS divisor is 110**, per the Bid team. The workbook reads `/150` in all 60
location sheets — a latent defect this tender never exposes.

**Rule scope**: location-scoped by default and summed per column, because
`Gesamt` computes per column then totals. `ceil(550/25)` is 22; the sum of
`ceil(dp/25)` over 18 columns is 32. Project-scoped rules are evaluated **after**
the columns are summed, so a `part()` reference sees what the columns booked.

**The questionnaire answers are evidence.** The reference project answers
*Decentralised* — the equipment rooms — then defers the detail to "Refer Sheet
No 17", which is not in the workbook. It answers *Separate Evaluator: Yes*,
which is why the packer splits down from up. And *Spare Requirement: NO*, which
with the Spare column being 40 external-link formulas cached at zero is why the
submitted BoQ books no spares on any of its 41 lines.

Cell `B151` holds **24 numbered guidelines**; seven have been mined. Items 17,
18 and 19 still read like rules.

---

## Principles that must not be broken

1. **Blank is never zero.** A rule that cannot resolve produces a flagged blank.
   A zero in a BoQ reads as a real answer of "none required".
2. **Provenance on every line** — `derived` / `override` / `stale` / `manual` /
   `blank` / `dormant`.
3. **`driverSnapshot` is never recomputed.** It records the derived value at the
   moment an override was entered, which is the only reason staleness is
   detectable. `BoqLine.derived` excludes spare.
4. **Overrides feed forward.** `part(BD005)` resolves against the override layer.
5. **Do not invent rules to close a gap.** Where the tool and the tender
   disagree, surface both. Several differences are the tender being wrong.
6. **Do not tune the packer to match.** Report differences; the human layout is
   not necessarily optimal.
7. **`packer/` stays dependency-free**, and nothing outside `demo/src/node-io.ts`
   may import `node:fs`.
8. **No `eval`.** `demo/src/expr.ts` is a hand-written parser.
9. **Never modify the workbooks in `BOM CAL/`.** They are read as templates and
   handed back patched; no copy is committed.
10. **Patch the zip, never rebuild the workbook.** Settled by measurement above.

---

## Still open

Against the submitted BoQ, with equipment rooms and the cable plan declared:
**14 match · 7 differ · 4 blank · 16 not produced**, no warnings, nothing
overridden.

| Line | Shipped | Ours | |
|---|---|---|---|
| BP-EXB-1 · -2 | 27 · 92 | 26 · 91 | the packer decomposes tighter than the planner at three room sheets |
| Backplane connector | 244 | 248 | BD BOM formula defect; `Gesamt` says 251 |
| Supply board PSC | 61 | 46 | planner decision, not derivable |
| COM-AdC | 42 | 46 | four redundant boards the tender omits |
| FDS102 | 12 | 20 | one per column; rooms move it further away |
| Cubicle | 22 | 20 | `ceil(racks/6)` per column vs the capacity table |

**Limits of the Bid Process Sheet export**, reported in the app rather than
hidden: the DP/TS blocks hold ten rows each and rows cannot be inserted without
moving the totals row; ten generated lines have no row in the template's BoQ
table; 17 questionnaire questions ship blank unless answered on the screen.

**Two findings worth their own work.** `B151` items 9, 10 and 11 are rules for
the reset box, the reset cubicle and the co-operation panel — three of the four
lines the BoQ still reports blank. And the hidden `10. BoQ` carries five service
lines with part codes that exist nowhere in the shipped BoQ: design of axle
counter circuits per DP, FAdC assembly per board, cubicle prewiring, FDS
planning, ITC supervision.

---

## Suggested approach

1. Read `app/src/xlsx-patch.ts` and `app/src/export-bid-sheet.ts` first. The
   second is the worked example of the first, and the BRC writer is the same
   shape against a bigger workbook.
2. Prove the mechanism on the `.xlsm` before building anything: open it, patch
   `Revision!B21` and one location's `A2`, rewrite, and assert all 152 parts
   survive with `vbaProject.bin` intact. That check already passes; make it a
   script so it keeps passing.
3. Write one location sheet from a `LocationPlan` — rack type, backplane codes,
   board tokens, ZP and FMA numbering — and reconcile its row-3 totals against
   `packer/fixtures/reference.json` for the same location. Chaksu is the
   easiest: 31 AEB, 2 COM, 13 IO, 4 racks.
4. Then the rest: `Revision!B21`, `A2` per location, `Tabelle NN` restored on
   every unused sheet, the `Gesamt` declarations from `Declarations`, and
   `fullCalcOnLoad` so Excel recomputes the 55,000 formulas on open.
5. Fill the 16 wired `BD BOM` rows, then the ~125 dead ones from the recovered
   rules **with a flag on each**, as agreed.
6. Test with the reconciliation loop `extract_reference.py` already uses — grid
   against `Gesamt`, currently zero mismatches across 21 locations. Run it
   against generated output and it should stay zero.
7. Assert the sentinel invariant explicitly: no sheet may carry a real name in
   `A2` without a drawn grid, or `Gesamt` absorbs 8 PSC and 4 racks of phantom
   hardware per location.
