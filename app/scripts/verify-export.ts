import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planLocation, buildDrivers, buildDriversFor, runRulesOverLocations, DEFAULT_DECLARATIONS } from '../../demo/src/engine.ts'
import { assemble } from '../../demo/src/boq.ts'
import { importProject, loadRules } from '../../demo/src/node-io.ts'
import { exportStyledBoq } from '../src/export-xlsx.ts'

const BASE = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const project = importProject(join(BASE, 'BOM CAL', 'Handover BID Process Sheet Version 11.xlsx'))
const d = DEFAULT_DECLARATIONS
const plans = project.locations.map((l) => planLocation(l, d))
const { resolved } = runRulesOverLocations(
  loadRules(join(BASE, 'Rule Map', 'rules.seed.json')),
  plans.map((p) => buildDriversFor(p, d)), buildDrivers(project, plans, d), d)
const lines = assemble(resolved, [])
const buf = await exportStyledBoq(lines)
const out = join(BASE, 'app', 'BoQ.xlsx')
writeFileSync(out, Buffer.from(buf))
console.log(`wrote ${out} — ${lines.length} lines, ${(buf.byteLength / 1024).toFixed(1)} KB`)
