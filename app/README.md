# BoQ Calculator — the application

The demo as a standalone app. Drop the handover workbook in, get a Bill of
Quantities out, override what needs overriding, export.

```bash
cd app
npm install
npm run dev      # http://localhost:5180
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
submitted BoQ.

Making that possible needed one refactor: filesystem access moved out of the
pipeline into `demo/src/node-io.ts`, which the app never imports. Everything
else takes data and returns data, so the same code runs against a `File` from an
input element as against a path.

## The six screens

| Screen | What it does |
|---|---|
| **Workbook** | Drag-drop or pick the file. Reports what was read and reconciles it against the sheet's own stated totals |
| **Declarations** | The project-level answers rules read. Switching one off makes its rules *dormant*, not zero |
| **Locations** | The DP/TS table, editable. Everything downstream re-derives on each keystroke |
| **Rack layout** | Per-location elevation, slots drawn true to TE pitch. Hover for backplane and owning group |
| **Bill of Quantities** | Every line with its provenance. Click to expand |
| **Diff vs submitted** | Against the `10.  BOQ` sheet in the same workbook |

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

This needed a different writer. SheetJS reads workbooks well but cannot write
cell styling in its community build, which is why the export — and only the
export — uses ExcelJS, imported dynamically so its 930 KB lands solely when
someone actually exports. Project state also exports as JSON: source, locations,
declarations and overrides, which is the versioning and sharing story the
proposal asks for.

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

## Two bugs the browser found

Worth recording, because both were invisible from the CLI.

**Every override read `stale` the instant it was applied.** `BoqLine.derived`
included the spare quantity while staleness compares against the bare rule
value, so an override snapshotted 578 and was immediately judged against 550.
`derived` is now the main quantity alone. The CLI never showed this because it
only ever passed literal snapshots.

**The header DP total ignored edits.** Editing a location updated the location
but not `project.totals`, so the figure in the top bar drifted from the tables
below it.

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
| `src/App.tsx` | All six screens |
| `src/styles.css` | Tokens and components |
| `vite.config.ts` | Reads the shared pipeline from the workspace root |
