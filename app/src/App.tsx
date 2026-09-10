import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { exportStyledBoq } from './export-xlsx.ts'
import {
  loadWorkbook, startEmpty, run, explain, exportProject, importProjectState, download,
  buildProject, blankLocation, blankSection, setRoomCount, nextLocationId,
  submittedOf, labelOf,
  APPLICATIONS, APPLICATION_LABEL,
  RULES, PART_ALIASES, DEFAULT_DECLARATIONS,
  type Loaded, type Declarations, type Override, type BoqLine, type LocationPlan,
  type Project, type ProjectInput, type LocationInput, type Application,
  type CableSource, type Detection, type Scope, type CableSplit,
} from './pipeline.ts'

type Screen = 'source' | 'setup' | 'input' | 'racks' | 'boq' | 'diff'

const TE_OF: Record<string, number> = {
  'PSC': 8, 'PSC-R': 8, 'spare-PSC': 8,
  'COM-AdC': 4, 'COM-xxx': 4, 'AEB': 4, 'leer': 4, 'spare': 4,
  'IO-EXB': 6, 'CO-EXB': 6, 'spare IO': 6,
}
const TE_CLASS: Record<string, string> = {
  'PSC': 'psc', 'PSC-R': 'psc', 'spare-PSC': 'blank', 'COM-AdC': 'com', 'COM-xxx': 'com',
  'AEB': 'aeb', 'IO-EXB': 'io', 'CO-EXB': 'io', 'leer': 'blank', 'spare': 'blank', 'spare IO': 'blank',
}
const nf = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-IN'))

/**
 * A number input in a dense grid must not change value on a stray scroll.
 * Losing focus first turns a wheel over the table back into scrolling the table.
 */
const noScroll = { onWheel: (e: WheelEvent<HTMLInputElement>) => e.currentTarget.blur() }

/**
 * What a count field commits.
 *
 * `buildProject` truncates and floors at zero on the way in, so an input holding
 * 7.9 shows 7 on the summary row (which reads the derived project) and 7.9 in
 * the detail table (which reads the raw input) — the same count, two numbers.
 * Coercing here means the input never holds a value the project cannot hold.
 */
const whole = (raw: string): number => {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

export default function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('source')
  const [decl, setDecl] = useState<Declarations>(DEFAULT_DECLARATIONS)
  const [overrides, setOverrides] = useState<Override[]>([])
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [locId, setLocId] = useState<string | null>(null)
  const [exportFeedback, setExportFeedback] = useState(0)
  const [checkpointFeedback, setCheckpointFeedback] = useState(0)
  /**
   * Bumped whenever a different project is opened. It keys the screen tree, so
   * the per-row override form state — which is local to a row and keyed by rule
   * id — cannot survive into a project where that rule holds a different number.
   */
  const [projectKey, setProjectKey] = useState(0)

  useEffect(() => {
    if (exportFeedback === 0) return
    const timeout = window.setTimeout(() => setExportFeedback(0), 1800)
    return () => window.clearTimeout(timeout)
  }, [exportFeedback])

  useEffect(() => {
    if (checkpointFeedback === 0) return
    const timeout = window.setTimeout(() => setCheckpointFeedback(0), 1800)
    return () => window.clearTimeout(timeout)
  }, [checkpointFeedback])

  // The project is BUILT from the entered data, never mutated. Editing replaces
  // the input and everything derived — totals, sections, warnings, the whole
  // BoQ — is computed again from it, so nothing can drift out of step.
  const project = useMemo(
    () => (loaded ? buildProject(loaded.input) : null),
    [loaded],
  )
  const result = useMemo(
    () => (project && loaded ? run(project, decl, overrides, submittedOf(loaded.origin)) : null),
    [project, loaded, decl, overrides],
  )

  const setInput = useCallback((next: ProjectInput) => {
    setLoaded((l) => (l ? { ...l, input: next } : l))
  }, [])

  const begin = useCallback((next: Loaded, decls?: Declarations, ovs?: Override[]) => {
    setLoaded(next)
    setDecl(decls ?? DEFAULT_DECLARATIONS)
    setOverrides(ovs ?? [])
    setLocId(null)
    setOpenLine(null)
    setProjectKey((k) => k + 1)
  }, [])

  const open = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      begin(await loadWorkbook(file))
      setScreen('boq')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [begin])

  const openState = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const s = importProjectState(await file.text())
      begin(s.loaded, s.declarations, s.overrides)
      setScreen('input')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [begin])

  const setOverride = useCallback((line: BoqLine, qty: number | null, reason: string) => {
    if (!line.partKey) return
    setOverrides((prev) => {
      const rest = prev.filter((o) => o.partKey !== line.partKey)
      if (qty === null) return rest
      const existing = prev.find((o) => o.partKey === line.partKey)
      return [...rest, {
        partKey: line.partKey!, qty,
        // Snapshot the derived value as it stands NOW and never recompute it —
        // that is the only way staleness can be detected later.
        driverSnapshot: existing ? existing.driverSnapshot : line.derived,
        reason, by: 'you', at: new Date().toISOString().slice(0, 10),
      }]
    })
  }, [])

  const stale = result?.lines.filter((l) => l.provenance === 'stale').length ?? 0
  const empty = project !== null && project.locations.length === 0

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="mark"><i /></span><b>BoQ Calculator</b></div>
        <div className="file">
          {loaded
            ? <><span>{labelOf(loaded)}</span><span>·</span>
                <span>{loaded.origin.kind === 'workbook' ? '16.DP TS details' : 'entered by hand'}</span></>
            : <span>no project open</span>}
          {stale > 0 && <span style={{ color: 'var(--warn)' }}>· {stale} stale override{stale === 1 ? '' : 's'}</span>}
        </div>
        {project && result && <>
          <div className="stat"><span>DP</span><b>{nf(project.totals.dp)}</b></div>
          <div className="stat"><span>Racks</span><b>{result.totals.racks}</b></div>
          {loaded?.origin.kind === 'workbook' && (
            <div className="stat"><span>Match</span>
              <b>{result.diff.summary['match'] ?? 0}/{submittedOf(loaded.origin).length}</b></div>
          )}
        </>}
        <div className="actions">
          <button className="btn" disabled={!loaded}
            onClick={() => { setLoaded(null); setOverrides([]); setScreen('source') }}>New</button>
        </div>
      </header>

      <div className="body">
        <nav>
          <div className="grp">Input</div>
          <NavBtn s="source" cur={screen} go={setScreen} label="Project source" hint={loaded ? '✓' : ''} />
          <NavBtn s="setup" cur={screen} go={setScreen} label="Declarations" disabled={!loaded} />
          <NavBtn s="input" cur={screen} go={setScreen} label="Locations" disabled={!loaded}
            hint={project ? String(project.totals.locations) : ''} />
          <div className="grp">Output</div>
          <NavBtn s="racks" cur={screen} go={setScreen} label="Rack layout" disabled={!loaded || empty}
            hint={result ? String(result.totals.racks) : ''} />
          <NavBtn s="boq" cur={screen} go={setScreen} label="Bill of Quantities"
            disabled={!loaded || empty} hint={result && !empty ? String(result.lines.length) : ''} />
          <NavBtn s="diff" cur={screen} go={setScreen} label="Diff vs submitted"
            disabled={!loaded || empty}
            hint={result && !empty ? String(result.diff.summary['match'] ?? 0) : ''} />
          {loaded && result && !empty && <>
            <div className="grp">Export</div>
            <button className="export-button" onClick={async () => {
              download('BoQ.xlsx', await exportStyledBoq(result.lines),
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
              setExportFeedback((feedback) => feedback + 1)
            }} aria-describedby={exportFeedback > 0 ? 'export-complete-status' : undefined}>
              BoQ spreadsheet
              {exportFeedback > 0 && <span key={exportFeedback} className="export-success-indicator" aria-hidden="true">✓</span>}
            </button>
            {exportFeedback > 0 && <span id="export-complete-status" className="sr-only" role="status" aria-live="polite">
              Export completed successfully.
            </span>}
            <button
              className="checkpoint"
              onClick={() => {
                download('project.json', exportProject(loaded, decl, overrides), 'application/json')
                setCheckpointFeedback((feedback) => feedback + 1)
              }}
              aria-describedby={checkpointFeedback > 0 ? 'checkpoint-complete-status' : undefined}
              title="Save checkpoint (project state JSON) — contains inputs, declarations and overrides."
            >
              <div className="checkpoint-mark"><i /></div>
              <div className="checkpoint-copy">
                Save checkpoint
                <span className="note">Snapshot of the current inputs</span>
              </div>
              {checkpointFeedback > 0 && <span key={checkpointFeedback} className="export-success-indicator" aria-hidden="true">✓</span>}
            </button>
            {checkpointFeedback > 0 && <span id="checkpoint-complete-status" className="sr-only" role="status" aria-live="polite">
              Checkpoint saved successfully.
            </span>}
          </>}
        </nav>

        <main key={projectKey}>
          {screen === 'source' && (
            <SourceScreen onFile={open} onState={openState} onEmpty={(name) => {
              begin(startEmpty(name)); setScreen('input')
            }} error={error} loaded={loaded} project={project} />
          )}
          {screen === 'setup' && loaded && <SetupScreen decl={decl} setDecl={setDecl} />}
          {screen === 'input' && loaded && project && result && (
            <InputScreen input={loaded.input} setInput={setInput} project={project}
              plans={result.plans} cable={result.cable} />
          )}
          {screen === 'racks' && result && (
            <RackScreen plans={result.plans} locId={locId} setLocId={setLocId} />
          )}
          {screen === 'boq' && result && !empty && (
            <BoqScreen result={result} openLine={openLine} setOpenLine={setOpenLine}
              overrides={overrides} setOverride={setOverride} />
          )}
          {screen === 'diff' && result && loaded && !empty && (
            <DiffScreen result={result} origin={loaded.origin} />
          )}
          {(screen === 'boq' || screen === 'diff' || screen === 'racks') && empty && (
            <>
              <h1>Nothing to bill yet</h1>
              <p className="lede">This project has no locations, so there is no demand to derive
              anything from. Every line would be a question rather than a quantity — and the tool
              does not answer a question it has not been asked with a zero.</p>
              <button className="btn pri" onClick={() => setScreen('input')}>Add locations</button>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

/**
 * Warnings, capped.
 *
 * Every one is worth reading, but eighteen identical boxes stop being read at
 * all. The rest are counted rather than dropped, and the count is the prompt to
 * open them.
 */
function Warnings({ list, cap = 6 }: { list: string[]; cap?: number }) {
  const [all, setAll] = useState(false)
  if (list.length === 0) return null
  const shown = all ? list : list.slice(0, cap)
  return (
    <>
      {shown.map((w, i) => <div className="warnbox" key={`${i}-${w}`}>{w}</div>)}
      {list.length > cap && (
        <p className="lede" style={{ marginTop: -6, fontSize: 12.5 }}>
          <button className="link" onClick={() => setAll(!all)}>
            {all ? 'show fewer' : `${list.length - cap} more warning${list.length - cap === 1 ? '' : 's'}`}
          </button>
        </p>
      )}
    </>
  )
}

function NavBtn({ s, cur, go, label, hint, disabled }: {
  s: Screen; cur: Screen; go: (s: Screen) => void
  label: string; hint?: string; disabled?: boolean
}) {
  return (
    <button aria-current={cur === s} disabled={disabled} onClick={() => go(s)}>
      {label}{hint ? <em>{hint}</em> : null}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* 1. where the project comes from                                            */
/* -------------------------------------------------------------------------- */
function SourceScreen({ onFile, onState, onEmpty, error, loaded, project }: {
  onFile: (f: File | undefined) => void
  onState: (f: File | undefined) => void
  onEmpty: (name: string) => void
  error: string | null
  loaded: Loaded | null
  project: Project | null
}) {
  const [over, setOver] = useState(false)
  const [name, setName] = useState('')
  const sheet = useRef<HTMLInputElement>(null)
  const state = useRef<HTMLInputElement>(null)
  return (
    <>
      <h1>Start a project</h1>
      <p className="lede">Two ways in, one project. The Bid Process Sheet carries the detection
      points and track sections on its <code>16.DP TS details</code> tab, and where it also holds a
      submitted BoQ that is read too, so the generated one can be diffed against it. Or enter the
      locations by hand — the sheet is not a reliable primary, and there are three things it cannot
      say at all. Nothing leaves this machine either way.</p>

      <div className="choice">
        <div className={`drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]) }}>
          <h2>Drop the workbook here</h2>
          <p>or choose a <code>.xlsx</code> / <code>.xlsm</code> file. Import reconciles against the
          sheet&rsquo;s own stated totals and reports what disagrees.</p>
          <button className="btn pri" onClick={() => sheet.current?.click()}>Choose file</button>
          <input ref={sheet} type="file" accept=".xlsx,.xlsm,.xls" hidden
            onChange={(e) => onFile(e.target.files?.[0])} />
        </div>

        <div className="drop">
          <h2>Start with nothing</h2>
          <p>Add the locations yourself. Everything derivable is derived — totals, redundancy,
          groups, racks — so you enter only what someone actually knows.</p>
          <div className="startrow">
            <input type="text" value={name} placeholder="project name" aria-label="project name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onEmpty(name) }} />
            <button className="btn pri" onClick={() => onEmpty(name)}>Start empty</button>
          </div>
          <p className="dim" style={{ marginBottom: 0, fontSize: 12.5 }}>
            or <button className="link" onClick={() => state.current?.click()}>reopen a saved
            project state</button> exported from here earlier
          </p>
          <input ref={state} type="file" accept=".json" hidden
            onChange={(e) => onState(e.target.files?.[0])} />
        </div>
      </div>

      {error && <div className="warnbox"><b>Could not read that file.</b> {error}</div>}

      {loaded && project && (
        <>
          <h2>{loaded.origin.kind === 'workbook' ? `Read from ${loaded.origin.fileName}` : project.source}</h2>
          <div className="cards">
            <div><b>{project.totals.locations}</b><span>locations</span></div>
            <div><b>{project.totals.rooms}</b><span>equipment rooms</span></div>
            <div><b>{project.totals.dp}</b><span>detection points</span></div>
            <div><b>{project.totals.ts}</b><span>track sections</span></div>
            {loaded.origin.kind === 'workbook' &&
              <div><b>{loaded.origin.submitted.length}</b><span>submitted lines</span></div>}
          </div>
          {project.warnings.length > 0
            ? <Warnings list={project.warnings} />
            : project.locations.length > 0
              ? <p className="lede">Reconciles with the stated totals. No warnings.</p>
              : <p className="lede">Empty. Add locations on the Locations screen.</p>}
          {loaded.origin.kind === 'workbook' && loaded.origin.submittedError && (
            <div className="warnbox">No submitted BoQ in this workbook, so the diff is unavailable.
              Everything else works. <span className="dim">({loaded.origin.submittedError})</span></div>
          )}
          {loaded.origin.kind === 'workbook' && (
            <p className="lede" style={{ fontSize: 12.5 }}>
              The sheet has no field for an equipment room, an application type or a measured cable
              run. All three are on the Locations screen, and each one closes a difference against
              the BoQ that shipped.
            </p>
          )}
        </>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
function SetupScreen({ decl, setDecl }: {
  decl: Declarations; setDecl: (d: Declarations) => void
}) {
  const flag = (k: keyof Declarations, name: string, hint: string) => (
    <label key={k}>
      <span className="name">{name}</span>
      <span className="hint">{hint}</span>
      <span className="row">
        <input type="checkbox" checked={decl[k] as boolean}
          onChange={(e) => setDecl({ ...decl, [k]: e.target.checked })} />
        <span>{decl[k] ? 'on' : 'off — rules gated on this go dormant'}</span>
      </span>
    </label>
  )
  const num = (k: keyof Declarations, name: string, hint: string) => (
    <label key={k}>
      <span className="name">{name}</span>
      <span className="hint">{hint}</span>
      <span className="row">
        <input type="number" value={decl[k] as number} min={0}
          onChange={(e) => setDecl({ ...decl, [k]: Number(e.target.value) })} />
      </span>
    </label>
  )
  return (
    <>
      <h1>Declarations</h1>
      <p className="lede">Project-level answers the rules read. A switched-off declaration makes its
      rules <em>dormant</em> rather than zero — the workbook does the same thing with a blank tick
      cell, which is how 22 cubicles came to be typed by hand on a project whose cubicle rule was
      switched off.</p>
      <div className="decl">
        {flag('cubiclesEnabled', 'Cubicles', 'Gesamt!AI82. Gates cubicles, wiring, fans and planning.')}
        {flag('fdsRequired', 'FDS required', 'Gesamt!AI81. Gates the diagnostic system line.')}
        {flag('planningIncluded', 'Planning', 'Gesamt!AI83. Gates the three service lines.')}
        {flag('sparesIncluded', 'Spares', 'Gates the per-part spare percentages.')}
        {flag('powerAbove120W', 'Power over 120 W', 'Fits an active fan per cubicle.')}
        {num('comPerGroup', 'COM per group', 'One CAN segment per COM. Redundancy gives one per system.')}
        {num('pscPerGroup', 'PSC per group', '"Decided as per technical requirement" — guideline item 1.')}
        {num('dataTransmissionIO', 'Extra IO-EXB', 'Data-transmission allowance beyond ceil(TS/2).')}
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* 2. the locations — the editor both routes land on                          */
/* -------------------------------------------------------------------------- */
function InputScreen({ input, setInput, project, plans, cable }: {
  input: ProjectInput
  setInput: (i: ProjectInput) => void
  project: Project
  plans: LocationPlan[]
  cable: CableSplit
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  const patch = (i: number, fn: (l: LocationInput) => LocationInput) => {
    setInput({ ...input, locations: input.locations.map((l, j) => (j === i ? fn(l) : l)) })
  }
  const add = (scope: Scope) => {
    const n = input.locations.filter((l) => l.scope === scope).length + 1
    // The id is minted here so it belongs to this row for good. Derived from
    // position instead, it would move when a location above is deleted — and
    // the open detail panel and the rack-layout selection both find a location
    // by id, so they would quietly start pointing at a different station.
    setInput({
      ...input,
      locations: [...input.locations, blankLocation(
        scope,
        `${scope === 'ABS' ? 'Block' : 'Station'} ${n}`,
        nextLocationId(input.locations, scope),
      )],
    })
  }
  const remove = (i: number) => {
    setInput({ ...input, locations: input.locations.filter((_, j) => j !== i) })
  }

  return (
    <>
      <h1>Locations</h1>
      <p className="lede">Everything derivable is derived: the direction sums, the redundant system,
      the totals, the evaluation groups and the racks. Edit anything and the whole BoQ re-derives —
      including any override entered against the old value, which will flag stale.</p>

      <div className="toolbar">
        <button className="btn" onClick={() => add('YARD')}>+ Yard station</button>
        <button className="btn" onClick={() => add('ABS')}>+ Auto-block location</button>
        <span className="sep" />
        <span className="tlabel">Cable runs</span>
        <select value={input.cableSource ?? 'guideline'} aria-label="cable length source"
          onChange={(e) => setInput({ ...input, cableSource: e.target.value as CableSource })}>
          <option value="guideline">Estimated from the guideline</option>
          <option value="measured">Measured from the cable plan</option>
        </select>
        <span className="grow" />
        <span className="tlabel">{project.totals.dp} DP · {project.totals.ts} TS ·{' '}
          {project.totals.locations} locations · {project.totals.rooms} rooms</span>
      </div>

      <CablePanel cable={cable} />

      <StatedPanel input={input} setInput={setInput} project={project} />

      <Warnings list={project.warnings} />

      {project.locations.length === 0 ? (
        <div className="drop" style={{ padding: '38px 30px' }}>
          <h2>No locations yet</h2>
          <p>Add a Yard station or an auto-block location to begin. A Yard station is single
          detection and a station application; an ABS location is dual detection and auto block.
          Both are defaults you can change per location.</p>
        </div>
      ) : (
        <div className="scroll"><table className="loct">
          <thead><tr>
            <th>Location</th><th>Scope</th><th>Detection</th><th>Application</th>
            <th className="num">Rooms</th>
            <th className="num">DN DP</th><th className="num">DN TS</th>
            <th className="num">UP DP</th><th className="num">UP TS</th>
            <th className="num">Total DP</th><th className="num">Total TS</th>
            <th className="num">Groups</th><th className="num">Racks</th><th />
          </tr></thead>
          <tbody>
            {project.locations.map((l, i) => {
              const li = input.locations[i]!
              const plan = plans[i]!
              const simple = l.rooms.length === 1 && l.sections.length === 1
              const isOpen = openId === l.id
              return (
                <LocationRows
                  key={l.id} loc={l} li={li} plan={plan} simple={simple} isOpen={isOpen}
                  measured={(input.cableSource ?? 'guideline') === 'measured'}
                  onToggle={() => setOpenId(isOpen ? null : l.id)}
                  patch={(fn) => patch(i, fn)} remove={() => remove(i)}
                />
              )
            })}
          </tbody>
        </table></div>
      )}

      <p className="lede" style={{ marginTop: 14, fontSize: 12.5 }}>
        Open a location to edit its block sections, split it across equipment rooms, or enter
        measured cable runs. A location on more than one block section is read-only in the table
        above, because its counts are per section and summing them away would lose the split.
        A rack cannot span two equipment rooms &mdash; which is why the reference project&rsquo;s
        calculators carry 21 location sheets against an input sheet of 18 rows.
      </p>
    </>
  )
}

/**
 * What the tender states, to reconcile the entered locations against.
 *
 * This is the manual route's equivalent of the input sheet's own summary block
 * at N22:O28, and it is the single most valuable thing hand entry would
 * otherwise give up. The figures are never used as a source — they are read back
 * as a check, and a disagreement is reported rather than resolved. Leaving them
 * blank is allowed and is not the same as agreement.
 */
function StatedPanel({ input, setInput, project }: {
  input: ProjectInput
  setInput: (i: ProjectInput) => void
  project: Project
}) {
  const [open, setOpen] = useState(false)
  const stated = input.stated ?? {}
  const set = (k: string, v: string) => {
    const next = { ...stated }
    if (v.trim() === '') delete next[k]
    else next[k] = Math.max(0, Number(v) || 0)
    setInput({ ...input, stated: next })
  }
  const FIELDS: [string, number][] = [
    ['Total DP', project.totals.dp],
    ['Total TS', project.totals.ts],
    ['No of Location', project.totals.locations],
  ]
  const given = FIELDS.filter(([k]) => stated[k] != null).length
  return (
    <div className="statedbox">
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'hide' : 'what the tender states'}
      </button>
      <span className="dim">
        {given === 0
          ? ' — nothing stated, so nothing is being checked against'
          : ` — ${given} figure${given === 1 ? '' : 's'} reconciled on every edit`}
      </span>
      {open && (
        <div className="cablerow" style={{ marginTop: 8 }}>
          {FIELDS.map(([k, got]) => (
            <label key={k}>
              <span>{k}</span>
              <input type="number" min={0} value={stated[k] ?? ''} placeholder={String(got)}
                aria-label={`stated ${k}`} {...noScroll}
                onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <span className="dim" style={{ fontSize: 12 }}>
            entered: {FIELDS.map(([, got]) => got).join(' · ')}
          </span>
        </div>
      )}
    </div>
  )
}

function CablePanel({ cable }: { cable: CableSplit }) {
  const measured = cable.source === 'measured'
  const moved = measured && cable.m5 !== null
    && (cable.m5 !== cable.guideline.m5 || cable.m10 !== cable.guideline.m10)
  return (
    <div className="calc">
      <b>Cable-length split</b> &nbsp; 5 m <b>{nf(cable.m5)}</b> &nbsp; 10 m <b>{nf(cable.m10)}</b>
      &nbsp; 15 m <b>{nf(cable.m15)}</b>
      <span className="dim">
        {measured
          ? cable.m5 === null
            ? ' — measured, but the plan is not finished, so the three kit lines are blank rather'
              + ` than guessed: ${cable.unmeasured.length} location`
              + `${cable.unmeasured.length === 1 ? '' : 's'} with no runs counted`
              + (cable.mismatched.length
                ? ` and ${cable.mismatched.length} whose runs do not add up to their detection points`
                : '')
            : ' — counted from the cable plan. The guideline is switched off, not overridden.'
          : ' — questionnaire B151 item 16, applied per application type: station 75/15/10,'
            + ' auto block 50/50, IBH single all 5 m'}
      </span>
      {(measured) && (
        <div className="dim">
          guideline would say {cable.guideline.m5} / {cable.guideline.m10} / {cable.guideline.m15}
          {moved ? ' — the difference is what the cable plan actually measured' : ''}
        </div>
      )}
    </div>
  )
}

function LocationRows({ loc, li, plan, simple, isOpen, measured, onToggle, patch, remove }: {
  loc: Project['locations'][number]
  li: LocationInput
  plan: LocationPlan
  simple: boolean
  isOpen: boolean
  measured: boolean
  onToggle: () => void
  patch: (fn: (l: LocationInput) => LocationInput) => void
  remove: () => void
}) {
  /** Edit one direction of the single section of the single room, in place. */
  const cell = (dir: 'dn' | 'up', f: 'dp' | 'ts') => (
    <td className="num pad0">
      <input type="number" min={0} value={loc.sections[0]![dir][f]} {...noScroll}
        aria-label={`${loc.name} ${dir.toUpperCase()} ${f.toUpperCase()}`}
        onChange={(e) => {
          const v = whole(e.target.value)
          patch((l) => withSection(l, 0, 0, (s) => ({ ...s, [dir]: { ...s[dir], [f]: v } })))
        }} />
    </td>
  )
  return (
    <>
      <tr className={isOpen ? 'sel' : ''}>
        <td className="pad0">
          <input type="text" value={li.name} aria-label="location name" className="wide"
            onChange={(e) => patch((l) => ({ ...l, name: e.target.value }))} />
          {loc.blockSections.length > 1 &&
            <span className="note">{loc.blockSections.join(' + ')}</span>}
        </td>
        <td className="pad0">
          <select value={loc.scope} aria-label="scope"
            onChange={(e) => patch((l) => ({ ...l, scope: e.target.value as Scope }))}>
            <option value="YARD">Yard</option><option value="ABS">ABS</option>
          </select>
        </td>
        <td className="pad0">
          <select value={loc.detection} aria-label="detection"
            onChange={(e) => patch((l) => ({ ...l, detection: e.target.value as Detection }))}>
            <option value="SINGLE">Single</option><option value="DUAL">Dual</option>
          </select>
        </td>
        <td className="pad0">
          <select value={loc.application} aria-label="application"
            onChange={(e) => patch((l) => ({ ...l, application: e.target.value as Application }))}>
            {APPLICATIONS.map((a) => <option key={a} value={a}>{APPLICATION_LABEL[a]}</option>)}
          </select>
        </td>
        <td className="num pad0">
          <input type="number" min={1} max={4} value={loc.rooms.length} {...noScroll}
            aria-label="equipment rooms"
            onChange={(e) => {
              // `Number('') || 1` would read the transient empty value every
              // retype produces as "one equipment room" and merge a hand-tuned
              // distribution away between two keystrokes. An unparseable or
              // out-of-range field leaves the count alone instead.
              const n = Number(e.target.value)
              if (Number.isInteger(n) && n >= 1 && n <= 4) patch((l) => setRoomCount(l, n))
            }} />
        </td>
        {simple ? cell('dn', 'dp') : <td className="num dim">{loc.dn.dp}</td>}
        {simple ? cell('dn', 'ts') : <td className="num dim">{loc.dn.ts}</td>}
        {simple ? cell('up', 'dp') : <td className="num dim">{loc.up.dp}</td>}
        {simple ? cell('up', 'ts') : <td className="num dim">{loc.up.ts}</td>}
        <td className="num"><b>{loc.totalDp}</b></td>
        <td className="num"><b>{loc.totalTs}</b></td>
        <td className="num">{plan.groups.length}</td>
        <td className="num">{plan.pack.rackCount}</td>
        <td className="rowacts">
          <button className="link" onClick={onToggle} aria-expanded={isOpen}>
            {isOpen ? 'close' : 'detail'}</button>
          <button className="link bad" onClick={remove} aria-label={`remove ${loc.name}`}>remove</button>
        </td>
      </tr>
      {isOpen && (
        <tr className="detail"><td colSpan={14}>
          <LocationDetail loc={loc} li={li} plan={plan} measured={measured} patch={patch} />
        </td></tr>
      )}
    </>
  )
}

/** Replace one section of one room, leaving everything else alone. */
function withSection(
  l: LocationInput, roomIndex: number, sectionIndex: number,
  fn: (s: NonNullable<LocationInput['sections']>[number]) => NonNullable<LocationInput['sections']>[number],
): LocationInput {
  const rooms = l.rooms?.length ? l.rooms : [{ sections: l.sections ?? [blankSection()] }]
  return {
    ...l,
    sections: undefined,
    rooms: rooms.map((r, ri) => (ri !== roomIndex ? r : {
      ...r,
      // `buildProject` gives a room with no sections a blank one, so the row on
      // screen can be a section the input does not hold. Edit the same blank
      // rather than mapping over an empty list and dropping the keystroke.
      sections: (r.sections.length ? r.sections : [blankSection()])
        .map((s, si) => (si === sectionIndex ? fn(s) : s)),
    })),
  }
}

function LocationDetail({ loc, li, plan, measured, patch }: {
  loc: Project['locations'][number]
  li: LocationInput
  plan: LocationPlan
  measured: boolean
  patch: (fn: (l: LocationInput) => LocationInput) => void
}) {
  const rooms = li.rooms?.length ? li.rooms : [{ sections: li.sections ?? [] }]
  const addSection = (ri: number) => patch((l) => {
    const rs = l.rooms?.length ? l.rooms : [{ sections: l.sections ?? [] }]
    return {
      ...l, sections: undefined,
      rooms: rs.map((r, i) => (i === ri
        ? { ...r, sections: [...r.sections, blankSection(`${l.name} ${r.sections.length + 1}`)] }
        : r)),
    }
  })
  const removeSection = (ri: number, si: number) => patch((l) => {
    const rs = l.rooms?.length ? l.rooms : [{ sections: l.sections ?? [] }]
    return {
      ...l, sections: undefined,
      rooms: rs.map((r, i) => (i === ri
        ? { ...r, sections: r.sections.length > 1 ? r.sections.filter((_, j) => j !== si) : r.sections }
        : r)),
    }
  })

  return (
    <div className="ldetail">
      <div className="lcol">
        <h3>Block sections</h3>
        <p className="dim">One row per section of track this location sits on. Durgapura and
        Sanganer each sit on two, and the workbook gives every section its own evaluation system —
        which is what makes their rack count three rather than two. Summing them away would lose it.</p>
        {rooms.map((room, ri) => (
          <div className="room" key={ri}>
            {rooms.length > 1 && (
              <div className="roomhead">
                <input type="text" value={room.name ?? loc.rooms[ri]?.name ?? ''}
                  aria-label={`room ${ri + 1} name`} className="wide"
                  onChange={(e) => patch((l) => ({
                    ...l, sections: undefined,
                    rooms: (l.rooms ?? []).map((r, i) => (i === ri ? { ...r, name: e.target.value } : r)),
                  }))} />
                <span className="dim">
                  {plan.rooms[ri]?.pack.rackCount ?? 0} racks · {plan.rooms[ri]?.groups.length ?? 0} groups
                </span>
              </div>
            )}
            <table className="mini">
              <thead><tr>
                <th>Section</th>
                <th className="num">DN DP</th><th className="num">DN TS</th>
                <th className="num">UP DP</th><th className="num">UP TS</th><th />
              </tr></thead>
              <tbody>
                {room.sections.map((s, si) => (
                  <tr key={si}>
                    <td className="pad0">
                      <input type="text" className="wide" aria-label="section name"
                        value={s.name ?? loc.rooms[ri]?.sections[si]?.name ?? ''}
                        onChange={(e) => patch((l) => ({
                          // Block sections ARE the section names, so drop the
                          // list an import wrote down and let it derive again.
                          ...withSection(l, ri, si, (x) => ({ ...x, name: e.target.value })),
                          blockSections: undefined,
                        }))} />
                    </td>
                    {(['dn', 'up'] as const).flatMap((dir) => (['dp', 'ts'] as const).map((f) => (
                      <td className="num pad0" key={`${dir}${f}`}>
                        <input type="number" min={0} value={s[dir][f]} {...noScroll}
                          aria-label={`${dir.toUpperCase()} ${f.toUpperCase()}`}
                          onChange={(e) => {
                            const v = whole(e.target.value)
                            patch((l) => withSection(l, ri, si, (x) =>
                              ({ ...x, [dir]: { ...x[dir], [f]: v } })))
                          }} />
                      </td>
                    )))}
                    <td className="rowacts">
                      {room.sections.length > 1 && (
                        <button className="link bad" onClick={() => removeSection(ri, si)}>remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="link" onClick={() => addSection(ri)}>+ block section</button>
          </div>
        ))}
      </div>

      <div className="lcol">
        <h3>Equipment rooms</h3>
        <p className="dim">Racks cannot span two rooms. Splitting a station moves its down line into
        the first room and its up line into the second, which is what the planner did at Devpura and
        Snaganer — and the two racks that difference accounts for are the whole of the 66-against-68
        gap. The room is also the column the rules are evaluated in, so a cubicle is asked of each.</p>
        <div className="kv">
          <span>Rooms</span>
          <span>{loc.rooms.map((r) => r.name).join(' · ')}</span>
          <span>Racks</span>
          <span>{loc.rooms.length > 1
            ? plan.rooms.map((r) => r.pack.rackCount).join(' + ') + ` = ${plan.pack.rackCount}`
            : plan.pack.rackCount}</span>
          <span>Groups</span>
          <span>{plan.groups.map((g) => `${g.id} (${g.aeb} AEB)`).join(' · ') || '—'}</span>
        </div>

        <h3>Cable runs</h3>
        {measured ? (
          <>
            <p className="dim">Counted runs for this location. They should add up to its
            {' '}{loc.totalDp} detection points.</p>
            <div className="cablerow">
              {(['m5', 'm10', 'm15'] as const).map((k) => (
                <label key={k}>
                  <span>{k.slice(1)} m</span>
                  <input type="number" min={0} value={li.cable?.[k] ?? 0} {...noScroll}
                    aria-label={`${k.slice(1)} m runs`}
                    onChange={(e) => {
                      const v = whole(e.target.value)
                      patch((l) => ({
                        ...l,
                        cable: { m5: 0, m10: 0, m15: 0, ...(l.cable ?? {}), [k]: v },
                      }))
                    }} />
                </label>
              ))}
              {li.cable && (
                <button className="link bad" onClick={() => patch((l) => ({ ...l, cable: null }))}>
                  clear
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="dim">The project is using the questionnaire&rsquo;s guideline, so runs are
          estimated from this location&rsquo;s application
          ({APPLICATION_LABEL[loc.application]}) rather than counted. Switch the project to measured
          runs above to enter a real cable plan.</p>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
function RackScreen({ plans, locId, setLocId }: {
  plans: LocationPlan[]; locId: string | null; setLocId: (id: string) => void
}) {
  const plan = plans.find((p) => p.location.id === locId) ?? plans[0]
  if (!plan) return null
  // A location with two equipment rooms is drawn as two, because that is what
  // stands in the building — racks do not move between rooms.
  const units: LocationPlan[] = plan.rooms.length > 1 ? plan.rooms : [plan]
  return (
    <>
      <h1>Rack layout</h1>
      <p className="lede">Slot widths are true to their TE pitch — PSC 8, AEB and COM 4, IO-EXB 6 —
      so this is the physical subrack, not a schematic. Hover a slot for its backplane and owning
      evaluation group. No backplane ever mixes groups; racks freely share them.</p>
      <div className="locpick">
        {plans.map((p) => (
          <button key={p.location.id} aria-current={p === plan}
            onClick={() => setLocId(p.location.id)}>
            {p.location.name} <span className="dim">{p.pack.rackCount}</span>
          </button>
        ))}
      </div>
      <div className="cards">
        <div><b>{plan.location.totalDp}</b><span>detection points</span></div>
        <div><b>{plan.groups.length}</b><span>eval groups</span></div>
        <div><b>{plan.pack.rackCount}</b><span>racks</span></div>
        <div><b>{plan.pack.psc}</b><span>PSC</span></div>
        <div><b>{plan.pack.comSeated}</b><span>COM</span></div>
        <div><b>{plan.pack.blankingTe}</b><span>TE unused</span></div>
      </div>
      {plan.pack.warnings.map((w, i) => <div className="warnbox" key={`${i}-${w}`}>{w}</div>)}
      {units.map((unit, ui) => (
        <div key={ui}>
          {units.length > 1 && <h2>{unit.location.name}</h2>}
          {unit.pack.racks.map((rack) => (
            <div className="rack" key={rack.index}>
              <div className="cap">
                <b>BGT07 · rack {rack.index}</b>
                <span className="mono dim">
                  {[...new Set(rack.backplanes.map((b) => b.spec.code))].join(' · ')}</span>
                <span className="mono dim">{rack.teUsed}/{rack.spec.te} TE</span>
              </div>
              <div className="slots">
                {rack.backplanes.flatMap((bp, bi) => bp.contents.map((tok, si) => (
                  <div key={`${bi}-${si}`} className={`slot ${TE_CLASS[tok] ?? 'blank'}`}
                    style={{ flex: TE_OF[tok] ?? 4 }}
                    title={`${tok} · ${TE_OF[tok] ?? 4} TE · ${bp.spec.code} · group ${bp.group}`}>
                    <b>{tok.startsWith('spare') || tok === 'leer' ? '—' : tok}</b>
                  </div>
                )))}
                {rack.teFree > 0 && (
                  <div className="slot free" style={{ flex: rack.teFree }}
                    title={`${rack.teFree} TE unused`}><b>{rack.teFree} TE</b></div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="key">
        <span><i style={{ background: 'var(--psc)' }} />PSC · 8 TE</span>
        <span><i style={{ background: 'var(--aeb)' }} />AEB · 4 TE</span>
        <span><i style={{ background: 'var(--com)' }} />COM-AdC · 4 TE</span>
        <span><i style={{ background: 'var(--io)' }} />IO-EXB · 6 TE</span>
        <span><i style={{ background: 'var(--blank)' }} />blank</span>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
function BoqScreen({ result, openLine, setOpenLine, overrides, setOverride }: {
  result: NonNullable<ReturnType<typeof run>>
  openLine: string | null; setOpenLine: (k: string | null) => void
  overrides: Override[]
  setOverride: (l: BoqLine, qty: number | null, reason: string) => void
}) {
  const counts: Record<string, number> = {}
  for (const l of result.lines) counts[l.provenance] = (counts[l.provenance] ?? 0) + 1
  let group = ''
  return (
    <>
      <h1>Bill of Quantities</h1>
      <p className="lede">Every line says where its number came from. Click one to see the rule, the
      driver it read and the arithmetic — and to override it. A rule that cannot resolve produces a
      flagged blank, never a silent zero.</p>
      <div className="cards">
        {['derived', 'override', 'stale', 'manual', 'blank', 'dormant'].filter((k) => counts[k]).map((k) => (
          <div key={k} className={k === 'derived' ? 'ok' : k === 'stale' ? 'warn' : k === 'blank' || k === 'manual' ? 'bad' : ''}>
            <b>{counts[k]}</b><span>{k}</span>
          </div>
        ))}
      </div>
      <div className="scroll"><table>
        <thead><tr>
          <th>Rule</th><th>Code</th><th>Description</th>
          <th className="num">Main</th><th className="num">Spare</th><th>Provenance</th>
        </tr></thead>
        <tbody>
          {result.lines.map((l) => {
            const head = l.group !== group ? (group = l.group) : null
            const isOpen = openLine === l.ruleId
            const ov = overrides.find((o) => o.partKey === l.partKey)
            return (
              <Rows key={l.ruleId} head={head} line={l} isOpen={isOpen}
                onToggle={() => setOpenLine(isOpen ? null : l.ruleId)}
                why={explain(l, result.resolved.get(l.ruleId), result.cable)}
                ov={ov} setOverride={setOverride} />
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

function Rows({ head, line, isOpen, onToggle, why, ov, setOverride }: {
  head: string | null; line: BoqLine; isOpen: boolean; onToggle: () => void
  why: string[]; ov: Override | undefined
  setOverride: (l: BoqLine, qty: number | null, reason: string) => void
}) {
  const [qty, setQty] = useState<string>(ov ? String(ov.qty) : '')
  const [reason, setReason] = useState<string>(ov?.reason ?? '')
  return (
    <>
      {head && <tr className="grp"><th colSpan={6}>{head}</th></tr>}
      <tr className={`click${isOpen ? ' sel' : ''}`} onClick={onToggle}>
        <td className={`mono dim edge e-${line.provenance}`}>{line.ruleId}</td>
        <td className="mono">{line.code ?? '—'}</td>
        <td>{line.description}{line.note && <span className="note">{line.note}</span>}</td>
        <td className="num">{nf(line.main)}</td>
        <td className="num dim">{line.spare || ''}</td>
        <td><span className={`pill ${line.provenance}`}>{line.provenance}</span></td>
      </tr>
      {isOpen && (
        <tr className="detail"><td colSpan={6}>
          <dl>
            {why.map((w, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt>{i === 0 ? 'Rule' : ''}</dt><dd>{w}</dd>
              </div>
            ))}
            {line.derived !== null && (
              <><dt>Derived</dt><dd className="mono">{nf(line.derived)}</dd></>
            )}
          </dl>
          {line.partKey ? (
            <div className="ovform" onClick={(e) => e.stopPropagation()}>
              <label htmlFor={`q-${line.ruleId}`}>Override</label>
              <input id={`q-${line.ruleId}`} type="number" min={0} value={qty}
                placeholder={line.derived === null ? 'enter' : String(line.derived)}
                onChange={(e) => setQty(e.target.value)} />
              <input type="text" value={reason} placeholder="reason — travels with the number"
                onChange={(e) => setReason(e.target.value)} />
              <button className="btn pri" disabled={qty === ''}
                onClick={() => setOverride(line, qty === '' ? null : Number(qty), reason)}>
                Apply
              </button>
              {ov && (
                <button className="btn" onClick={() => { setQty(''); setReason(''); setOverride(line, null, '') }}>
                  Clear
                </button>
              )}
              {ov && <span className="dim" style={{ fontSize: 12 }}>
                entered against {nf(ov.driverSnapshot)} · {ov.by} · {ov.at}</span>}
            </div>
          ) : (
            <p className="dim" style={{ margin: 0, fontSize: 12.5 }}>
              This line has no catalogue part number, so it cannot be overridden or ordered.</p>
          )}
        </td></tr>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
function DiffScreen({ result, origin }: {
  result: NonNullable<ReturnType<typeof run>>
  origin: Loaded['origin']
}) {
  const s = result.diff.summary
  const none = origin.kind !== 'workbook' || origin.submittedError !== null
  return (
    <>
      <h1>{none ? 'Cable split and diff' : 'Diff against the submitted BoQ'}</h1>
      {none ? (
        <div className="warnbox">
          {origin.kind === 'workbook'
            ? 'This workbook has no submitted BoQ sheet to compare against.'
            : 'This project was entered by hand, so there is no submitted BoQ to compare against. '
              + 'Everything else works; the generated BoQ stands on its own provenance.'}
        </div>
      ) : (
        <p className="lede">Compared main-to-main: the submitted BoQ leaves its Spare column empty on
        every line, so comparing totals would show a difference on each spared line that is really
        about spares policy.</p>
      )}

      {!none && (
        <div className="cards">
          <div className="ok"><b>{s['match'] ?? 0}</b><span>match</span></div>
          <div className="warn"><b>{s['differs'] ?? 0}</b><span>differ</span></div>
          <div className="bad"><b>{s['blank'] ?? 0}</b><span>blank</span></div>
          <div><b>{s['missing'] ?? 0}</b><span>no rule</span></div>
        </div>
      )}

      <h2>Cable-length split</h2>
      <CablePanel cable={result.cable} />

      {!none && <>
        <h2>Line by line</h2>
        <div className="scroll"><table>
          <thead><tr>
            <th>Code</th><th>Description</th><th className="num">Submitted</th>
            <th className="num">Generated</th><th className="num">&Delta;</th><th>Verdict</th>
          </tr></thead>
          <tbody>
            {result.diff.rows.map((r) => (
              <tr key={r.code}>
                <td className={`mono edge e-${r.verdict === 'match' ? 'derived' : r.verdict === 'differs' ? 'stale' : r.verdict === 'blank' ? 'blank' : 'dormant'}`}>{r.code}</td>
                <td>{r.description}</td>
                <td className="num">{nf(r.submitted)}</td>
                <td className="num">{nf(r.generated)}</td>
                <td className="num" style={{ fontWeight: 600 }}>
                  {r.delta === null || r.delta === 0 ? '' : r.delta > 0 ? `+${r.delta}` : r.delta}</td>
                <td><span className={`pill ${r.verdict}`}>{r.verdict}</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </>}

      {PART_ALIASES.applied.length > 0 && (
        <p className="lede" style={{ marginTop: 14, fontSize: 12.5 }}>
          {PART_ALIASES.applied.map((a) => `${a.code} → ${a.partKey}`).join(', ')} resolved through the
          alias table — codes the BoQ uses that the part master does not carry.
        </p>
      )}
      <p className="lede" style={{ fontSize: 12.5 }}>
        {RULES.length} rules evaluated over {result.columns.length} column
        {result.columns.length === 1 ? '' : 's'}.
      </p>
    </>
  )
}
