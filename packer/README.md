# FAdC R2 rack packer

Backplane decomposition, rack packing and cubicle allocation under the
main/redundant separation constraint. Zero dependencies, no DOM, no I/O — the
module lifts unchanged into the React app or a service, as the implementation
proposal requires.

Node 24 runs the TypeScript directly via type stripping, so there is no build
step and nothing to install.

```bash
npm test        # 90 tests
npm run score   # diff the packer against all 21 reference locations
npm run extract # rebuild fixtures/reference.json from the workbooks
```

## Result against the reference project

Every location from both BRC workbooks, scored against the layout the planner
actually drew:

| | |
|---|---|
| Locations | 21 (8 ABS, 13 Yard) |
| **Identical rack count** | **21 / 21** |
| Identical backplane mix | 18 / 21 |
| PSC placement + spare-PSC blanking | 21 / 21 |
| Total TE | 4692 vs 4718 — 26 narrower |
| Total backplanes | 202 vs 204 |
| Tests | 90 passing |

Rack count is the number that reaches the BoQ, and it matches everywhere.

The three mix differences are all spare IO capacity the planner chose to carry
and the packer does not invent — two extra `BP-EXB-1`, one `BP-EXB-2` where a
`BP-EXB-1` suffices. Rack count is unaffected at all three. They are recorded in
`test/score.test.ts` as `KNOWN_DIFFERENCES` rather than tuned away, per the
proposal: *the human layout is not necessarily optimal and the difference is
information*.

## What the workbook actually encodes

Reverse-engineered from the slot grids on sheets `01`–`30`, and confirmed
against Gesamt's own totals at all 21 locations.

**Backplane geometry.** The TE lookup on sheet `'01'` row 59 gives PSC 8, AEB and
COM 4, IO-EXB 6, which fixes the arithmetic:

```
BP-PWR-n : one 8 TE PSC slot + n slots of 4 TE (AEB *or* COM)   => 8 + 4n TE
BP-EXB-n : one 4 TE slot holding an AEB + n slots of 6 TE (IO)  => 4 + 6n TE
```

**Every BP-EXB carries an AEB.** The leading 4 TE of an extension backplane is a
populated evaluation-board slot, not dead space. This couples the two
decompositions and is the crux of the algorithm — see below.

**Groups, not boards, are the unit of separation.** Each location's grid is laid
out as one or more groups — independent evaluation systems, each with its own ZP
(counting point) numbering restarting at 1. A group owns its backplanes outright;
racks freely span group boundaries. Jaipur JN puts two whole groups in one rack;
ALH-1's second rack holds the tail of one group and the head of the next.

Verified exhaustively: at all 21 configured locations **zero backplanes carry
boards from more than one group**, and 7 racks host two groups on separate
backplanes. That is the Bid team's rule holding in the data — *not the same
backplane, but the same rack is fine.*

**But the grid never says which group is main and which is redundant.** There is
no such field. `SystemId` is a caller-supplied label the packer never branches
on. ABS locations carry 2 or 4 identical mirrored systems, consistent with
redundancy; Yard locations carry 1 to 3 systems of irregular size — Chaksu is
17 + 14 AEB, the down and up lines — which is plainly not redundancy. Same
mechanism, different meaning, so the packer keys on the group and stays agnostic.

**The redundant-PSC hardware is never used on this tender.** The one
redundancy-aware field in the schema is the PSC version row: `R2` yields a
`PSC-R` board token. Across all 21 configured locations there are 217 `R1` and
14 `NE` and **zero** `R2`. `PSC-R` appears only on the 39 untouched template
sheets. So the separation constraint is validated structurally, but the physical
redundancy option it exists to serve is unexercised by this reference data.

**Single detection caps at BP-EXB-2.** Dual detection may use `BP-EXB-4`. The
workbooks are unambiguous: Yard (single) books zero `BP-EXB-4` across thirteen
locations; ABS (dual) books ten.

## The coupling, which is the whole problem

Optimising the EXB and PWR sides separately gets the wrong answer. Worked example
— one ALH-2 group of 10 AEB / 5 IO / 1 COM:

| | EXB choice | AEB slots donated | PWR needed | Total |
|---|---|---|---|---|
| EXB minimised alone | `{EXB-4, EXB-1}` 38 TE | 2 | 9 slots → `PWR-8 + PWR-4` 64 TE | 102 TE, **2 racks** |
| solved jointly | `{EXB-2, EXB-2, EXB-1}` 42 TE | 3 | 8 slots → `PWR-8` 40 TE | **82 TE, 1 rack** |

Spending 4 TE more on extension backplanes removes an entire power backplane. The
workbook's own layout is the second. The packer searches both sides together and
finds it.

The search is exhaustive — a few thousand combinations at the largest location on
this tender — so no solver is needed.

## Objective

Lexicographic: **fewest backplanes, then least TE**, then fewest unequipped power
slots, then least wasted slot capacity.

This was chosen against the data, not assumed. At an ALH-1 group, `least-te`
finds a genuinely cheaper answer — `BP-EXB-2 + 4× BP-EXB-1 + BP-PWR-8` at 96 TE
versus the planner's 108 — but spends six backplanes instead of four to save
12 TE. Planners consistently prefer fewer, larger backplanes, and the extra
wiring and connectors are real cost the TE figure does not capture. Pass
`objective: 'least-te'` to see the other side; `npm run score least-te` scores it.

## Three inputs the packer will not invent

The workbook does not derive these, so neither does this module. Guessing them
would bury open questions inside an algorithm.

1. **Group structure.** ALH-2 splits into four groups of ten; Jaipur JN has the
   same down/up structure but uses two, folding both directions together; Yard's
   Banasthali splits 22 + 17, not 19.5 + 19.5. Bounded by the 80-participant CAN
   ceiling, otherwise a planner's call.
2. **COM count.** Rule `G36`, the one driver the rule map could not recover. ABS
   books 1, 2, 3, 3, 4, 4, 4, 1 across its eight locations.
3. **PSC count.** One per group holds at all eight ABS locations and at *none* of
   the thirteen Yard ones, where larger groups carry two. The workbook places PSC
   and `spare-PSC` tokens by hand and then feeds the count *into* its current
   calculation at 38 mA each, rather than deriving it from anything. Defaults to
   1 per group; pass `Group.psc` to override.

Where a group carries no COM board while `separateSystems` is on, the packer
emits a warning rather than failing — the Bid team's rule wants one COM per
system, but the reference project shares a single COM at four ABS locations.
Both facts are surfaced; neither is silently resolved.

## API

```ts
import { pack, groupsFromLines, splitDemand } from './src/packer.ts'

const result = pack({
  groups: [
    { id: 'DN-M', system: 'MAIN',      aeb: 10, ioExb: 5, com: 1 },
    { id: 'DN-R', system: 'REDUNDANT', aeb: 10, ioExb: 5, com: 1 },
  ],
  options: { maxExbSlots: 4, spareSlotPct: 0 },
})
// result.rackCount, result.backplaneCounts, result.psc, result.sparePsc,
// result.blankingTe, result.racks[].backplanes[].contents, result.warnings
```

`groupsFromLines({ dn, up }, 'DUAL')` builds the four-group shape;
`splitDemand(total, 'DUAL')` builds the two-group one. Both are conveniences
over the same `pack()`.

## Layout

| Path | |
|---|---|
| `src/types.ts` | Domain model, backplane geometry, the TE table |
| `src/decompose.ts` | Joint PWR/EXB decomposition for one group |
| `src/packer.ts` | Group handling, rack packing, the constraint |
| `src/cubicle.ts` | Cubicle allocation, fans, blanking plates |
| `scripts/extract_reference.py` | Recovers ground truth from the workbooks |
| `scripts/score.ts` | Location-by-location diff |
| `fixtures/reference.json` | 21 locations, reconciled to Gesamt with zero mismatches |

## Cubicle allocation — and a second latent conflict

`src/cubicle.ts` implements stage 3c. The capacities are **not in either
workbook**: they come from the handover sheet's `4. Project Questionnairre` cell
B151, a free-text guideline block.

| Cubicle | Part | Racks | IO-EXB |
|---|---|---|---|
| FAR-007 wall mount 15U | `101872` | 1 | 4 |
| FAR-004 half cubicle 20U | `101416` | 2 | 10 |
| FAR-002 floor standing 35U | `100002` | 4 | 20 |

**Two rules exist and they disagree.** The workbook computes `Gesamt` row 55 as
`ceil(racks / 6)`; the guideline caps a 35U at four racks. Six racks fit no
cubicle the catalogue sells.

The conflict is latent on this tender — no location exceeds four racks, and below
five both rules return one cubicle. It first bites at five racks, where capacity
needs two and the workbook still says one. Both numbers are computed and the
divergence is surfaced rather than decided. Structurally identical to the FDS
110-versus-150 finding: a real disagreement this project never exercises.

Also reproduced deliberately: the slot-fan step table (`floor(racks / 2)`) has no
branch beyond eight racks, so a ninth silently books **zero** fans instead of
four. `slotFans(9) === 0` is a test, not a bug in this module.

## Not built

The per-board current model that feeds the 120 W active-fan threshold. The
packer takes `powerWatts` as an input instead. Deriving it needs the per-board
current table and voltage lookup around `Gesamt!AI69:AT101`, which is a separate
piece of work from packing.
