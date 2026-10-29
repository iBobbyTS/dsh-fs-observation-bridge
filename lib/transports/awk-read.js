/**
 * AWK is a programming language, not a blanket read permission. Compile a tiny
 * grammar to inert data; never eval/run an AWK program supplied by the model.
 */
import { isStandardProgram } from './shell-command.js'

const MAX_COUNT = 1_000_000_000
const VARIABLES = new Set(['start', 'end', 'from', 'to', 's', 'e'])

/** A single-file reader or stdin-only selector, with constant numeric bounds. */
export function parseAwkRead(tokens, stdinMode = false) {
  if (!['awk', 'gawk', 'mawk'].some(name => isStandardProgram(tokens[0]?.value, name))) return undefined
  let i = 1
  const constants = new Map()
  while (tokens[i]?.value === '-v') {
    const assignment = tokens[i + 1]?.value
    const match = /^(start|end|from|to|s|e)=([0-9]+)$/u.exec(assignment ?? '')
    if (!match || constants.has(match[1]) || !count(match[2])) return undefined
    constants.set(match[1], Number(match[2]))
    i += 2
  }
  if (tokens[i]?.value === '--') i++
  const script = tokens[i++]
  if (!script || script.hasUnquotedGlob || script.value.length > 2048) return undefined
  const stage = compileAwkScript(script.value, constants)
  if (!stage) return undefined
  if (tokens[i]?.value === '--') i++
  const files = tokens.slice(i)
  if (stdinMode) return files.length === 0 ? { stage } : undefined
  if (files.length !== 1) return undefined
  const token = files[0]
  // AWK treats NAME=value operands as assignments even after --.
  if (!token.value || token.value === '-' || token.value.startsWith('-') || token.hasUnquotedGlob
    || token.value.includes('\0') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token.value)) return undefined
  return { stage, file: token.value }
}

/** Numeric predicates, literal/anchored ranges and original-$0 actions only. */
export function compileAwkScript(script, constants = new Map()) {
  const extracted = extractLiteralPatterns(script)
  if (!extracted) return undefined
  const patterns = extracted.patterns
  let condition = extracted.text.trim()
  let action = 'print'
  if (condition.includes('{') || condition.includes('}')) {
    const block = /^([^{}]*)\{([^{}]*)\}$/u.exec(condition)
    if (!block) return undefined
    condition = block[1].trim()
    action = block[2].trim().replace(/;\s*$/u, '').trim()
    // Common fixed form: { if (NR >= 2 && NR <= 4) print $0 }
    const ifBlock = /^if\s*\(([^()]*)\)\s*(.*)$/u.exec(action)
    if (ifBlock) {
      if (condition !== '') return undefined
      condition = ifBlock[1].trim()
      action = ifBlock[2].trim()
    }
  }
  let start = 1, end = MAX_COUNT, literalRange
  const literalFilters = []
  const patternRange = /^@(\d+)@\s*,\s*(?:@(\d+)@|(0))$/u.exec(condition)
  if (patternRange) {
    if (!patterns[Number(patternRange[1])] || patternRange[2] !== undefined && !patterns[Number(patternRange[2])]) return undefined
    literalRange = { from: patterns[Number(patternRange[1])], to: patternRange[2] === undefined ? null : patterns[Number(patternRange[2])] }
    condition = ''
  }
  if (condition !== '' && condition !== '1') {
    const range = /^(NR|FNR)\s*==\s*([0-9]+)\s*,\s*(NR|FNR)\s*==\s*([0-9]+)$/u.exec(condition)
    if (range) {
      if (range[1] !== range[3] || !count(range[2]) || !count(range[4])) return undefined
      start = Number(range[2]); end = Number(range[4])
    } else {
      const terms = condition.split(/\s*&&\s*/u)
      if (terms.length > 4) return undefined
      for (const term of terms) {
        const pattern = /^@(\d+)@$/u.exec(term.trim())
        if (pattern) {
          if (!patterns[Number(pattern[1])]) return undefined
          literalFilters.push(patterns[Number(pattern[1])]); continue
        }
        const m = /^(?:NR|FNR)\s*(>=|<=|==|>|<)\s*([0-9]+|[A-Za-z_][A-Za-z0-9_]*)$/u.exec(term.trim())
        if (!m) return undefined
        const value = /^[0-9]+$/u.test(m[2]) ? Number(m[2]) : VARIABLES.has(m[2]) ? constants.get(m[2]) : undefined
        if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) return undefined
        if (m[1] === '>=') start = Math.max(start, value)
        if (m[1] === '>') start = Math.max(start, value + 1)
        if (m[1] === '<=') end = Math.min(end, value)
        if (m[1] === '<') end = Math.min(end, value - 1)
        if (m[1] === '==') { start = Math.max(start, value); end = Math.min(end, value) }
      }
    }
  }
  if (start < 1 || end < start || end > MAX_COUNT) return undefined
  let format
  if (/^print(?:\s+\$0)?$/u.test(action)) format = { kind: 'plain' }
  else if (/^print\s+(?:NR|FNR)\s*,\s*\$0$/u.test(action)) format = { kind: 'number', separator: ' ', width: 0 }
  else {
    const print = /^print\s+(?:NR|FNR)\s*"(: ?|\\t| )"\s*\$0$/u.exec(action)
    const printf = /^printf\s+"%([1-9][0-9]?)?d(: ?|\\t| )%s\\n"\s*,\s*(?:NR|FNR)\s*,\s*\$0$/u.exec(action)
    if (print) format = { kind: 'number', separator: print[1] === '\\t' ? '\t' : print[1], width: 0 }
    else if (printf && Number(printf[1] ?? 0) <= 12) {
      format = { kind: 'number', separator: printf[2] === '\\t' ? '\t' : printf[2], width: Number(printf[1] ?? 0) }
    } else return undefined
  }
  return { kind: 'awk', start, end, format,
    ...literalFilters.length ? { literalFilters } : {},
    ...literalRange ? { literalRange } : {},
  }
}

function count(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_COUNT
}

/** Strip only regex literals from the condition, without accepting a regex engine. */
function extractLiteralPatterns(script) {
  let text = '', quoted = false
  const patterns = []
  for (let i = 0; i < script.length; i++) {
    const c = script[i]
    if (quoted) {
      text += c
      if (c === '\\') text += script[++i] ?? ''
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') { quoted = true; text += c; continue }
    if (c !== '/') { text += c; continue }
    let body = '', ended = false
    for (++i; i < script.length; i++) {
      if (script[i] === '\\') { body += script[i] + (script[++i] ?? ''); continue }
      if (script[i] === '/') { ended = true; break }
      body += script[i]
    }
    if (!ended) return undefined
    const compiled = literalPattern(body)
    if (!compiled) return undefined
    text += `@${patterns.length}@`; patterns.push(compiled)
  }
  return { text, patterns }
}

/** Literal ERE fragment, with optional anchors. No repetitions/classes/backrefs. */
function literalPattern(body) {
  let anchoredStart = false, anchoredEnd = false, literal = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '^' && i === 0) { anchoredStart = true; continue }
    if (c === '$' && i === body.length - 1) { anchoredEnd = true; continue }
    if (c === '\\') {
      const next = body[++i]
      if (!next || !'/\\.[](){}*+?^$|'.includes(next)) return undefined
      literal += next; continue
    }
    if ('[.*+?^$|({'.includes(c) || c === ')' || c === ']' || c === '\n' || c === '\r') return undefined
    literal += c
  }
  return literal !== '' ? { literal, anchoredStart, anchoredEnd } : undefined
}

function literalMatches(pattern, line) {
  if (pattern.anchoredStart && pattern.anchoredEnd) return line === pattern.literal
  if (pattern.anchoredStart) return line.startsWith(pattern.literal)
  if (pattern.anchoredEnd) return line.endsWith(pattern.literal)
  return line.includes(pattern.literal)
}

/** Selected input records; exported to keep the provenance model identical to replay. */
export function selectAwkRecords(stage, text) {
  const lines = text === '' ? [] : text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let active = false
  const selected = []
  for (let offset = 0; offset < lines.length; offset++) {
    const line = lines[offset], number = offset + 1
    if (number < stage.start || number > stage.end) continue
    if (stage.literalFilters?.some(p => !literalMatches(p, line))) continue
    if (stage.literalRange) {
      if (!active) active = literalMatches(stage.literalRange.from, line)
      if (!active) continue
      if (stage.literalRange.to && literalMatches(stage.literalRange.to, line)) active = false
    }
    selected.push({ line, number })
  }
  return selected
}

/** AWK print appends ORS, including for an unterminated last input record. */
export function renderAwkStage(stage, text) {
  return selectAwkRecords(stage, text).map(({ line, number }) => {
    const prefix = stage.format.kind === 'number'
      ? String(number).padStart(stage.format.width, ' ') + stage.format.separator : ''
    return prefix + line + '\n'
  }).join('')
}
