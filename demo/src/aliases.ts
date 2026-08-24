/**
 * Part-code aliases: codes that appear on a BoQ but not in the part master.
 *
 * The catalogue is not complete with respect to what the bid team actually
 * books. Sometimes a part exists under a code `BD BOM` does not carry, and the
 * diff then reports a false negative — the pipeline produced the right quantity
 * against the right part, and the join simply failed.
 *
 * This table fixes that, but ONLY by explicit entry. Descriptions are never
 * fuzzy-matched: "Rail claw SK140-011" and "Rail claw plate SK140-011" differ by
 * one word and are different products, and the catalogue already has ten
 * duplicate part numbers of its own. A wrong join here would silently move
 * quantities between lines, which is worse than the blank it replaces.
 *
 * Every entry therefore carries its evidence, and each is a question for the
 * part master rather than a permanent fix: the right end state is that the
 * catalogue carries the code and this table is empty.
 */

export type CodeAlias = {
  /** The code as it appears on the BoQ. */
  code: string
  /** The catalogue row it refers to. */
  partKey: string
  evidence: string
}

export const CODE_ALIASES: CodeAlias[] = [
  {
    code: '24422',
    partKey: 'BD018',
    evidence:
      'Appears only in the two BoQ sheets of the handover workbook, nowhere in ' +
      'either calculator. Described there as "Frauscher Rail Deflector FRD001 ' +
      'GS02 60kg", which is the BD018 description exactly bar its "IN " prefix, ' +
      'at the same quantity of 550. BD018 carries 101950 across all three of its ' +
      'code systems and no 5-digit AT-style code, so 24422 looks like the AT ' +
      'Sales Cloud number that never made it into the catalogue row.',
  },
]

export type AliasReport = {
  applied: CodeAlias[]
  /** Aliases whose target is not in the catalogue — a defect in this table. */
  unknownTarget: CodeAlias[]
  /** Aliases whose code the catalogue already resolves — silently ignored. */
  shadowed: CodeAlias[]
}

/**
 * Merge the alias table into a code index.
 *
 * An alias never overwrites a real catalogue code. If the catalogue later gains
 * the code, the alias becomes inert and is reported as shadowed so it can be
 * deleted rather than quietly diverging.
 */
export function applyAliases(
  index: Map<string, string>,
  knownParts: Set<string>,
  aliases: CodeAlias[] = CODE_ALIASES,
): AliasReport {
  const report: AliasReport = { applied: [], unknownTarget: [], shadowed: [] }
  for (const a of aliases) {
    if (!knownParts.has(a.partKey)) { report.unknownTarget.push(a); continue }
    if (index.has(a.code)) { report.shadowed.push(a); continue }
    index.set(a.code, a.partKey)
    report.applied.push(a)
  }
  return report
}
