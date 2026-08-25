# The BD/BRC calculators, generated

The bid team's working artefact is not the Bill of Quantities — it is the
calculator the BoQ falls out of. This generates one, filled from the packer's
own output, as a **live workbook** a bid engineer opens, edits and hands on.

```bash
cd app
npm run verify-brc                                  # generate both, check them five ways
python "../Rule Map/extract_layouts.py" --book BRC-ABS.xlsm BRC-YARD.xlsm
```

| | |
|---|---|
| `../packer/src/grid.ts` | The drawn grid — where each board sits and what is written under it |
| `../app/src/export-brc.ts` | What goes in which cell |
| `../app/src/xlsx-patch.ts` | Cell surgery at the zip level, shared with the Bid Process Sheet writer |
| `../app/scripts/verify-brc.ts` | Generate outside the browser and check the result |
| `../Rule Map/extract_layouts.py` | `--book` re-reads a generated file in a different language |

## One project makes two workbooks

The two shipped calculators are the two halves of one tender: the ABS book is
`Jaipur-Sheodaspura`, 8 locations and 176 detection points; the Yard book is
`Jaipur to Sawai`, 13 and 374. Together, 550. So one project produces one
workbook per scope, and the *BRC calculators* button writes both.

**One template serves both.** Compared cell by cell across `Gesamt`, `BD BOM`,
`Vorlagen`, `Info`, `Info1/2/3`, `Preisliste`, `Rev`, `BGT Aufkleber` and all 17
pristine location sheets: **zero formula differences, zero literal differences,
zero semantic formatting differences.** Identical VBA, printer settings,
drawings, media, comments and external link. The ABS file is the one bundled —
it carries more pristine location sheets, and it stores its revision date as a
date where the Yard file stores the string `28/01/2025'`, stray apostrophe
included.

Two things are genuinely not the same file and neither may be carried across:
`xl/styles.xml` permutes 111 of its 591 style indices, and `sharedStrings.xml`
shifts every index at or above 19 by five. The patcher writes **inline strings**
and never invents a style, so neither can bite.

## The sheet does almost all of it

A location sheet is about 93 % template. Row 3 is fed by per-block `COUNTIF`s
over two rows of the grid; `Gesamt` reads row 3; `BD BOM` reads `Gesamt`. So
writing the grid makes the whole 55,000-formula chain say the right thing, and
the writer's job is to touch those rows and nothing else.

| Written | Derived by the template |
|---|---|
| `A2` location name | `A1` project name, `Gesamt` row 4, every label via `Info` |
| `base+1` rack type and backplane codes | `base+0` the `Pos.` prefix sums |
| `base+2` board tokens | `base+3` TE width, and the `AC…BI` counting band |
| `base+4` counting points, `+5`/`+6` track sections | `base+12` the LB-EXB marker |
| `base+9` `R1`/`NE`, `+10`/`+11` the CAN markers | row 3, the `B` column, everything downstream |

### Geometry, as the workbook actually has it

Slot columns are **`D`…`U` — eighteen of them**. Column `C` holds the rack type
alone. Only the **first four** of the eight 14-row blocks are alive; blocks 5–8
were emptied deliberately, and `Rev!C5` says why:

> *"From 5 BGT to 8 BGT content deleted hence maximum 4 BGT only can be mounted
> in India environmental condition. If require to use those BGT's, Content shall
> be copied from above BGT and pasted."*

So four racks per sheet is an engineering decision, not damage. A fifth is
reported by name, with the remedy: declaring an equipment room splits the
location across two sheets, which is exactly what the tender did at Devpura,
Snaganer and Durgapur — and why 18 rows of input sheet become 21 location
sheets.

### The board tokens are written as literals, because they have to be

The template seeds the token row with formulas keyed on the input rows:

```
=IF(D65="R2","PSC-R",IF(D65="NE","spare-PSC","PSC"))   the power slot, from the PSC row
=IF(E60>0,"AEB",IF(Info!$A$30<>"","leer","spare"))      a 4 TE slot, from the ZP row
```

There is **no third flavour in a pristine sheet.** The `IO-EXB` formula exists
only where a human authored one. So the template can produce five of the eleven
tokens and cannot produce `IO-EXB`, `COM-AdC`, `spare IO`, `CO-EXB` or `COM-xxx`
at all. Across both shipped workbooks `COM-AdC` is a typed literal 42 times out
of 42, and 129 of 550 `AEB` are too. Writing literals is not a shortcut; it is
what the sheet requires.

### Three things the packer did not model, all settled from the data

Measured across all 21 reference locations in `Rule Map/fixtures/actual-layouts.json`:

1. **`R1` / `NE`** follows the power slot exactly — `R1` where it holds a `PSC`,
   `NE` where it holds a `spare-PSC`. 61 and 14, zero exceptions. The template's
   own formula reads it back the other way, which is the check.
2. **Track-section numbers sit under I/O boards alone**, two apiece, one on the
   last where the count is odd. 223 slots carry two, 21 carry one, and no other
   token carries any. That is what makes the sheet's own relay-output total come
   out equal to TS.
3. **`Can IN` / `Can OUT` are documentation.** No formula anywhere reads them,
   and the pair is a pure function of the backplane *variant* with nothing to do
   with position — the signature of a marker copied in with a `Vorlagen` palette
   strip. A first-and-last daisy chain was tested and refuted: 0 of 46 groups
   match it. The palette's own marking is reproduced and nothing is derived
   from it.

## `xl/calcChain.xml` is deleted, on purpose

Unlike the Bid Process Sheet writer, this one replaces formulas with literals.
That leaves the calc chain — Excel's index of where the formulas are — naming
cells that no longer hold any, and **Excel reports the whole workbook as needing
repair**, which reads to a bid engineer as *the numbers are corrupt* when only
the bookkeeping is. The part goes, along with its relationship and its
content-type override, and `fullCalcOnLoad` makes Excel rebuild it silently on
open. It is a performance cache and holds no data.

That is the one deliberate difference from the template: **151 parts out of
152**, and the verifier names it rather than tolerating a count that drifts.

Two rows begin with a **shared formula master** — `D59` speaks for `D59:U59` —
and overwriting a master orphans its dependents into the same repair prompt.
`patchSheet` now refuses such a write unless the whole range is being rewritten
in the same call, so the rule is enforced rather than remembered.

## `BD BOM`: the fill is eight rows, not a hundred and twenty-five

`BD BOM` carries 30 per-location columns pulling from `Gesamt` and totalling in
`BG`. The wired rows need nothing written. Of the 118 dead part rows, **8 are
computable, 4 are genuinely manual, and 106 have no rule anywhere.**

Five of the eight are pure wiring — `Gesamt` computes them correctly and the
sheet simply never reads it:

| Row | Part | Reads | Shipped file |
|---|---|---|---|
| 24 | Advanced service display ASD101 | `Gesamt` row 12 | nothing |
| 30 | Testing plate PB200-TS | row 10 | nothing |
| **43** | **Backplane connector BP-EXB** | **row 41** | **`=H42`, the I/O board row** |
| 44 | FDS102 | row 53 | nothing |
| 85 | Board rack BGT08 | row 15 | nothing |
| 87 | Axle counter cubicle FAR-002 | row 55 | nothing |

Row 43 is a defect with a measurable cost: `Gesamt` says 159 connectors for Yard
and 92 for ABS, and the shipped file books 156 and 88. Correcting it is a wiring
fix, not a new rule, and the generated file says so on the row.

`K01`/`K02`/`K03` — the three cable-length kits — have no `Gesamt` row to read,
because the workbook has no length dimension at all; they are written as
per-column literals from the questionnaire's own guideline. `M01`–`M04` stay
blank. **Blank is never zero.**

## Every row says where its number came from

Two dead columns become the record. `Loc 31`…`Loc 51` can never be filled —
`Gesamt` has thirty location columns — and they sit inside `BG = SUM(H:BF)`,
which ignores text. So `AL` carries the provenance and `AM` carries the reason,
on **all 141 part rows**, not only the awkward ones: a reader has to be able to
tell a row that was checked and has no rule from a row nobody looked at.

| Mark | Rows | Meaning |
|---|---|---|
| `derived` | 13 | wired to `Gesamt` in the shipped template |
| `derived · BD BOM` | 9 | computed inside `BD BOM` from another row |
| `wired by tool` | 5 | `Gesamt` computes it; the shipped file never read it |
| `corrected by tool` | 1 | the shipped file reads the wrong row |
| `tool literal` | 3 | no `Gesamt` row exists — the quantity is ours |
| `manual` | 4 | a real requirement with no rule anywhere |
| `dormant` | 0 | a rule exists but a declaration switched it off |
| `no rule` | 106 | nothing in the calculators, the rule map or B151 produces it |

`AM` carries the rule id, so any line can be traced back to
`Rule Map/rules.seed.json`:

```
row 43   corrected by tool   G41 · shipped file reads =H42 — the I/O board row.
                             Gesamt row 41 already holds the slot-weighted
                             connector count; this file reads that instead.
row 44   wired by tool       G53 · Gesamt row 53 computes this and the shipped
                             file never reads it — note: the sheet divides by
                             150, the Bid team states 110
row 45   manual              M01 · no rule exists in either calculator
row 74   no rule             no rule in the calculators, the rule map or B151
```

The classification is read out of `parts.json` and `rules.seed.json`, not
tabulated in the writer, so regenerating either keeps it honest rather than
quietly wrong.

## How it is checked

`npm run verify-brc` builds both workbooks and asserts five things.

1. **Zip parity.** 151 of 152 parts with `calcChain` named as the one removal,
   `vbaProject.bin` byte-identical, 115 untouched parts byte-identical, all 38
   printer settings, 7 VML drawings, 3 images and the external link intact.
2. **The grid reconciles.** Everything the writer puts in the grid is a
   *literal*, so the file can be read back and re-tallied **without asking Excel
   to recalculate first** — which is the only reason a generated workbook can be
   checked at all before anyone opens it. Every column's drawn totals must equal
   what the pipeline packed.
3. **The sentinel invariant.** No sheet carries a real name without a drawn grid,
   and a location sheet is visible exactly when it is populated. A named sheet
   with no grid is not merely empty: `Gesamt` reads the template's own
   scaffolding and absorbs **8 power supplies and 4 racks** of hardware that
   does not exist.
4. **Provenance.** All 141 rows marked, every mark one of the eight words, and
   the marks agreeing with the quantities — nothing marked `no rule` holding a
   number, nothing marked `derived` sitting blank.
5. **Nothing the template owns was written.** Asserted against the template
   itself rather than a list of addresses, because which cells carry a formula
   varies by sheet.

Then `extract_layouts.py --book` reads the result back **in a different
language, with a parser that predates the writer**, and re-checks the token
vocabulary, every slot's head/body role, backplane widths against their own
geometry, counting points running 1..n without a gap in each evaluation group,
and the main/redundant separation constraint. It reports *"the drawn grid reads
back clean"* — and it earned its keep the first time it ran (below).

## What the round trip caught

The first generated file came back with 39 geometry anomalies of one kind: a
`BP-EXB` carrying I/O boards under an **empty** evaluation slot. The leading
4 TE of an extension backplane is the evaluation board its I/O boards extend —
that coupling is the crux of the decomposition — but the packer seated the power
backplanes first, so they ate the boards the extension heads needed. **43 of the
reference project's 202 backplanes came out that way. The planners' own layouts
do it exactly zero times in 21 locations.**

The fix reserves one board per extension head. It moves no board between
backplanes and changes no count the BoQ reads — `freeSlots4` is arithmetic over
the decomposition, not over these tokens — and both facts are now tests. The
BoQ diff and the packer's score are unchanged either side of it.

Nothing but drawing the layout and reading it back would have found this.

## Limits, stated rather than discovered later

- **Cached values are stale until Excel opens the file.** `fullCalcOnLoad` makes
  it recompute everything on open, but a tool reading the cache without
  recalculating sees the template's old numbers. Writing caches for row 3, the
  `B` column and the `Gesamt` and `BD BOM` columns is a bounded follow-up —
  every one of those numbers is already a pipeline driver.
- **Four racks and eighteen slots per column** are hard ceilings, by the
  template's own decision. Reported by name, never silently truncated.
- **Writing both workbooks takes a few seconds** and it is synchronous — about
  two seconds of work per workbook plus fetching the 2.8 MB template, so roughly
  nine seconds end to end in a production build. The button says
  *"Writing two workbooks…"* and disables itself for the duration rather than
  leaving a tab that looks broken. Moving it to a worker would free the thread;
  it is a once-per-bid operation, so it has not been worth it yet.
- **106 `BD BOM` rows have no rule** and ship blank — but each says so in the
  file rather than looking like an oversight.
- **`Gesamt`'s spare column stays off.** It is gated on a blank `AG72`,
  mis-wired for 13 of its 24 mapped rows, and its connector entry points at an
  empty row. Switching on that wiring would produce wrong numbers, so it is
  reported and left exactly as shipped.
- **Never modify the workbooks in this folder.** They are read as templates and
  handed back patched; no generated copy is committed.
