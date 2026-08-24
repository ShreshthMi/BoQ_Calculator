# BoQ Calculator

Turning the Frauscher FAdC R2 bid estimation spreadsheets into something that can
be run, tested and argued with.

The starting point was two Excel workbooks and a design prototype. The end point
is a browser application that takes the handover sheet and produces a Bill of
Quantities, with every line carrying where its number came from.

```bash
cd app && npm install && npm run dev     # the application
cd demo && npm test                      # 41 tests — the pipeline
cd packer && npm test                    # 90 tests — decomposition and packing
```

Reference project throughout: **NWR Jaipur–Sawai Madhopur**, 18 locations,
550 detection points.

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
