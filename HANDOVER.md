# Handover — build manual input capture in the UI

Paste this whole file as the opening message of the next session.

---

## The task

Today the only way to get a project into the tool is to upload the Bid Process
Sheet, from which `demo/src/import.ts` parses the `16.DP TS details` tab.

**Build a UI path that gathers the same input by hand**, so a bid engineer can
start a project without that workbook. File import stays — it works and it is
covered by tests — this is a second route to the same place.

Both routes must produce the identical `Project` shape, so everything downstream
(packing, rules, BoQ, diff) is untouched.

### Why this is worth doing

The source sheet is not a reliable primary. Evidence gathered this session:

- Cell `E13` reads **"To Match the Quantity"** next to the Sheodaspura row — the
  DP table was back-fitted to make totals land on 374 / 550
- Its own `No of Location` says 18; the calculators carry 21 location sheets
- It refers work to "Sheet No 17" in five places. There is no sheet 17

### The opportunity — do not just replicate the sheet

Three known gaps exist *because* the sheet cannot express something. Manual entry
can, and each one closes a difference against the submitted BoQ:

| Gap | Today | What manual entry could capture |
|---|---|---|
| Racks 66 vs 68 | Devpura and Snaganer pack as one location each | **Equipment rooms per station.** The workbook gives them two Gesamt columns; the sheet has no field for it |
| Application type | Inferred from scope — Yard→station, ABS→auto block | Declared per location. It drives the cable-length mix, and IBH / absolute block are never reachable today |
| Cable split 369 vs 350 | Falls back to the questionnaire percentages | **Actual run lengths.** With them, the guideline rule should be switched *off*, not overridden line by line |

Treat the last one carefully: if real lengths are entered, `K01`/`K02`/`K03`
should go dormant rather than produce a number someone then overrides.

---

## Where things are

Repo: **https://github.com/ShreshthMi/BoQ_Calculator** (private, `main`).

```
app/              React + TS browser app. THIS IS WHERE THE WORK GOES
demo/src/         the pipeline — import, engine, boq, cable, aliases, expr
demo/src/node-io.ts   THE ONLY MODULE THAT TOUCHES THE FILESYSTEM
packer/src/       decomposition, packing, cubicles. Zero dependencies
Rule Map/         57 rules (rules.seed.json), the mapping doc, fixtures
Part Catalogue/   141-part master (parts.json)
BOM CAL/          source workbooks — inputs, never modified
```

Read `README.md`, then `demo/README.md` and `packer/README.md`. They carry the
reasoning, not just the API.

### Run and verify

```bash
cd app && npm install && npm run dev     # http://localhost:5173
cd packer && npm test                    # 90 tests, no install needed
cd demo && npm install && npm test       # 41 tests
cd demo && npm run demo                  # CLI: 11 match · 10 differ · 4 blank · 16 not produced
```

Node 24+ is required — TypeScript runs through type stripping, no build step.

---

## The shape you must produce

From `demo/src/import.ts`:

```ts
type Section  = { name: string; dn: LineCounts; up: LineCounts }
type LineCounts = { dp: number; ts: number }

type Location = {
  id: string
  name: string
  scope: 'ABS' | 'YARD'
  blockSections: string[]
  sections: Section[]        // per block section — NOT summed away
  detection: 'SINGLE' | 'DUAL'
  dn: LineCounts             // MAIN-side counts
  up: LineCounts
  totalDp: number            // includes redundancy
  totalTs: number
}

type Project = {
  source: string
  locations: Location[]
  totals: { dp: number; ts: number; locations: number }
  stated: Record<string, number>   // the sheet's own figures, for reconciliation
  warnings: string[]
}
```

Two traps in there:

**`sections` must survive.** Durgapura and Sanganer each sit on two block
sections. `engine.ts:groupsFor` groups per section, and that is what makes their
rack count come out at 3 rather than 2. Sum the sections away and you break it.

**`totalDp` / `totalTs` include redundancy**; `dn` / `up` are MAIN-side only.
Under `DUAL`, total = (dn + up) × 2. The Locations screen edit handler in
`App.tsx` already maintains both, plus `project.totals` — copy that behaviour.

---

## Domain facts already recovered — do not re-derive these

This is the expensive part of the previous session. All are verified against the
workbooks.

**Backplane geometry**
```
BP-PWR-n : one 8 TE PSC slot + n slots of 4 TE (AEB *or* COM)  => 8 + 4n TE
BP-EXB-n : one 4 TE slot holding an AEB + n slots of 6 TE (IO) => 4 + 6n TE
```
Every BP-EXB carries an AEB. That couples the two decompositions and is the
crux of the packer. TE pitch: PSC 8, AEB/COM 4, IO-EXB 6. Rack BGT07 = 84 TE.

**Evaluation groups** are the unit of separation. Each has its own ZP numbering
restarting at 1. A group owns its backplanes outright — verified, zero
backplanes mix groups across all 21 reference locations — while racks freely
share them. The grid does **not** record which group is main and which
redundant; `SystemId` is a caller-supplied label the packer never branches on.

**COM = one per evaluation group.** A COM board is one CAN segment;
`Gesamt!AI88` "Redundancy COM" is set, so each segment carries one per system.
Exact at 17 of 21 locations; the four exceptions omit the redundant board, so
the shipped BoQ under-books 4.

**PSC is not derivable.** Guideline item 1: *"PSC quantity can be decided as per
technical requirement."* One per group on ABS, more on Yard. It is an input.

**IO-EXB = ceil(TS / 2) per GROUP**, not per location. Per group gives 244 and
matches the workbook at every location; per location gives 237.

**Single detection caps at BP-EXB-2.** Dual allows BP-EXB-4. Yard books zero
BP-EXB-4 across thirteen locations; ABS books ten.

**Cable-length split** — handover questionnaire cell `B151` item 16:

| Application | 5 m | 10 m | 15 m |
|---|---|---|---|
| Station — single, or main half of dual | 75 % | 15 % | 10 % |
| Station — redundant half of dual | — | 75 % | 25 % |
| Auto block | 50 % | 50 % | — |
| IBH / absolute block — single | 100 % | — | — |
| IBH / absolute block — dual | 50 % | 50 % | — |

**FDS divisor is 110**, per the Bid team. The workbook reads `/150` in all 60
location sheets — a latent defect this tender never exposes.

**Rule scope**: rules are location-scoped by default and summed, because Gesamt
computes per column then totals. `ceil(550/25)` is 22; the sum of
`ceil(dp/25)` over 18 locations is 32. `PART_REF` rules are project-scoped so
they see the override layer.

Cell `B151` holds **24 numbered guidelines**; four have been mined (item 16 for
cable, items 1 and 6–8 for cubicle capacities). Items 17, 18 and 19 read like
rules too.

---

## Principles that must not be broken

These were decided deliberately and are load-bearing.

1. **Blank is never zero.** A rule that cannot resolve produces a flagged blank.
   A zero in a BoQ reads as a real answer of "none required".
2. **Provenance on every line** — `derived` / `override` / `stale` / `manual` /
   `blank` / `dormant`.
3. **`driverSnapshot` is never recomputed.** It records the derived value at the
   moment an override was entered. That is the only reason staleness is
   detectable. `BoqLine.derived` is the bare main quantity, excluding spare —
   including spare made every override read stale on entry.
4. **Overrides feed forward.** `part(BD005)` resolves against the override layer,
   so a 5 % spare is 5 % of what is actually bought.
5. **Do not invent rules to close a gap.** Where the tool and the tender
   disagree, surface both. Several differences are the tender being wrong.
6. **Do not tune the packer to match.** Report differences; the human layout is
   not necessarily optimal.
7. **`packer/` stays dependency-free**, and nothing outside `node-io.ts` may
   import `node:fs` — the app bundles the pipeline for the browser.
8. **No `eval`.** `demo/src/expr.ts` is a hand-written parser; extend it rather
   than reaching for something dynamic.
9. **Never modify the workbooks in `BOM CAL/`.**

---

## Still open — seven differences against the submitted BoQ

Listed with figures in `demo/README.md`. Manual input may close the first two.

| Line | Shipped | Ours | |
|---|---|---|---|
| Kit 4.8 / 9.8 m | 350 / 163 | 369 / 144 | hand adjustment, unexplained |
| Racks · EXB-1 · EXB-2 | 68 · 27 · 92 | 66 · 26 · 91 | Devpura + Snaganer siting |
| Backplane connector | 244 | 248 | BD BOM formula defect; Gesamt says 251 |
| Supply board PSC | 61 | 46 | planner decision, not derivable |
| COM-AdC | 42 | 46 | four redundant boards omitted |
| FDS102 | 12 | 18 | rule says one per location |
| Cubicle | 22 | 18 | `ceil(racks/6)` vs capacity table |

---

## Suggested approach

1. Read `demo/src/import.ts` and `app/src/App.tsx` first — the `InputScreen` and
   its edit handler are the closest existing thing.
2. Add a builder in `demo/src/` that constructs a `Project` from plain entered
   data, next to `importProjectFromBuffer` and sharing its reconciliation
   warnings. Keep it pure — no DOM, no fs — so the CLI and tests can use it.
3. Extend the Workbook screen into a choice: upload a sheet, or start empty.
4. Add and remove locations, edit every field, and derive `totalDp` / `totalTs`
   rather than asking for them.
5. Consider capturing application type and equipment rooms per location while
   you are there; both close real gaps.
6. Add tests to `demo/test/pipeline.test.ts` — the manual route should reproduce
   the same 550 DP / 66 racks when given the reference project's numbers. That
   is the strongest possible check that the two routes agree.
7. Project state already exports as JSON via `exportProject`; make sure a
   manually built project round-trips through it.
