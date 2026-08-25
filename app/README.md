# BoQ Calculator — the application

The demo as a standalone app. Drop the handover workbook in — or start with
nothing and enter the locations by hand — get a Bill of Quantities out, override
what needs overriding, export.

```bash
cd app
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ — static files, open index.html anywhere
```

Browser-only, exactly as the proposal specifies. No server, no upload, no
network call once loaded — the workbook is read in the tab and never leaves the
machine. `dist/` is a folder of static files that can be opened from disk or put
behind any web server.

## It runs the same pipeline as the CLI

Not a reimplementation. `src/pipeline.ts` is thin wiring over the modules
`demo/` and `packer/` already ship, and both produce identical numbers from the
same workbook: 18 locations, 550 DP, 66 racks, 11 of 41 lines matching the
submitted BoQ — and 14 of 41 once the equipment rooms and the cable plan are
declared.

Making that possible needed one refactor: filesystem access moved out of the
pipeline into `demo/src/node-io.ts`, which the app never imports. Everything
else takes data and returns data, so the same code runs against a `File` from an
input element as against a path.

## The seven screens

| Screen | What it does |
|---|---|
| **Project source** | Drop the workbook, start empty, or reopen a saved project state. Reports what was read and reconciles it against the stated totals |
| **Declarations** | The project-level answers rules read. Switching one off makes its rules *dormant*, not zero |
| **Locations** | The editor. Add and remove locations, edit every field, declare equipment rooms and cable runs. Everything downstream re-derives on each keystroke |
| **Questionnaire** | The 24 questions of sheet `4. Project Questionnairre`. Seven are answered from the project and shown with what they read; the rest are asked |
| **Rack layout** | Per-room elevation, slots drawn true to TE pitch. Hover for backplane and owning group |
| **Bill of Quantities** | Every line with its provenance. Click to expand |
| **Diff vs submitted** | Against the `10.  BOQ` sheet in the same workbook. A hand-entered project says it has nothing to compare against rather than showing an empty comparison |

## The Locations screen is now the editor for both routes

An imported project and a hand-built one are the same object from the moment
they are open, so there is one editor rather than two.

**The project is built, never mutated.** The screen holds the entered data — a
`ProjectInput` — and `buildProject` derives the `Project` from it on every
change. That replaced an in-place mutation that maintained `totalDp`, `totalTs`
and `project.totals` by hand in three places, plus a revision counter that
existed to lie to `useMemo`. Now the direction sums, the location totals, the
project totals and the reconciliation warnings cannot drift out of step, because
none of them is stored.

Each row carries the name, scope, detection, application, room count and the
DN/UP counts. Opening one gives the block sections — Durgapura and Sanganer sit
on two, and their split has to survive — the equipment rooms with their own rack
counts, and the measured cable runs. What the tender states can be entered too:
it is never used as a source, only reconciled against on every edit, which is
the manual route's equivalent of the sheet's own summary block.

**A project with no locations bills nothing.** The output screens are closed
until there is demand to derive from. Summing an empty list gives zero for every
driver, and a BoQ of zeros reads as a real answer of "none required" — which is
exactly the failure the whole provenance model exists to prevent.

## The export is the whole handover workbook

"Bid Process Sheet" writes a workbook in the format of
`Handover BID Process Sheet Version 11.xlsx` with this project in it — the
questionnaire, the DP/TS table and the BoQ — by patching the template's zip
rather than rebuilding it. The reasoning, and the measurement behind it, is in
[`../Bid Sheet/README.md`](../Bid%20Sheet/README.md). The short version: the
obvious approach destroys 98 of the workbook's 128 parts and reports success.

`npm run verify-bid-sheet` generates one outside the browser and checks it three
ways — it re-imports as the same project with no warnings, it has the same zip
parts as the template with every untouched one byte-identical, and its
quantities land on the rows their part numbers name.

"BoQ sheet only" is the older export, kept because a single styled sheet is
sometimes all anyone wants.

## And "BRC calculators" writes the workbook the BoQ falls out of

One click, **two files** — ABS and Yard — because the two shipped calculators
are the two halves of one tender. Each carries a slot grid drawn per evaluation
column, board by board, with the counting points and track-section numbers a
planner writes underneath, and every `BD BOM` row marked with where its number
came from.

`npm run verify-brc` builds both outside the browser and checks them five ways;
`python "../Rule Map/extract_layouts.py" --book BRC-ABS.xlsm BRC-YARD.xlsm` then
reads the result back with a different language and a parser that predates the
writer. The reasoning is in [`../BOM CAL/README.md`](../BOM%20CAL/README.md).

Both the writer and the 2.8 MB template are loaded on demand, so nothing about
the calculators is fetched until someone exports one.

## The spreadsheet export is in the bid team's own format

Not a generic dump. `src/export-xlsx.ts` reproduces the layout of sheet
`10.  BOQ` in the handover workbook, so the output is a drop-in replacement
rather than something that has to be reformatted before use:

| | |
|---|---|
| Row 1 | empty |
| Row 2 | header `B:G` — Column1 · SAP CODE · Description · Main Qty · Spare · Total, dark navy, white bold, filter dropdowns |
| Column A | group name merged down the block and **rotated 90°**, medium border |
| Data | fill `FFBDD7EE`, thin borders, description left and the rest centred |
| Widths | 9.1 / 10.6 / 23 / 66.7 / 10.9 / 8.3 / 9.1 |

Those measurements are read out of the workbook, not guessed. A generated file
reopened and compared against the original matches on merges, widths, fill,
bold, rotation, alignment and border weight.

**Blank stays blank.** A line no rule could produce writes an empty cell, never
a zero — a zero in a BoQ reads as a real answer of "none required".

A second sheet, **Provenance**, carries the audit trail: rule id, provenance,
derived value and note per line. Keeping it off sheet 1 is what lets sheet 1 stay
a drop-in match.

Project state exports as JSON and **reads back in**: what is written is the
entered data, the declarations and the overrides, not the derived project, so
reloading rebuilds every derived figure rather than trusting a snapshot. A
workbook-sourced project loses its submitted BoQ that way — that lived in the
.xlsx — and the app says so rather than showing an empty diff.

This needed a different writer. SheetJS reads workbooks well but cannot write
cell styling in its community build, which is why the export — and only the
export — uses ExcelJS, imported dynamically so its 930 KB lands solely when
someone actually exports. 

## Expanding a line is the point

Click any BoQ row and it opens to show the rule id, the driver it read, the
expression, the rounding, the scope, where in the workbook it was recovered
from, and what is blocking it if it is blank. That is what makes a generated
number arguable rather than merely asserted.

The same panel is where an override is entered, with a reason that travels with
the number.

## Overrides and staleness

`driverSnapshot` records the derived value at the moment the override is entered
and is never recomputed. Change a detection-point count on the Locations screen
and the line flags:

```
G05  102207  Wheel sensor RSR180   350   stale
             entered against 550, rules now say 554 — only 350 runs are within 4.8 m
```

The hand-entered 350 survives. It is neither silently kept nor silently dropped.

Overrides also feed forward: override the wheel sensor to 350 and the protection
tube follows to 350, and the 5 % spare becomes 18 rather than 28. A spare is a
percentage of what is actually being bought.

## Four bugs the browser found

Worth recording, because both were invisible from the CLI.

**Every override read `stale` the instant it was applied.** `BoqLine.derived`
included the spare quantity while staleness compares against the bare rule
value, so an override snapshotted 578 and was immediately judged against 550.
`derived` is now the main quantity alone. The CLI never showed this because it
only ever passed literal snapshots.

**The header DP total ignored edits.** Editing a location updated the location
but not `project.totals`, so the figure in the top bar drifted from the tables
below it. That class of bug is now unreachable: totals are derived, not stored.

**Two locations sharing a name produced one warning between them.** This tender
carries a Durgapura and a Sheodaspura in *both* the Yard and the ABS block, so
switching to measured cable runs raised two identical sentences — which React
then rendered under the same key, duplicating and omitting boxes at random. A
warning now names the scope when, and only when, the name is shared, and the
list is keyed by position rather than by its own text.

**Number inputs changed value on a stray scroll wheel.** In a dense grid of
eighteen rows that is a silent data edit. They blur on wheel instead.

A third turned up while building the export: lines with no catalogue part were
showing their engineering *note* in the Description column, so a BoQ row read
"Active fan. Confirms the 120 W threshold, but quantity is per cubicle, not the
2-per-cubicle the prototype assumes." Descriptions now take the first sentence —
"Active fan", "Patch cable", "4 TE blanking plate for spare PSC slots" — and the
full note stays in the provenance sheet where it belongs.

## Design

Tokens follow the `Industry` design system the prototype already uses — the same
Barlow / Barlow Condensed and blue — so the app reads as continuous with the
design the team has seen, extended to a dark theme the prototype does not have.
Provenance is encoded twice, as a left edge stripe and a pill, so state reads at
a glance rather than by comparing words.

## Layout

| Path | |
|---|---|
| `src/pipeline.ts` | Browser wiring; bundles the rule seed and part master |
| `src/export-xlsx.ts` | The styled BoQ writer |
| `scripts/verify-export.ts` | Generates the file outside the browser so it can be inspected |
| `src/App.tsx` | All seven screens, including the locations editor and the questionnaire |
| `src/xlsx-patch.ts` | Cell surgery at the zip level, so nothing outside the edited cells moves |
| `src/export-bid-sheet.ts` | The Bid Process Sheet writer |
| `src/questionnaire.ts` | Which questionnaire answers the tool holds and which it asks for |
| `../demo/src/project.ts` | The project shape, the derivations and `buildProject` — shared with the CLI |
| `src/styles.css` | Tokens and components |
| `vite.config.ts` | Reads the shared pipeline from the workspace root |
