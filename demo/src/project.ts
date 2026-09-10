/**
 * The project as data — the shape every input route has to produce.
 *
 * There are two routes in. `import.ts` reads the Bid Process Sheet; the builder
 * here takes plain entered data. They must land on the same `Project`, because
 * everything downstream — grouping, packing, the rule engine, the BoQ, the diff —
 * reads only this shape and must not care which door the numbers came through.
 *
 * So the types, the derivations and the reconciliation checks live here, and both
 * routes call them. This module has NO dependencies: no xlsx, no fs, no DOM. That
 * is what lets the builder run in the browser, in the CLI and in a test.
 *
 * WHY A MANUAL ROUTE AT ALL. The source sheet is not a reliable primary. Cell
 * `E13` of `16.DP TS details` reads "To Match the Quantity" beside the
 * Sheodaspura row — the table was back-fitted so the totals would land on
 * 374/550. Its own `No of Location` says 18 while the calculators carry 21
 * location sheets. It refers work to a "Sheet No 17" that does not exist. And it
 * cannot express three things the tender clearly depended on: equipment rooms,
 * application type, and measured cable runs. Each of those is a field here.
 */

export type Detection = 'SINGLE' | 'DUAL'

export type Scope = 'ABS' | 'YARD'

/**
 * What the location IS, which is what selects the cable-length mix.
 *
 * Handover questionnaire `B151` item 16 gives the mix per application, not per
 * scope. Reading it off the scope — Yard means station, ABS means auto block —
 * is right on this tender and unreachable for the other two applications, so it
 * is a default here rather than a derivation.
 */
export type Application = 'STATION' | 'AUTO_BLOCK' | 'IBH' | 'ABSOLUTE_BLOCK'

export const APPLICATIONS: Application[] = ['STATION', 'AUTO_BLOCK', 'IBH', 'ABSOLUTE_BLOCK']

export const APPLICATION_LABEL: Record<Application, string> = {
  STATION: 'Station',
  AUTO_BLOCK: 'Auto block',
  IBH: 'IBH',
  ABSOLUTE_BLOCK: 'Absolute block',
}

export type LineCounts = { dp: number; ts: number }

/** One block section's worth of a location. ABS locations can sit on two. */
export type Section = { name: string; dn: LineCounts; up: LineCounts }

/**
 * An equipment room.
 *
 * A room is where racks actually stand, and racks cannot span two of them. The
 * calculators carry 21 location sheets against the input sheet's 18 locations
 * because three Yard stations — Devpura, Snaganer and Durgapura — put their
 * down and up lines in separate rooms, each with its own sheet, its own column
 * in `Gesamt` and its own racks.
 *
 * That is why the room, not the administrative location, is the evaluation
 * column: `Gesamt` computes every row per column and totals across. Declaring
 * one therefore moves every location-scoped rule, not only the rack line — the
 * cubicles, the testing plates, the service displays, the planning and the FDS
 * are all asked once per room. It is also a CAN-segment boundary, so a station
 * small enough to fold its two directions into one evaluation group gains a
 * second group when it is split, and with it a second COM board.
 *
 * A location always has at least one room. One room is the ordinary case and
 * behaves exactly as though rooms had never been modelled.
 */
export type Room = { name: string; sections: Section[] }

/** Measured detection points by tail-cable length, when a cable plan exists. */
export type CableCounts = { m5: number; m10: number; m15: number }

/**
 * Where the cable-length split comes from.
 *
 * `guideline` applies the questionnaire's percentages. `measured` uses counts
 * entered per location and does not consult the guideline at all — which is the
 * point. A real cable plan should switch the guideline off rather than be
 * applied over the top of it line by line.
 */
export type CableSource = 'guideline' | 'measured'

export type Location = {
  id: string
  name: string
  scope: Scope
  blockSections: string[]
  /**
   * Per-block-section counts, kept rather than summed away. Durgapura and
   * Sanganer each sit on two sections, and the workbook gives each section its
   * own evaluation system, so the split has to survive.
   *
   * Derived: the concatenation of every room's sections, in room order.
   */
  sections: Section[]
  /** Equipment rooms. Always at least one. */
  rooms: Room[]
  detection: Detection
  application: Application
  /** MAIN-side counts per direction. Redundant mirrors them under DUAL. */
  dn: LineCounts
  up: LineCounts
  /** Totals including redundancy — what the BoQ ultimately books. */
  totalDp: number
  totalTs: number
  /** Measured cable runs, when the project has a cable plan. */
  cable: CableCounts | null
}

export type Project = {
  source: string
  locations: Location[]
  totals: { dp: number; ts: number; locations: number; rooms: number }
  /** The source document's own stated figures, for reconciliation. */
  stated: Record<string, number>
  cableSource: CableSource
  warnings: string[]
}

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

/** ABS rows carry a redundant system; Yard rows do not. */
export const defaultDetection = (scope: Scope): Detection =>
  (scope === 'ABS' ? 'DUAL' : 'SINGLE')

/** What `cable.ts` inferred from the scope before application became a field. */
export const defaultApplication = (scope: Scope): Application =>
  (scope === 'ABS' ? 'AUTO_BLOCK' : 'STATION')

// ---------------------------------------------------------------------------
// the input shape — plain entered data, no derived fields
// ---------------------------------------------------------------------------

export type SectionInput = { name?: string; dn: LineCounts; up: LineCounts }

export type RoomInput = { name?: string; sections: SectionInput[] }

export type LocationInput = {
  id?: string
  name: string
  scope: Scope
  detection?: Detection
  application?: Application
  blockSections?: string[]
  /** Equipment rooms. Omit for the ordinary one-room case and give `sections`. */
  rooms?: RoomInput[]
  /** The single room's sections. Ignored when `rooms` is given. */
  sections?: SectionInput[]
  cable?: CableCounts | null
}

export type ProjectInput = {
  source?: string
  locations: LocationInput[]
  /** Figures the tender or the source sheet states, to reconcile against. */
  stated?: Record<string, number>
  cableSource?: CableSource
  /**
   * Observations about the SOURCE DOCUMENT — malformed headers, a row whose
   * MAIN column disagrees with its own DN + UP. They are facts about a sheet, not
   * about the data, so they survive editing rather than being recomputed.
   */
  sourceWarnings?: string[]
}

// ---------------------------------------------------------------------------
// derivation
// ---------------------------------------------------------------------------

const zero = (): LineCounts => ({ dp: 0, ts: 0 })

/**
 * A count is a whole number of things, and never fewer than none.
 *
 * `Math.trunc(NaN)` is NaN and `Math.max(0, NaN)` is NaN, so the finite check is
 * doing real work: a NaN reaching `totalDp` would poison every total and every
 * driver downstream of it, and arrive in the BoQ as a blank with no explanation
 * anyone could act on.
 */
const whole = (v: unknown): number =>
  (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)

const counts = (c: LineCounts | undefined): LineCounts => ({
  dp: whole(c?.dp),
  ts: whole(c?.ts),
})

/**
 * How many runs a cable measurement accounts for.
 *
 * Zero means the same thing as no measurement at all: nobody has counted yet.
 * Treating an all-zero entry as a real answer of "no cable" is exactly the
 * silent zero the rest of this tool refuses to book.
 */
export const cableTotal = (c: CableCounts | null | undefined): number =>
  (c ? c.m5 + c.m10 + c.m15 : 0)

export const sumCounts = (list: LineCounts[]): LineCounts => ({
  dp: list.reduce((a, c) => a + c.dp, 0),
  ts: list.reduce((a, c) => a + c.ts, 0),
})

/** Redundancy multiplier. Under DUAL the redundant system mirrors the main one. */
export const systemsOf = (detection: Detection): number => (detection === 'DUAL' ? 2 : 1)

/**
 * Fill in everything a `Location` derives from its rooms.
 *
 * `dn` / `up` are MAIN-side sums across every section of every room; the totals
 * add redundancy on top. Nothing downstream should ever compute these itself —
 * the Locations screen edits rooms and calls back through here.
 */
export function deriveLocation(
  base: Omit<Location, 'sections' | 'dn' | 'up' | 'totalDp' | 'totalTs'>,
): Location {
  const sections = base.rooms.flatMap((r) => r.sections)
  const dn = sumCounts(sections.map((s) => s.dn))
  const up = sumCounts(sections.map((s) => s.up))
  const mult = systemsOf(base.detection)
  return {
    ...base,
    sections,
    dn,
    up,
    totalDp: (dn.dp + up.dp) * mult,
    totalTs: (dn.ts + up.ts) * mult,
  }
}

export function deriveTotals(locations: Location[]): Project['totals'] {
  return {
    dp: locations.reduce((a, l) => a + l.totalDp, 0),
    ts: locations.reduce((a, l) => a + l.totalTs, 0),
    locations: locations.length,
    rooms: locations.reduce((a, l) => a + l.rooms.length, 0),
  }
}

// ---------------------------------------------------------------------------
// reconciliation — the same checks whichever route produced the locations
// ---------------------------------------------------------------------------

/**
 * Compare what the locations add up to against what the source states.
 *
 * The stated figures are read back as a CHECK, never trusted: the sheet's own
 * `No of Location` is wrong, and its DP table was adjusted by hand to make the
 * totals land. A disagreement is reported, not resolved.
 */
export function reconcile(
  locations: Location[],
  stated: Record<string, number>,
): string[] {
  const warnings: string[] = []
  const abs = locations.filter((l) => l.scope === 'ABS')
  const yard = locations.filter((l) => l.scope === 'YARD')
  const sum = (ls: Location[], f: (l: Location) => number) => ls.reduce((a, l) => a + f(l), 0)

  const checks: [string, number][] = [
    ['Total DP ABS', sum(abs, (l) => l.totalDp)],
    ['Total TS ABS', sum(abs, (l) => l.totalTs)],
    ['Total DP YARD', sum(yard, (l) => l.totalDp)],
    ['Total TS YARD', sum(yard, (l) => l.totalTs)],
    ['Total DP', sum(locations, (l) => l.totalDp)],
    ['Total TS', sum(locations, (l) => l.totalTs)],
    ['No of Location', locations.length],
  ]
  for (const [label, got] of checks) {
    const want = stated[label]
    if (want != null && got !== want) {
      warnings.push(`${label}: ${got} from the locations, ${want} stated`)
    }
  }
  return warnings
}

/**
 * A name for one location that is unambiguous within its project.
 *
 * Names repeat legitimately: this tender carries a Durgapura and a Sheodaspura
 * in BOTH the Yard and the ABS block, as different pieces of equipment at the
 * same place. A warning that says only "Durgapura" sends someone to the wrong
 * row, so the scope is added when — and only when — the name is shared.
 */
export function locationLabel(loc: Location, all: Location[]): string {
  const name = loc.name.trim() || loc.id
  const shared = all.filter((l) => (l.name.trim() || l.id) === name).length > 1
  return shared ? `${name} (${loc.scope})` : name
}

/**
 * Checks on the data itself, independent of any stated total.
 *
 * These are the mistakes hand entry makes: a location typed twice, a location
 * carrying no detection points at all, a cable plan that does not add up. Each
 * is reported rather than corrected.
 */
export function validate(locations: Location[], cableSource: CableSource): string[] {
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const l of locations) {
    const label = locationLabel(l, locations)
    const key = `${l.scope}:${l.name.toLowerCase()}`
    if (l.name && seen.has(key)) {
      warnings.push(`${l.name}: two ${l.scope} locations share this name`)
    }
    seen.add(key)
    if (!l.name.trim()) warnings.push(`${l.id}: location has no name`)
    if (l.totalDp === 0 && l.totalTs === 0) {
      warnings.push(`${label}: no detection points or track sections entered`)
    }
    // Only worth saying where there is more than one room: for a single room it
    // would just repeat the line above in different words.
    if (l.rooms.length > 1) {
      for (const r of l.rooms) {
        if (r.sections.every((s) => s.dn.dp + s.up.dp + s.dn.ts + s.up.ts === 0)) {
          warnings.push(`${label} · ${r.name}: equipment room carries no boards`)
        }
      }
    }
    if (cableSource === 'measured' && l.totalDp > 0) {
      const total = cableTotal(l.cable)
      if (total === 0) {
        warnings.push(
          `${label}: cable lengths are measured for this project but none are ` +
          `counted here, so the trackside kit lines cannot be booked`,
        )
      } else if (total !== l.totalDp) {
        warnings.push(
          `${label}: cable runs total ${total} against ${l.totalDp} detection points`,
        )
      }
    }
  }
  return warnings
}

// ---------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------

const sectionOf = (s: SectionInput, fallbackName: string): Section => ({
  name: (s.name ?? '').trim() || fallbackName,
  dn: counts(s.dn),
  up: counts(s.up),
})

const cableOf = (c: CableCounts | null | undefined): CableCounts | null =>
  (c == null ? null : { m5: whole(c.m5), m10: whole(c.m10), m15: whole(c.m15) })

/**
 * Build a `Project` from plain entered data.
 *
 * Everything derivable is derived: section lists, direction sums, location and
 * project totals, ids. The caller supplies only what someone actually knows.
 * The result is byte-identical in shape to what `importProjectFromBuffer`
 * returns, which is the whole point — one downstream, two doors.
 */
export function buildProject(input: ProjectInput): Project {
  const cableSource: CableSource = input.cableSource ?? 'guideline'
  const perScope: Record<string, number> = { ABS: 0, YARD: 0 }
  // Ids carried in from a saved project are kept; anything else is minted from
  // the first free number for its scope. Removing a location and adding another
  // must not hand the new one an id the old one still holds — a duplicate id
  // silently re-points the rack view at the wrong station.
  const supplied = new Set(input.locations.map((l) => l.id).filter(Boolean) as string[])
  const used = new Set<string>()
  const mint = (scope: Scope) => {
    const prefix = scope === 'ABS' ? 'A' : 'Y'
    for (;;) {
      perScope[scope] = (perScope[scope] ?? 0) + 1
      const id = `${prefix}${String(perScope[scope]).padStart(2, '0')}`
      if (!supplied.has(id) && !used.has(id)) { used.add(id); return id }
    }
  }
  /** A supplied id is kept unless it is already spoken for by an earlier row. */
  const idOf = (li: LocationInput): string => {
    if (li.id && !used.has(li.id)) { used.add(li.id); return li.id }
    return mint(li.scope)
  }

  const locations = input.locations.map((li) => {
    const scope: Scope = li.scope
    const name = li.name.trim()
    const detection = li.detection ?? defaultDetection(scope)

    const roomInputs: RoomInput[] = li.rooms?.length
      ? li.rooms
      : [{ name, sections: li.sections ?? [{ dn: zero(), up: zero() }] }]

    // A location with one equipment room IS that room, so it carries the same
    // name — there is nothing to tell apart, and one fewer thing to fall out of
    // step when the location is renamed.
    const rooms: Room[] = roomInputs.map((r, ri) => {
      const roomName = roomInputs.length === 1
        ? name
        : ((r.name ?? '').trim() || `${name} Acc-${ri + 1}`)
      // An unnamed section takes the LOCATION's name, never the room's, however
      // many rooms there are. A room name belongs on the room. Falling back to
      // it here would break the round trip: `toInput` drops a section name that
      // equals the location's on the ground that it is re-derived, and it has to
      // be re-derived as the same thing. It compounds if it is not — the second
      // pass writes "X Acc-1"/"X Acc-2" into the input, `setRoomCount`'s
      // merge-by-name stops folding them, and merging back to one room leaves
      // two sections where there was one, doubling the evaluation groups.
      const sections = (r.sections.length ? r.sections : [{ dn: zero(), up: zero() }])
        .map((s) => sectionOf(s, name))
      return { name: roomName, sections }
    })

    // Block sections are the section names, so renaming a section moves them
    // together. Yard rows do not sit on a block section at all.
    const blockSections = li.blockSections
      ?? (scope === 'ABS'
        ? [...new Set(rooms.flatMap((r) => r.sections.map((s) => s.name)).filter(Boolean))]
        : [])

    return deriveLocation({
      id: idOf(li),
      name,
      scope,
      blockSections,
      rooms,
      detection,
      application: li.application ?? defaultApplication(scope),
      cable: cableOf(li.cable),
    })
  })

  const stated = input.stated ?? {}
  return {
    source: input.source ?? '(entered by hand)',
    locations,
    totals: deriveTotals(locations),
    stated,
    cableSource,
    warnings: [
      ...(input.sourceWarnings ?? []),
      ...validate(locations, cableSource),
      ...reconcile(locations, stated),
    ],
  }
}

/**
 * The inverse: a built project back to the data someone entered.
 *
 * `buildProject(toInput(p))` reproduces `p` exactly, which is what makes the
 * exported project state a genuine round trip rather than a snapshot.
 */
export function toInput(project: Project): ProjectInput {
  return {
    source: project.source,
    stated: { ...project.stated },
    cableSource: project.cableSource,
    sourceWarnings: sourceWarningsOf(project),
    // Names that merely echo the location, and block sections that merely echo
    // the section names, are left out: they are derived on the way back in, so
    // writing them down would only give them a chance to go stale.
    locations: project.locations.map((l) => ({
      id: l.id,
      name: l.name,
      scope: l.scope,
      detection: l.detection,
      application: l.application,
      rooms: l.rooms.map((r) => ({
        ...(l.rooms.length > 1 ? { name: r.name } : {}),
        sections: r.sections.map((s) => ({
          ...(s.name === l.name ? {} : { name: s.name }),
          dn: { ...s.dn },
          up: { ...s.up },
        })),
      })),
      cable: l.cable ? { ...l.cable } : null,
    })),
  }
}

/**
 * The warnings that came from the source document rather than from the data.
 *
 * Recomputable warnings are stripped so they are not carried twice; whatever is
 * left is an observation about a sheet, which no amount of editing can fix.
 */
function sourceWarningsOf(project: Project): string[] {
  const recomputed = new Set([
    ...validate(project.locations, project.cableSource),
    ...reconcile(project.locations, project.stated),
  ])
  return project.warnings.filter((w) => !recomputed.has(w))
}

// ---------------------------------------------------------------------------
// editing helpers — pure, so the UI has no arithmetic of its own
// ---------------------------------------------------------------------------

export function blankSection(name = ''): SectionInput {
  return { name, dn: zero(), up: zero() }
}

/**
 * A new location.
 *
 * The room and its section are left unnamed on purpose: an unnamed one takes
 * the location's name, so renaming the location renames them too instead of
 * leaving a stale copy of whatever it was first called.
 *
 * The id is minted HERE rather than by `buildProject`, and that matters. Ids
 * derived from array position are re-minted on every rebuild, so deleting a
 * location renumbers the ones after it — silently re-pointing the open detail
 * panel and the rack-layout selection at a different station. An id given at
 * creation travels with the row instead.
 */
export function blankLocation(scope: Scope, name = '', id?: string): LocationInput {
  return {
    id,
    name,
    scope,
    detection: defaultDetection(scope),
    application: defaultApplication(scope),
    rooms: [{ sections: [blankSection()] }],
    cable: null,
  }
}

/**
 * The first id not already spoken for in this scope.
 *
 * Callers mint an id when they create a location so it travels with the row.
 * `buildProject` will fill a gap, but only a gap — an id derived from array
 * position moves the moment a location above it is deleted.
 */
export function nextLocationId(locations: LocationInput[], scope: Scope): string {
  const taken = new Set(locations.map((l) => l.id).filter(Boolean) as string[])
  const prefix = scope === 'ABS' ? 'A' : 'Y'
  for (let n = 1; ; n++) {
    const id = `${prefix}${String(n).padStart(2, '0')}`
    if (!taken.has(id)) return id
  }
}

export function blankProject(): ProjectInput {
  return { source: '', locations: [], stated: {}, cableSource: 'guideline' }
}

/**
 * Set how many equipment rooms a location has, moving the demand with it.
 *
 * Splitting one room into two puts the DOWN line in the first and the UP line in
 * the second, which is what the three split Yard stations do — Devpura Acc-1
 * carries 22 boards against Acc-2's 29, exactly the down and up counts. Merging
 * back adds the sections up again by name. Neither ever loses a detection point.
 */
export function setRoomCount(loc: LocationInput, n: number): LocationInput {
  const wanted = Math.max(1, Math.trunc(n))
  const rooms = loc.rooms?.length
    ? loc.rooms
    : [{ name: loc.name, sections: loc.sections ?? [blankSection(loc.name)] }]
  if (wanted === rooms.length) return loc

  const named = (i: number) => (wanted === 1 ? loc.name : `${loc.name} Acc-${i + 1}`)

  if (wanted < rooms.length) {
    // Merge every room back into `wanted` of them, section by section on name.
    const merged: RoomInput[] = Array.from({ length: wanted }, (_, i) => ({
      name: named(i), sections: [] as SectionInput[],
    }))
    rooms.forEach((r, ri) => {
      const target = merged[Math.min(ri, wanted - 1)]!
      // Two sections of the SAME room are two block sections and stay two, even
      // where they share a name — which they do by default, since a section
      // nobody named takes the location's. Folding them would keep every
      // detection point and still delete an evaluation system, because
      // `groupsFor` makes one per section. Only sections from a DIFFERENT room
      // are candidates to merge into.
      const claimed = new Set<SectionInput>()
      for (const s of r.sections) {
        const key = (s.name ?? '').trim()
        const found = target.sections.find(
          (x) => !claimed.has(x) && (x.name ?? '').trim() === key,
        )
        if (found) {
          claimed.add(found)
          found.dn = { dp: found.dn.dp + s.dn.dp, ts: found.dn.ts + s.dn.ts }
          found.up = { dp: found.up.dp + s.up.dp, ts: found.up.ts + s.up.ts }
        } else {
          // Claimed as well as pushed. A section this room just contributed is
          // no more available to the room's NEXT section than one that was
          // already there — otherwise two sections of one room still fold.
          const fresh: SectionInput = { name: s.name, dn: { ...s.dn }, up: { ...s.up } }
          target.sections.push(fresh)
          claimed.add(fresh)
        }
      }
    })
    for (const r of merged) if (!r.sections.length) r.sections.push(blankSection(loc.name))
    return { ...loc, rooms: merged, sections: undefined }
  }

  // Growing. The first split moves UP out of room 1 and into room 2; any further
  // rooms start empty, because nothing says how to divide a line three ways.
  const grown: RoomInput[] = rooms.map((r, i) => ({
    name: named(i),
    sections: r.sections.map((s) => ({ name: s.name, dn: { ...s.dn }, up: { ...s.up } })),
  }))
  for (let i = rooms.length; i < wanted; i++) {
    const donor = i === 1 ? grown[0] : undefined
    grown.push({
      name: named(i),
      sections: (donor ?? grown[0]!).sections.map((s) => ({
        name: s.name,
        dn: donor ? zero() : zero(),
        up: donor ? { ...s.up } : zero(),
      })),
    })
    if (donor) for (const s of donor.sections) s.up = zero()
  }
  return { ...loc, rooms: grown, sections: undefined }
}
