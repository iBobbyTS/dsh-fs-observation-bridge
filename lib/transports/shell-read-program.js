/**
 * Closed read-only Bash list grammar. This is not a shell evaluator: no command
 * from the model is executed by the bridge. Unknown statements reject the whole
 * list; output must later be replayed and compared as one indivisible transcript.
 * @module dsh-fs-observation-bridge/transports/shell-read-program
 */
import { isAbsolute, resolve } from 'node:path'
import { isStandardProgram, lexShell } from './shell-command.js'

export const MAX_PROGRAM_STATEMENTS = 64
export const MAX_PROGRAM_FILES = 200
const MAX_COMMAND_CHARS = 64 * 1024
const fail = reason => ({ ok: false, reason })

/** Compile a list using the shared single-file parser. */
export function parseReadProgram(command, parseSingle) {
  const list = splitReadList(command)
  if (!list.ok) return list
  const steps = []
  let files = 0
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i]
    const stripped = stripStderrNull(item.text)
    if (!stripped.ok) return stripped
    const lexed = lexShell(stripped.text)
    if (!lexed.ok) return lexed
    const words = lexed.stages[0]
    const name = words[0]?.value
    if (name === 'cd') {
      // Only an initial, unsuppressed, clean-result guarded cd is admitted. A bare
      // directory name is CDPATH-sensitive; require /, ./, ../, . or ...
      const args = words.slice(words[1]?.value === '--' ? 2 : 1)
      if (i !== 0 || stripped.suppressed || lexed.stages.length !== 1
        || !['&&', ';'].includes(item.after) || args.length !== 1 || !literalPath(args[0])
        || !/^(?:\/|\.\/|\.\.\/|\.$|\.\.$)/u.test(args[0].value)) {
        return fail('unsupported_cd')
      }
      steps.push({ kind: 'cd', path: args[0].value })
      continue
    }
    if (isStandardProgram(name, 'echo') || isStandardProgram(name, 'printf')) {
      if (stripped.suppressed || lexed.stages.length !== 1) return fail('unsupported_marker')
      const text = literalMarker(words)
      if (text === undefined) return fail('unsupported_marker')
      steps.push({ kind: 'literal', text })
      continue
    }
    const read = parseReadBlock(stripped.text, lexed, parseSingle)
    if (read === undefined) return fail('unsupported_statement')
    // A final && chain preserves a failed reader's exit status. A later ';'
    // masks it, so stderr suppression is unsafe there. Pipeline statuses also
    // do not prove the reader succeeded; do not admit suppressed pipelines.
    if (stripped.suppressed && (read.stages.length !== 1
      || list.items.slice(i, -1).some(part => part.after !== '&&'))) {
      return fail('masked_failure')
    }
    files += read.files.length
    if (files > MAX_PROGRAM_FILES) return fail('program_limit')
    steps.push({ kind: 'read', ...read })
  }
  if (files === 0) return fail('no_source_read')
  return { ok: true, plan: { dialect: 'bash', kind: 'program', steps } }
}

/** Resolve logical cd separately from file operands (which retain physical ..). */
export function resolveReadProgram(plan, cwd) {
  if (!isAbsolute(cwd)) return undefined
  let directory = cwd
  const steps = plan.steps.map(step => {
    if (step.kind === 'cd') {
      directory = resolve(directory, step.path)
      return { ...step, path: directory }
    }
    if (step.kind !== 'read') return step
    return { ...step, files: step.files.map(file => isAbsolute(file)
      ? file : `${directory.endsWith('/') ? directory : `${directory}/`}${file}`) }
  })
  return { ...plan, steps, effectiveCwd: directory }
}

/** Quote-aware list splitting; the existing lexer still validates every stage. */
export function splitReadList(command) {
  if (typeof command !== 'string' || command.trim() === ''
    || command.length > MAX_COMMAND_CHARS || command.includes('\0')) return fail('unsupported_syntax')
  const items = []
  let start = 0
  let quote
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote !== undefined) {
      if (c === '\n' || c === '\r') return fail('unsupported_syntax')
      if (c === quote) quote = undefined
      else if (quote === '"' && c === '\\') {
        if (i + 1 >= command.length || /[\r\n]/u.test(command[i + 1])) return fail('unsupported_syntax')
        if ('$`"\\'.includes(command[i + 1])) i++
      }
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '\\') {
      if (i + 1 >= command.length || /[\r\n]/u.test(command[i + 1])) return fail('unsupported_syntax')
      i++; continue
    }
    if ('()'.includes(c) || c === '\r') return fail('unsupported_syntax')
    if (c === '|' && (command[i + 1] === '|' || command[i + 1] === '&')) return fail('unsupported_control_flow')
    let after
    if (c === '&') {
      if (command[i + 1] !== '&') return fail('background_unsupported')
      after = '&&'
    } else if (c === ';' || c === '\n') after = ';'
    else continue
    const text = command.slice(start, i).trim()
    if (text === '') {
      // Allow blank lines after a completed statement, never empty &&/;;.
      if (c === '\n' && (items.length === 0 || items.at(-1).after === ';')) { start = i + 1; continue }
      return fail('unsupported_syntax')
    }
    items.push({ text, after })
    if (items.length > MAX_PROGRAM_STATEMENTS) return fail('program_limit')
    if (after === '&&') i++
    start = i + 1
  }
  if (quote !== undefined) return fail('unsupported_syntax')
  const text = command.slice(start).trim()
  if (text !== '') items.push({ text, after: null })
  else if (items.at(-1)?.after === '&&') return fail('unsupported_syntax')
  else if (items.length) items.at(-1).after = null
  if (items.length === 0 || items.length > MAX_PROGRAM_STATEMENTS) return fail('program_limit')
  return { ok: true, items }
}

/** Admit only an unquoted, final ` 2>/dev/null`; no other redirection. */
function stripStderrNull(text) {
  let quote
  let redirect = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (quote === '"' && c === '\\' && '$`"\\'.includes(text[i + 1] ?? '')) i++
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '\\') { i++; continue }
    if (c === '<') return fail('redirection_unsupported')
    if (c !== '>') continue
    if (redirect !== -1 || text[i - 1] !== '2' || i < 2 || !/[ \t]/u.test(text[i - 2])) return fail('redirection_unsupported')
    redirect = i
  }
  if (redirect === -1) return { ok: true, text, suppressed: false }
  const target = lexShell(text.slice(redirect + 1))
  if (!target.ok || target.stages.length !== 1 || target.stages[0].length !== 1
    || target.stages[0][0].value !== '/dev/null') return fail('redirection_unsupported')
  return { ok: true, text: text.slice(0, redirect - 1).trimEnd(), suppressed: true }
}

/** Old one-file grammar plus plain multi-file cat, with the same selectors. */
export function parseReadBlock(text, lexed, parseSingle) {
  const direct = parseSingle(text)
  if (direct.ok) return { files: [direct.plan.file], stages: direct.plan.stages }
  const first = lexed.stages[0]
  if (!isStandardProgram(first[0]?.value, 'cat')) return undefined
  let args = first.slice(1)
  const endOptions = args[0]?.value === '--'
  if (endOptions) args = args.slice(1)
  if (args.length < 2 || args.some(token => !literalPath(token)
    || (!endOptions && token.value.startsWith('-')))) return undefined
  if (lexed.stages.slice(1).some(stage => stage.some(token => token.hasUnquotedGlob))) return undefined
  const suffix = lexed.stages.slice(1).map(stage => stage.map(token => shellQuote(token.value)).join(' '))
  const template = ['cat __bridge_input__', ...suffix].join(' | ')
  const parsed = parseSingle(template)
  return parsed.ok ? { files: args.map(token => token.value), stages: parsed.plan.stages } : undefined
}

function literalPath(token) {
  return token !== undefined && token.value !== '' && token.value !== '-'
    && !token.value.includes('\0') && !token.hasUnquotedGlob
}

function shellQuote(value) { return `'${value.replace(/'/gu, `'\\''`)}'` }

/** Fixed literal separators only: no echo switches, backslash expansion or %b. */
export function literalMarker(words) {
  if (words.some(word => word.hasUnquotedGlob || word.value.includes('\0'))) return undefined
  const args = words.slice(1).map(word => word.value)
  if (isStandardProgram(words[0].value, 'echo')) {
    if (/^-[neE]+$/u.test(args[0] ?? '') || ['--help', '--version'].includes(args[0]) || args.some(arg => arg.includes('\\'))) return undefined
    return `${args.join(' ')}\n`
  }
  if (args[0] === '--') args.shift()
  const format = args.shift()
  if (format === undefined || format.startsWith('-')) return undefined
  if (format === '%s' || format === '%s\\n') {
    if (args.length === 0) return undefined
    return args.map(arg => arg + (format.endsWith('\\n') ? '\n' : '')).join('')
  }
  if (format.includes('%') || args.length !== 0 || /\\(?![nrt\\])/u.test(format)) return undefined
  return format.replace(/\\([nrt\\])/gu, (_, c) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[c])
}
