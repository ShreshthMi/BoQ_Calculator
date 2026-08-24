# The demo — input sheet in, BoQ out

Drops the real handover sheet in one end and gets a Bill of Quantities out the
other, then diffs it against the BoQ the bid team actually submitted.

```bash
cd demo && npm install
npm run demo                  # import, generate, diff
node run.ts --overrides       # with two hand overrides applied
node run.ts --bump ALH-2:2    # revise the input sheet, watch an override go stale
npm test                      # 41 tests
```

SheetJS reads the workbook, so the import is the same code path a browser build
would run on an uploaded file. Everything downstream — packing, rules, overrides
— is dependency-free and lifts into the React app unchanged.

## The pipeline

| Stage | Module | What it does |
|---|---|---|
| 1 Import | `src/import.ts` | `16.DP TS details` → 18 locations |
| 2–3 Demand + pack | `src/engine.ts`, `../packer` | groups, backplanes, racks, cubicles |
| 4 Rules | `src/engine.ts`, `src/expr.ts` | 57 seeded rules, evaluated per location |
| 5 Overrides | `src/boq.ts` | effective quantities, stale detection |
| 6 BoQ + diff | `src/boq.ts` | grouped output, diffed against `10.  BOQ` |

## Stage 1 reads both block shapes

The handover sheet carries two differently-shaped blocks side by side, exactly as
the proposal anticipated:

- **E:L — Yard.** 10 stations, `DN Line` / `UP Line` / `MAIN`. Single detection.
- **N:W — ABS.** 10 rows, `DN Line` / `UP Line` / `DN & UP Main` / `DN & UP Redundant`.
  Dual detection. Durgapura and Sanganer each sit on two block sections and are
  merged — but their per-section counts are **kept**, because the workbook gives
  each section its own evaluation system.

Import reconciles against the sheet's own stated totals (176 / 164 ABS,
374 / 303 Yard, 550 / 467 project, 18 locations) and reports zero warnings.

## The result

```
41 submitted lines — 10 match · 11 differ · 4 blank · 16 not produced
```

Of the 41, **20 are machine-reproducible** today. The remainder are parts with no
rule and, in 14 cases, no catalogue entry either.

**10 match** outright: TLJB-01, strain relief clamp, BSI004, AEB101, the rail
deflector, four backplane variants, and the 14.8 m kit — all at 550 or the packed
backplane counts.

**10 differ**, every one for a reason worth stating out loud:

| Line | Submitted | Generated | Why |
|---|---|---|---|
| Kit 4.8 m / 9.8 m | 350 / 163 | 369 / 144 | The guideline's answer. See below — this one is the good news |
| BGT07 racks | 68 | 66 | The planner put DN and UP in separate rooms at Devpura and Snaganer. That is a siting decision; the input sheet does not record it |
| BP-EXB-1 / -2 | 27 / 92 | 26 / 91 | Same cause |
| IO-EXB | 244 | 237 | `dataTransmissionIO` is declared 0 here; the real allowance is per-location and not in the sheet |
| Backplane connector | 244 | 248 | The **known BD BOM defect** — its formula copies the IO-EXB row instead of Gesamt's slot-weighted count. Gesamt says 251; the BoQ shipped 244 |
| PSC | 61 | 46 | `pscPerGroup` declared as 1; the workbook equips 2 on larger Yard groups. Not derivable |
| FDS102 | 12 | 18 | The rule says one per location. The submitted 12 was typed by hand. **The rule and the tender disagree** |
| COM-AdC | 42 | 46 | One per evaluation group. The four missing are redundant COM boards — see below |
| Cubicles | 22 | 18 | `ceil(racks / 6)` per location against the workbook's own formula |

**4 blank**, correctly: Line Verification Box, reset box, reset cubicle,
co-operation reset panel. No rule produces them and the tool says so rather than
inventing a number. All four are exactly the parts the override log flagged as
rules-we-do-not-have.

## COM boards — the last unrecovered driver, now recovered

`G36` was the one driver nothing could derive. It came out of a piece of domain
knowledge that is not written in any of the workbooks:

> A COM board is one CAN segment.

With that, the workbook's own cells fall into place. `Gesamt!AI88`, labelled
**"Redundancy COM"**, is ticked on this project — so every CAN segment carries a
COM per system. And `Gesamt!BJ3 = COM / AL95` with `AL95 = 2` states the same
relationship in reverse; `AL90 = 1` sits alongside it as the unused
non-redundant divisor.

So: **one COM board per evaluation group**. Checked against the reference:

| | locations | exact |
|---|---|---|
| Yard | 13 | **13** |
| ABS | 8 | 4 |

The four ABS exceptions — Jaipur JN, Durgapura, Sanganer, Sheodaspura — are each
short by exactly one, and each is a location whose *redundant* system carries no
COM board. They are the same four the packer already warned about.

The rule now derives **46** where the tender shipped **42**. The difference is
not a modelling artefact: it is four COM-AdC101 boards the BoQ under-books.

**16 not produced** — switches, timers, relays, surge protection, tool kits.
Fourteen have no rule *and* no catalogue part; two more (patch cable `18060`,
rack fan `101350`) have a working rule in `Gesamt` but **no part number in the
BD BOM catalogue at all**, even though the submitted BoQ carries codes for them.
That is a gap in the part master, not in the engine.

## Part-code aliases

The rail deflector was a false negative: rule `G09b` produced 550, the BoQ books
550, and the two never joined because the BoQ writes the part as `24422` while
the catalogue carries `101950`. Same product, code the part master does not hold.

`src/aliases.ts` carries an explicit crosswalk for exactly this. Three rules
govern it:

- **Explicit entries only.** Descriptions are never fuzzy-matched. "Rail claw
  SK140-011" and "Rail claw plate SK140-011" differ by one word and are
  different products, and the catalogue already has ten duplicate part numbers of
  its own. A wrong join moves quantities between lines silently, which is worse
  than the blank it replaces.
- **Evidence travels with the mapping.** For `24422`: it appears only in the two
  BoQ sheets, nowhere in either calculator, described as "Frauscher Rail
  Deflector FRD001 GS02 60kg" — the `BD018` description exactly bar its `IN `
  prefix — at the same quantity. `BD018` carries `101950` across all three of its
  code systems and no 5-digit AT-style number, so `24422` looks like the AT Sales
  Cloud code that never reached the catalogue row.
- **The catalogue always wins.** An alias never overwrites a real code. If the
  part master later gains `24422`, the alias goes inert and is reported as
  redundant so it can be deleted rather than quietly diverging.

Each entry is a question for the part master, not a permanent fix. The right end
state is that the catalogue carries the code and this table is empty.

## The cable-length split — the best thing in here

The three trackside kit codes were the hardest lines to place: 550 detection
points divided 350 / 163 / 37 across the 4.8 m, 9.8 m and 14.8 m variants, with
nothing in either calculator to explain it. BD BOM rows 6/7 and 9/10 carry no
formula in any location column, and Gesamt has no length dimension at all.

The rule turned out to be written down, just not in a calculator — handover sheet
`4. Project Questionnairre`, cell **B151 item 16**, "Cable Length if not
specified in tender document":

| Application | Mix |
|---|---|
| Station, single detection | 75 % of 5 m, 15 % of 10 m, 10 % of 15 m |
| Station, dual — main | 75 % / 15 % / 10 % |
| Station, dual — redundant | 75 % of 10 m, 25 % of 15 m |
| Auto block | 50 % of 5 m, 50 % of 10 m |
| IBH / absolute block | single: all 5 m · dual: 50 / 50 |

Applied to the real scopes — Yard is 374 DP of station, ABS is 176 DP of auto
block:

```
5 m   0.75 x 374  +  0.50 x 176   =  368.5  ->  369
10 m  0.15 x 374  +  0.50 x 176   =  144.1  ->  144
15 m  0.10 x 374                  =   37.4  ->   37
```

**369 / 144 / 37 is exactly what the hidden older BoQ sheet books.** The shipped
sheet reads 350 / 163 / 37 — nineteen units moved from 5 m to 10 m, by hand,
after the fact, with no reason recorded anywhere.

So the tool derives what the engineer originally computed, and the gap to what
shipped is precisely one override with a missing justification. That is the whole
argument for the tool in a single line of a BoQ.

These three carry a verdict of their own in the seed — **`guideline`**, meaning
*not in either calculator, but written down in prose in the handover
questionnaire and recoverable from there*. They are `K01` / `K02` / `K03`, and
they are the only rules in the set sourced from outside a spreadsheet. The
distinction matters: `recovered` rules exist as working formulas in `Gesamt` and
merely fail to reach `BD BOM`, whereas a `guideline` rule was never mechanised
anywhere and had to be read out of a paragraph of English.

Worth expecting more of them. Cell B151 holds **24 numbered guidelines** and four
have been mined so far — item 16 gives this split, and items 1 and 6–8 gave the
cubicle capacities the packer uses (15U = 1 rack / 4 IO-EXB, 20U = 2 / 10,
35U = 4 / 20, one COM board per cubicle, max 40 AEB per COM). Items 17
(rail-claw profile by track type), 18 (protection tube type) and 19 (COM board
selection by interface) all read like rules too. That one spreadsheet cell is
carrying a meaningful share of the company's estimating knowledge as prose.

**One caveat that belongs with the number.** This is a stated default for
missing information, not a measurement. Once the real cable plan exists the rule
should be switched *off*, not overridden line by line — otherwise a dormant
guideline sits underneath the BoQ quietly contradicting three of its lines.

## Three findings from running it

**The submitted BoQ books zero spares.** All 41 lines, Spare column empty —
while the workbook carries 27 spare rules at 5 % and 1 %. The comparison here is
main-to-main for that reason. Someone should decide whether that was deliberate.

**Rounding location matters more than expected.** Gesamt computes every row in
each location's column and totals across. Applying the same rule to a project
total is not the same thing: `ceil(550 / 25)` is 22, but the sum of
`ceil(dp / 25)` over 18 locations is **32**. A ten-unit swing on one line purely
from where the rounding happens. The engine evaluates per location and sums, as
the workbook does.

**Overrides must feed forward.** A 5 % spare has to be 5 % of what is actually
being bought, and a 1:1 follow-on line has to move with the line it follows.
Override the sensor to 350 and the protection tube becomes 350 and the spare
becomes 18 — not 550 and 28. `part()` therefore resolves against the override
layer, and those rules are project-scoped.

## Stale detection

`driverSnapshot` records the derived value **at the moment the override was
entered**, and is never recomputed. Revise the input sheet and the line flags:

```
G05  102207  Wheel sensor RSR180  350  stale · entered against 550, rules now say 554
```

The hand-entered 350 survives. It is neither silently kept nor silently dropped —
it is shown as needing a decision, which is the whole point.

## The expression evaluator

No `eval`, per the proposal. `src/expr.ts` is a tokeniser and recursive-descent
parser over exactly the grammar the rules use — arithmetic, `floor`/`ceil`/`round`,
and `part(BD###)`. Anything else throws.

**Null is absorbing.** An unavailable driver poisons the expression, so the rule
yields no quantity and the line shows as a flagged blank. Never a silent zero,
which would read as a real answer of "none required".

## Known gaps

- `dataTransmissionIO` and `pscPerGroup` are declarations, not derivations. For
  PSC that is now policy rather than a gap: guideline item 1 states outright that
  "PSC quantity can be decided as per technical requirement".
- **Patch cables are not derived, but the shipped figure is one step from it.**
  See below.

## Deriving the patch-cable line

Patch cables (`18060`) are one of the two lines with a working `Gesamt` formula
and no catalogue part, so the pipeline cannot currently book them. Worth writing
down how close the derivation is, because it is closer than it looks.

The shipped BoQ books **408**. The reference project carries **204 backplanes**
across both workbooks. So:

```
2 x 204 backplanes = 408      exactly the shipped figure
```

Two cables per backplane, and nothing else. That is almost certainly the rule.

`Gesamt` row 59 says something slightly different:

```
2 x (C20+C22+C27+C29+C30+C32+C34) - C36 - C37
= 2 x backplanes-in-use  -  COM-AdC  -  COM-xxx   =  366
```

Two discrepancies, both worth resolving before this is seeded:

1. **The `- COM` term does not reach the BoQ.** `Gesamt` subtracts one cable per
   COM board, giving 366; the tender shipped 408. Either the subtraction is
   wrong, or it was overridden. The shape of it — two per node, minus one per
   segment head — reads like a daisy-chain that saves a cable where the chain
   terminates, which would be a real topology fact rather than an error.
2. **The sum only names the variants in use.** `C27` is an unlabelled row, and
   `PWR-0/1/2/3/6/10/12/14/16` and `EXB-0/3/6` are all excluded. Harmless on this
   tender, wrong the moment a project uses one of them.

To settle it, someone needs to say how backplanes are actually cabled within a
rack and where a CAN segment starts and ends. Both candidate formulas are a
guess about topology dressed as arithmetic; the difference between them is 42
cables on this tender.
- `powerAbove120W` is modelled as a declaration but is really derived from board
  current and system voltage — see the packer's "not built" note.
- `cubiclesEnabled` collapses two distinct workbook gates (`AI82 > ""` for
  cubicles, `AI82 = "X"` for slot fans). Identical on this tender, not in general.
- The 19-unit hand adjustment to the kit split is not explained by anything in
  the workbooks. The tool reproduces the guideline; someone has to say why the
  shipped figure moved.
- `No of Location` in the handover sheet reads 18, but the calculators carry 21
  used location sheets — three Yard stations are split across two equipment rooms
  each. The sheet's own count is wrong.
- The questionnaire refers work to "Sheet No 17" at five places. There is no
  sheet 17 in the workbook; whatever backed the per-location breakdown was never
  shipped with the handover.
- Cell `E13` of `16.DP TS details` reads "To Match the Quantity", next to the
  Sheodaspura row. The DP table was adjusted to make the totals land on 374/550,
  which is worth knowing before treating it as a primary source.
