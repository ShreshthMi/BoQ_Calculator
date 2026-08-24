import { useCallback, useMemo, useRef, useState } from 'react'
import { exportStyledBoq } from './export-xlsx.ts'
import {
  loadWorkbook, run, explain, exportProject, download,
  RULES, PART_ALIASES, DEFAULT_DECLARATIONS,
  type Loaded, type Declarations, type Override, type BoqLine, type LocationPlan,
  type Project,
} from './pipeline.ts'

type Screen = 'import' | 'setup' | 'input' | 'racks' | 'boq' | 'diff'

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

export default function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>('import')
  const [decl, setDecl] = useState<Declarations>(DEFAULT_DECLARATIONS)
  const [overrides, setOverrides] = useState<Override[]>([])
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [locId, setLocId] = useState<string | null>(null)
  /** Bumped whenever a DP/TS cell is edited, to re-derive from the mutated project. */
  const [rev, setRev] = useState(0)

  const result = useMemo(
    () => (loaded ? run(loaded.project, decl, overrides, loaded.submitted) : null),
    // `rev` participates because location edits mutate the project in place.
    [loaded, decl, overrides, rev],
  )

  const open = useCallback(async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const next = await loadWorkbook(file)
      setLoaded(next)
      setOverrides([])
      setLocId(next.project.locations[0]?.id ?? null)
      setScreen('boq')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

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

  const p = loaded?.project
  const stale = result?.lines.filter((l) => l.provenance === 'stale').length ?? 0

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="mark"><i /></span><b>BoQ Calculator</b></div>
        <div className="file">
          {loaded
            ? <><span>{loaded.fileName}</span><span>·</span><span>16.DP TS details</span></>
            : <span>no workbook loaded</span>}
          {stale > 0 && <span style={{ color: 'var(--warn)' }}>· {stale} stale override{stale === 1 ? '' : 's'}</span>}
        </div>
        {p && result && <>
          <div className="stat"><span>DP</span><b>{nf(p.totals.dp)}</b></div>
          <div className="stat"><span>Racks</span><b>{result.totals.racks}</b></div>
          <div className="stat"><span>Match</span><b>{result.diff.summary['match'] ?? 0}/{loaded.submitted.length}</b></div>
        </>}
        <div className="actions">
          <button className="btn" disabled={!loaded}
            onClick={() => { setLoaded(null); setOverrides([]); setScreen('import') }}>New</button>
        </div>
      </header>

      <div className="body">
        <nav>
          <div className="grp">Input</div>
          <NavBtn s="import" cur={screen} go={setScreen} label="Workbook" hint={loaded ? '✓' : ''} />
          <NavBtn s="setup" cur={screen} go={setScreen} label="Declarations" disabled={!loaded} />
          <NavBtn s="input" cur={screen} go={setScreen} label="Locations" disabled={!loaded}
            hint={p ? String(p.totals.locations) : ''} />
          <div className="grp">Output</div>
          <NavBtn s="racks" cur={screen} go={setScreen} label="Rack layout" disabled={!loaded}
            hint={result ? String(result.totals.racks) : ''} />
          <NavBtn s="boq" cur={screen} go={setScreen} label="Bill of Quantities" disabled={!loaded}
            hint={result ? String(result.lines.length) : ''} />
          <NavBtn s="diff" cur={screen} go={setScreen} label="Diff vs submitted" disabled={!loaded}
            hint={result ? String(result.diff.summary['match'] ?? 0) : ''} />
          {loaded && result && <>
            <div className="grp">Export</div>
            <button onClick={async () => download('BoQ.xlsx', await exportStyledBoq(result.lines),
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>
              BoQ spreadsheet
            </button>
            <button onClick={() => download('project.json', exportProject(loaded, decl, overrides), 'application/json')}>
              Project state
            </button>
          </>}
        </nav>

        <main>
          {screen === 'import' && <ImportScreen onFile={open} error={error} loaded={loaded} />}
          {screen === 'setup' && loaded && <SetupScreen decl={decl} setDecl={setDecl} />}
          {screen === 'input' && loaded && p && (
            <InputScreen project={p} plans={result!.plans} onEdit={() => setRev((r) => r + 1)} />
          )}
          {screen === 'racks' && result && (
            <RackScreen plans={result.plans} locId={locId} setLocId={setLocId} />
          )}
          {screen === 'boq' && result && (
            <BoqScreen result={result} openLine={openLine} setOpenLine={setOpenLine}
              overrides={overrides} setOverride={setOverride} />
          )}
          {screen === 'diff' && result && loaded && (
            <DiffScreen result={result} submittedCount={loaded.submitted.length}
              submittedError={loaded.submittedError} />
          )}
        </main>
      </div>
    </div>
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
function ImportScreen({ onFile, error, loaded }: {
  onFile: (f: File | undefined) => void; error: string | null; loaded: Loaded | null
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <h1>Load the handover sheet</h1>
      <p className="lede">The Bid Process Sheet. Its <code>16.DP TS details</code> tab carries the
      detection points and track sections; if the workbook also holds a submitted BoQ, that is read
      too so the generated one can be diffed against it. Nothing leaves this machine.</p>

      <div className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]) }}>
        <h2>Drop the workbook here</h2>
        <p>or choose a <code>.xlsx</code> / <code>.xlsm</code> file</p>
        <button className="btn pri" onClick={() => input.current?.click()}>Choose file</button>
        <input ref={input} type="file" accept=".xlsx,.xlsm,.xls" hidden
          onChange={(e) => onFile(e.target.files?.[0])} />
      </div>

      {error && <div className="warnbox"><b>Could not read that workbook.</b> {error}</div>}

      {loaded && (
        <>
          <h2>Read from {loaded.fileName}</h2>
          <div className="cards">
            <div><b>{loaded.project.totals.locations}</b><span>locations</span></div>
            <div><b>{loaded.project.totals.dp}</b><span>detection points</span></div>
            <div><b>{loaded.project.totals.ts}</b><span>track sections</span></div>
            <div><b>{loaded.submitted.length}</b><span>submitted lines</span></div>
          </div>
          {loaded.project.warnings.length > 0
            ? loaded.project.warnings.map((w) => <div className="warnbox" key={w}>{w}</div>)
            : <p className="lede">Reconciles with the sheet&rsquo;s own stated totals. No warnings.</p>}
          {loaded.submittedError && (
            <div className="warnbox">No submitted BoQ in this workbook, so the diff is unavailable.
              Everything else works. <span className="dim">({loaded.submittedError})</span></div>
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
function InputScreen({ project, plans, onEdit }: {
  project: Project; plans: LocationPlan[]; onEdit: () => void
}) {
  const cell = (loc: LocationPlan['location'], dir: 'dn' | 'up', f: 'dp' | 'ts') => (
    <td className="num" style={{ padding: 2 }}>
      <input type="number" min={0} value={loc[dir][f]} onChange={(e) => {
        const v = Math.max(0, Number(e.target.value) || 0)
        const delta = v - loc[dir][f]
        loc[dir][f] = v
        // Keep the location total AND the project total in step; dual detection
        // mirrors the change into the redundant system.
        const mult = loc.detection === 'DUAL' ? 2 : 1
        if (f === 'dp') { loc.totalDp += delta * mult; project.totals.dp += delta * mult }
        else { loc.totalTs += delta * mult; project.totals.ts += delta * mult }
        if (loc.sections.length === 1 && loc.sections[0]) loc.sections[0][dir][f] = v
        onEdit()
      }} />
    </td>
  )
  const editable = plans.filter((p) => p.location.sections.length === 1)
  return (
    <>
      <h1>Locations</h1>
      <p className="lede">Straight from the sheet. Edit a detection-point or track-section count and
      everything downstream re-derives — packing, the BoQ, and any override entered against the old
      value, which will flag stale. Locations spanning two block sections are read-only here, since
      their counts are per section.</p>
      <div className="scroll"><table>
        <thead><tr>
          <th>Location</th><th>Detection</th>
          <th className="num">DN DP</th><th className="num">DN TS</th>
          <th className="num">UP DP</th><th className="num">UP TS</th>
          <th className="num">Total DP</th><th className="num">Total TS</th>
          <th className="num">Groups</th><th className="num">Racks</th>
        </tr></thead>
        <tbody>
          {plans.map((pl) => {
            const l = pl.location
            const ed = editable.includes(pl)
            return (
              <tr key={l.id}>
                <td>{l.name}{l.blockSections.length > 1 &&
                  <span className="note">{l.blockSections.join(' + ')}</span>}</td>
                <td><span className="pill">{l.detection}</span></td>
                {ed ? cell(l, 'dn', 'dp') : <td className="num dim">{l.dn.dp}</td>}
                {ed ? cell(l, 'dn', 'ts') : <td className="num dim">{l.dn.ts}</td>}
                {ed ? cell(l, 'up', 'dp') : <td className="num dim">{l.up.dp}</td>}
                {ed ? cell(l, 'up', 'ts') : <td className="num dim">{l.up.ts}</td>}
                <td className="num"><b>{l.totalDp}</b></td>
                <td className="num"><b>{l.totalTs}</b></td>
                <td className="num">{pl.groups.length}</td>
                <td className="num">{pl.pack.rackCount}</td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
function RackScreen({ plans, locId, setLocId }: {
  plans: LocationPlan[]; locId: string | null; setLocId: (id: string) => void
}) {
  const plan = plans.find((p) => p.location.id === locId) ?? plans[0]
  if (!plan) return null
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
      {plan.pack.warnings.map((w) => <div className="warnbox" key={w}>{w}</div>)}
      {plan.pack.racks.map((rack) => (
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
                why={explain(l, result.resolved.get(l.ruleId))}
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
function DiffScreen({ result, submittedCount, submittedError }: {
  result: NonNullable<ReturnType<typeof run>>; submittedCount: number
  submittedError: string | null
}) {
  const s = result.diff.summary
  if (submittedError) {
    return (<><h1>Diff</h1>
      <div className="warnbox">This workbook has no submitted BoQ sheet to compare against.</div></>)
  }
  return (
    <>
      <h1>Diff against the submitted BoQ</h1>
      <p className="lede">Compared main-to-main: the submitted BoQ leaves its Spare column empty on
      every line, so comparing totals would show a difference on each spared line that is really
      about spares policy.</p>
      <div className="cards">
        <div className="ok"><b>{s['match'] ?? 0}</b><span>match</span></div>
        <div className="warn"><b>{s['differs'] ?? 0}</b><span>differ</span></div>
        <div className="bad"><b>{s['blank'] ?? 0}</b><span>blank</span></div>
        <div><b>{s['missing'] ?? 0}</b><span>no rule</span></div>
        <div><b>{submittedCount}</b><span>submitted lines</span></div>
      </div>

      <h2>Cable-length split</h2>
      <div className="calc">
        5 m &nbsp;&rarr;&nbsp; <b>{result.cable.m5}</b> &nbsp;&nbsp;
        10 m &nbsp;&rarr;&nbsp; <b>{result.cable.m10}</b> &nbsp;&nbsp;
        15 m &nbsp;&rarr;&nbsp; <b>{result.cable.m15}</b>
        <span className="dim"> &nbsp;— questionnaire B151 item 16: station 75/15/10, auto block 50/50</span>
      </div>

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

      {PART_ALIASES.applied.length > 0 && (
        <p className="lede" style={{ marginTop: 14, fontSize: 12.5 }}>
          {PART_ALIASES.applied.map((a) => `${a.code} → ${a.partKey}`).join(', ')} resolved through the
          alias table — codes the BoQ uses that the part master does not carry.
        </p>
      )}
      <p className="lede" style={{ fontSize: 12.5 }}>{RULES.length} rules evaluated.</p>
    </>
  )
}
