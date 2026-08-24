/**
 * The only module in the pipeline that touches the filesystem.
 *
 * Everything else — import, packing, rules, BoQ assembly — takes data and
 * returns data, so the same code runs unchanged in a browser where the workbook
 * arrives as an ArrayBuffer from a file input rather than a path. The CLI and
 * the report generator import their file reading from here; the app does not
 * import this module at all.
 */
import { readFileSync } from 'node:fs'
import { importProjectFromBuffer, type Project } from './import.ts'
import { parseRules, type SeedRule } from './engine.ts'
import {
  readSubmittedBoqFromBuffer, buildPartIndexFrom,
  type SubmittedLine, type PartIndex,
} from './boq.ts'
import type { AliasReport } from './aliases.ts'

export function importProject(path: string): Project {
  return importProjectFromBuffer(readFileSync(path), path)
}

export function loadRules(path: string): SeedRule[] {
  return parseRules(JSON.parse(readFileSync(path, 'utf8')))
}

export function readSubmittedBoq(path: string): SubmittedLine[] {
  return readSubmittedBoqFromBuffer(readFileSync(path))
}

export function buildPartIndexWithAliases(
  path: string,
): { index: PartIndex; aliases: AliasReport } {
  return buildPartIndexFrom(JSON.parse(readFileSync(path, 'utf8')))
}

export function buildPartIndex(path: string): PartIndex {
  return buildPartIndexWithAliases(path).index
}
