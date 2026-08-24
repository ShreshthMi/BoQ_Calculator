# BoQ Calculator

Turning the Frauscher FAdC R2 bid estimation spreadsheets into something that can
be run, tested and argued with.

The starting point was two Excel workbooks and a design prototype. The end point
is a browser application that takes the handover sheet and produces a Bill of
Quantities, with every line carrying where its number came from.

Reference project throughout: **NWR Jaipur–Sawai Madhopur**, 18 locations,
550 detection points.

## Running it

### Prerequisites

| | | |
|---|---|---|
| **Node.js 24 or newer** | required | The project runs TypeScript directly through Node's type stripping, so there is no build step for `packer/` or `demo/`. On Node 20 or older the test scripts fail with a syntax error on the first type annotation |
| **Python 3.9+ with `openpyxl`** | optional | Only for the scripts that read the Excel workbooks. `pip install openpyxl` |
| git | required | |

Nothing else. No global tooling, no `gh`, no database, no server.

Paths in this repository contain spaces — `Part Catalogue`, `Rule Map`,
`BOM CAL` — so quote them in shell commands.

### Just run the application

```bash
cd app
npm install
npm run dev          # http://localhost:5173
```

Then drop `BOM CAL/Handover BID Process Sheet Version 11.xlsx` onto the page.

`npm run build` produces `dist/`, a folder of static files that can be opened
from disk or served from anywhere. The app is browser-only — the workbook is
read in the tab and never leaves the machine.

Run it from inside the repository. Vite is configured to read the shared
pipeline from the repository root, so moving `app/` elsewhere breaks the
imports.

### Verify the whole thing

```bash
cd packer && npm test          # 90 tests — no npm install needed, it has no dependencies
cd ../demo && npm install
npm test                       # 41 tests
npm run demo                   # the CLI: sheet in, BoQ out, diffed against the submitted one
```

Expect `11 match · 10 differ · 4 blank · 16 not produced` from the CLI, and
`21/21` rack counts from `cd packer && npm run score`.

### Regenerate everything from the workbooks

Optional — the generated artefacts are committed. This re-derives them from the
source spreadsheets, in dependency order:

```bash
pip install openpyxl

python "Part Catalogue/extract.py"        # the 141-part master
python "Rule Map/build_rulemap.py"        # 57 rules + fixtures  (needs parts.json)
python "Rule Map/verify_rulemap.py"       # 7 checks over the seed
python packer/scripts/extract_reference.py   # ground truth — slow, a few minutes
```

`git status` should be clean afterwards: regeneration is byte-identical to what
is committed.

### Also available

```bash
cd demo && node scripts/report.ts        # a standalone HTML report of a live run
cd packer && npm run score least-te      # score the packer under the other objective
```

## What is here

| | |
|---|---|
| [`app/`](app) | The application. React + TypeScript, browser-only, no server |
| [`demo/`](demo) | The pipeline — import, demand, rules, overrides, BoQ, diff — and a CLI |
| [`packer/`](packer) | Backplane decomposition and rack packing. Zero dependencies |
| [`Rule Map/`](Rule%20Map) | 57 recovered rules, mapped against the prototype's 28 |
| [`Part Catalogue/`](Part%20Catalogue) | The 141-part master extracted from `BD BOM` |
| `BOM CAL/` | The source workbooks. Inputs, not outputs — never modified |
| `BOM CAL DESIGN/` | The design prototype, parsed for its rule set |

Each folder has its own README with the detail.

## The result

Against the BoQ the bid team actually submitted:

```
41 submitted lines — 11 match · 10 differ · 4 blank · 16 not produced
```

Rack packing reproduces the planners' own layout at **21 of 21** reference
locations, and the backplane mix at 18 of them.

Every one of the ten differences has a stated cause, and several are cases where
the tender looks wrong rather than the engine:

- **+4 COM-AdC** — one per evaluation group. Four locations omit the redundant board
- **+4 backplane connectors** — `BD BOM` copies the IO-EXB row instead of Gesamt's slot-weighted count
- **+6 FDS** — the rule says one per location; the shipped 12 was typed by hand
- **19-unit kit split** — moved 5 m → 10 m after the fact, recorded nowhere

## The three findings worth the trip

**The rules were never missing.** `Gesamt` computes 58 line items and `BD BOM`
consumes 13. Twenty-five working formulas — cubicles, FDS, fans, blanking plates,
patch cable, planning services, every spare line — are calculated correctly and
then dropped between two sheets of the same workbook. What looked like knowledge
nobody had written down was knowledge nobody had wired up.

**Some rules live outside the spreadsheet entirely.** The cable-length split had
no formula anywhere; it is prose in the handover questionnaire, cell `B151`
item 16. Applied to the real scopes it gives 369 / 144 / 37 — exactly what the
hidden older BoQ sheet books, against the 350 / 163 / 37 that shipped. That one
cell holds 24 numbered guidelines and has already yielded two rule families.

**The calculator aggregates a layout a human drew; the tool generates it.**
`AEB = SUM('01'!AG59:AG167)` sums a grid an engineer fills in by hand. Fifteen of
the recovered rules are inversions of that kind, and they are what the packing
algorithm had to earn.

## Provenance is the point

Every BoQ line says whether it was `derived`, `overridden`, `stale`, `manual`,
`blank` or `dormant`. A rule that cannot resolve produces a **flagged blank,
never a silent zero** — a zero reads as a real answer of "none required".

Overrides record the derived value at the moment they were entered and never
recompute it, so changing an input marks them stale rather than silently keeping
or dropping them. They also feed forward: override the wheel sensor and the
protection tube follows, and a 5 % spare becomes 5 % of what is actually bought.

## Still open

Three inputs a planner chooses rather than rules waiting to be found: the
evaluation-group structure, the PSC count — guideline item 1 says outright it is
"decided as per technical requirement" — and the data-transmission IO allowance.

The seven remaining differences against the submitted BoQ are listed with their
figures in [`demo/README.md`](demo/README.md).
