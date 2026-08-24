# The Bid Process Sheet, generated

The export stops being a BoQ sheet and becomes the handover artefact: one
workbook in the format of `BOM CAL/Handover BID Process Sheet Version 11.xlsx`,
carrying this project's questionnaire, DP/TS table and Bill of Quantities.

```bash
cd app
npm run verify-bid-sheet      # generate one and check it three ways
python "../Bid Sheet/extract_questionnaire.py"   # regenerate questionnaire.json
```

| | |
|---|---|
| `extract_questionnaire.py` | Reads the questionnaire's shape out of the workbook |
| `questionnaire.json` | Generated. 24 questions, their options, and which checkbox is which |
| `../app/src/xlsx-patch.ts` | Cell surgery at the zip level |
| `../app/src/export-bid-sheet.ts` | What goes in which cell |
| `../app/src/questionnaire.ts` | Which answers the tool holds and which it asks for |

## Patch the zip; do not rebuild the workbook

This is the load-bearing decision and it was settled by experiment, not by
preference. An `.xlsx` is a zip of XML parts and this one has **128** of them.

| | |
|---|---|
| Load with ExcelJS, write it straight back | **98 of 128 parts destroyed** |
| Load the zip, patch the parts we own, rewrite | **128 of 128 kept** |

What ExcelJS drops is not incidental: all 62 checkbox `ctrlProps`, both VML
drawings, both external links, every printer setting, the custom XML and the
Power Query connections. Its own object model reports that round trip as clean,
because it cannot see what it does not model — which is exactly the trap. The
sheet count, the hidden flags, the images and the data validations all survive,
so a surface check passes while the document quietly stops being the document.

`app/scripts/verify-bid-sheet.ts` asserts zip parity on every run for that
reason: the same parts as the template, and every part the writer does not own
byte-identical. It is the check that would have caught the mistake.

## Four tabs carry project data

Five do not. `Template & Version` is Frauscher's own template revision log
(v5–v11 — the file is Version 11). `7. Check List` is a blank document
checklist. `3. Eligibility Conditions`, `5. Customer Requirements` and
`6. Pre Bid Query` are empty forms: headers plus the dropdown source lists their
validations point at. None carries a single answer belonging to the tender the
template came from, so all five pass through untouched.

The writer owns the other four.

### `16.DP TS details` — write the inputs, let the sheet compute

All 80 of its formulas are one of:

```
K{r} = G{r}+I{r}    L{r} = H{r}+J{r}      Yard MAIN = DN + UP
T{r} = P{r}+R{r}    U{r} = Q{r}+S{r}      ABS main  = DN + UP
V{r} = T{r}         W{r} = U{r}           ABS redundant mirrors main
```

So only the input cells are written — `F`, `G/H`, `I/J` for Yard and `N`, `O`,
`P/Q`, `R/S` for ABS — and the columns `demo/src/import.ts` reads back as a
consistency check compute themselves. Import and export agree by construction
rather than by two copies of the same arithmetic living in two files.

The ABS block gets **one row per block section**, which is how the sheet records
them: Durgapura and Sanganer each sit on two and appear twice, and the importer
merges them back by name. Collapsing them to one row would lose the per-section
split — the thing that makes their rack count three rather than two.

One trap. Each formula keeps a **cached value** from the file it was loaded out
of. Excel recalculates on open, but SheetJS reads the cache, so a writer that
fills `G5` and leaves `K5`'s cache alone produces a file that re-imports with
warnings about numbers that no longer add up. The caches are updated alongside,
and the round-trip check is what catches it if they ever are not.

Three things on that sheet belong to the reference tender and are cleared rather
than carried: the note in `E13` reading "To Match the Quantity", the red font on
row 13 it annotates, and the hidden older BoQ. `O28` — *No of Location* — is a
hand-typed literal in the template that disagrees with its own blocks; the tool
writes the real count.

### `10.  BOQ` — matched on part, not on code

The template's rows and the generated lines do **not** share a code system. The
BoQ writes `24422` for the rail deflector and `17390` for the rack — AT Sales
Cloud and RDSO numbers — where the rules carry the IN Sales Cloud `101950` and
`100049`. Matching on the raw code finds six rows of forty-one. Both sides go
through the part index instead, aliases included, which is the same crosswalk the
diff against the submitted BoQ already uses.

**Blank stays blank.** A line no rule could produce writes an empty cell, never a
zero. A row the template carries and the project does not produce is blanked too,
rather than left holding another tender's number.

Where the project generates a line the template has no row for, the export says
so rather than dropping it silently. On the reference project that is ten lines.

## The questionnaire

`questionnaire.json` is generated because it could not sensibly be typed. The
answers are **62 legacy Form Control checkboxes** with no `FmlaLink`: the state
lives only as `checked="Checked"` inside `xl/ctrlProps/ctrlPropN.xml`, and
nothing in the workbook says which of those 62 files is "b) NO" under question 18.

What the workbook does say is where each control sits. The VML gives every shape
an absolute position and the row heights turn that into a row; match the row
against the option labels and the mapping falls out. Two traps make it harder
than it sounds — the VML mixes units (most positions in points, one in inches),
and the `<control>` anchors in the sheet XML are relative to rows whose heights
have since changed, so reading those drifts by one over the lower half and lands
two controls on the same option. The extractor asserts that all 62 land on a
distinct option row before it writes anything.

The result reads as evidence in its own right. The reference project answers
**Decentralised** to the architecture question — that is the equipment rooms —
and then defers the detail to "Refer Sheet No 17", a sheet that is not in the
workbook. It answers **Separate Evaluator: Yes**, which is why the packer splits
down from up. And it answers **Spare Requirement: NO**, which is why the
submitted BoQ books no spares on any of its 41 lines.

### Seven questions the tool answers for itself

| Question | Read from |
|---|---|
| 5. Application for which MSDAC is procured | each location's application and detection |
| 6. Volume (total DP and TS) | the locations |
| 7. Cable length given in tender documents | the cable-length source |
| 10 (A). Centralised or decentralised | whether any location declares two equipment rooms |
| 15. FDS considered | the FDS declaration |
| 18 / 19. Spare and spare-slot requirement | the spares declaration |

A question is either derived, and shown on the Questionnaire screen with the
thing it reads, or asked, and stored. Never both — asking for something the
project already states is an invitation for the two answers to disagree.

Every one of the 62 controls is written on export, including the ones being
cleared. Clearing by omission would leave a new project wearing the reference
tender's ticks.

## What it does not do

- **Ten rows per block.** The DP/TS sheet's two blocks are rows 5–14 and rows
  cannot be inserted without moving the totals row and the summary block. A
  project with more than ten Yard locations, or more than ten ABS block-section
  rows, is reported rather than silently truncated. The BoQ still books all of
  them.
- **No new BoQ rows.** Lines with no row in the template's table are reported,
  not added. Extending an Excel Table means rewriting its `ref` and its
  calculated column, and that is worth doing deliberately rather than in passing.
- **Prices.** The template's Spare column is 40 formulas pointing at a cost
  estimate on someone's `F:` drive (`'[2]Supply COST'!E4`), all cached at zero —
  which is almost certainly the real reason the submitted BoQ books no spares.
  The writer replaces those cells with values and does not attempt the link.
