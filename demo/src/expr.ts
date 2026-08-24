/**
 * A very small arithmetic evaluator for rule expressions.
 *
 * The proposal forbids `eval`, so this is a hand-written tokeniser and
 * recursive-descent parser over exactly the grammar the seeded rules use:
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := '-'? primary
 *   primary := number | call | identifier | '(' expr ')'
 *   call    := ('floor' | 'ceil' | 'round') '(' expr ')'
 *            | 'part' '(' IDENT ')'
 *
 * NULL PROPAGATION is the point of the thing. A driver that is unavailable
 * resolves to null, and null poisons the whole expression, so the rule yields no
 * quantity at all. That surfaces in the BoQ as a flagged blank line — never a
 * silent zero, which would look like a real answer of "none required".
 */

export type Scope = {
  /** Driver values. A key present with value null means "known to be unavailable". */
  vars: Record<string, number | null | undefined>
  /** Resolved quantity of another part, for `part(BD041)`. */
  part: (key: string) => number | null
}

type Tok =
  | { k: 'num'; v: number }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }

const OPS = new Set(['+', '-', '*', '/', '(', ')'])

export function tokenise(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue }
    if (OPS.has(c)) { out.push({ k: 'op', v: c }); i++; continue }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++
      const n = Number(src.slice(i, j))
      if (!Number.isFinite(n)) throw new Error(`bad number at ${i} in ${src}`)
      out.push({ k: 'num', v: n })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++
      out.push({ k: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i} in ${src}`)
  }
  return out
}

const FUNCS = new Set(['floor', 'ceil', 'round'])

/** Every identifier an expression reads, so callers can check the driver contract. */
export function identifiers(src: string): string[] {
  const out = new Set<string>()
  const toks = tokenise(src)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (t.k !== 'id') continue
    const next = toks[i + 1]
    const isCall = next && next.k === 'op' && next.v === '('
    if (isCall && (FUNCS.has(t.v) || t.v === 'part')) {
      if (t.v === 'part') i += 2 // skip the part key, it is not a driver
      continue
    }
    out.add(t.v)
  }
  return [...out]
}

/** Part keys an expression references via `part(...)`. */
export function partRefs(src: string): string[] {
  const out: string[] = []
  const toks = tokenise(src)
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i]!.k === 'id' && toks[i]!.v === 'part'
      && toks[i + 1]!.k === 'op' && (toks[i + 1] as { v: string }).v === '('
      && toks[i + 2]!.k === 'id') {
      out.push((toks[i + 2] as { v: string }).v)
    }
  }
  return out
}

export function evaluate(src: string, scope: Scope): number | null {
  const toks = tokenise(src)
  let pos = 0

  const peek = (): Tok | undefined => toks[pos]
  const eat = (v: string): boolean => {
    const t = peek()
    if (t && t.k === 'op' && t.v === v) { pos++; return true }
    return false
  }
  const expect = (v: string) => {
    if (!eat(v)) throw new Error(`expected ${v} at token ${pos} in ${src}`)
  }

  // null is absorbing: once any operand is unavailable, so is the result.
  const bin = (a: number | null, b: number | null, f: (x: number, y: number) => number) =>
    a === null || b === null ? null : f(a, b)

  function primary(): number | null {
    const t = peek()
    if (!t) throw new Error(`unexpected end of ${src}`)
    if (t.k === 'num') { pos++; return t.v }
    if (t.k === 'op' && t.v === '(') { pos++; const v = expr(); expect(')'); return v }
    if (t.k === 'id') {
      pos++
      const isCall = peek()?.k === 'op' && (peek() as { v: string }).v === '('
      if (t.v === 'part' && isCall) {
        expect('(')
        const key = peek()
        if (!key || key.k !== 'id') throw new Error(`part() needs a key in ${src}`)
        pos++
        expect(')')
        return scope.part(key.v)
      }
      if (FUNCS.has(t.v) && isCall) {
        expect('(')
        const v = expr()
        expect(')')
        if (v === null) return null
        return t.v === 'floor' ? Math.floor(v) : t.v === 'ceil' ? Math.ceil(v) : Math.round(v)
      }
      if (!(t.v in scope.vars)) throw new Error(`unknown driver '${t.v}' in ${src}`)
      const v = scope.vars[t.v]
      return v === undefined || v === null ? null : v
    }
    throw new Error(`unexpected token in ${src}`)
  }

  function unary(): number | null {
    if (eat('-')) { const v = unary(); return v === null ? null : -v }
    return primary()
  }

  function term(): number | null {
    let v = unary()
    for (;;) {
      if (eat('*')) v = bin(v, unary(), (a, b) => a * b)
      else if (eat('/')) {
        const d = unary()
        v = d === null || d === 0 ? (d === 0 ? null : null) : bin(v, d, (a, b) => a / b)
      } else return v
    }
  }

  function expr(): number | null {
    let v = term()
    for (;;) {
      if (eat('+')) v = bin(v, term(), (a, b) => a + b)
      else if (eat('-')) v = bin(v, term(), (a, b) => a - b)
      else return v
    }
  }

  const value = expr()
  if (pos !== toks.length) throw new Error(`trailing tokens in ${src}`)
  return value
}

export type Rounding = 'UP' | 'DOWN' | 'NEAREST' | 'NONE'

export function applyRounding(v: number | null, mode: Rounding): number | null {
  // NaN and Infinity are unanswered questions wearing a number, and a BoQ has
  // nowhere to put one. They blank for the same reason null does.
  if (v === null || !Number.isFinite(v)) return null
  switch (mode) {
    case 'UP': return Math.ceil(v)
    case 'DOWN': return Math.floor(v)
    case 'NEAREST': return Math.round(v)
    default: return Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6
  }
}
