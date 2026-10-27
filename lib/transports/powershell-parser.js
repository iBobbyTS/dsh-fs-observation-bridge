/**
 * Strict PowerShell read-command parser.
 *
 * PowerShell is not Bash: quoting, escapes, arrays, providers, and parameter
 * abbreviation all differ, so the POSIX shell lexer is never reused here. This
 * parser accepts only a constant single-file `Get-Content` (or one of its
 * aliases) with literal parameters, optionally followed by one `Select-Object`
 * stage whose selectors are fixed named parameters. Everything else is
 * rejected instead of guessed: a command the bridge cannot replay exactly must
 * never authorize an edit.
 *
 * The resulting plan is rendered by `sources/powershell-read-render.js`, which
 * models PowerShell's line-object output rather than raw file bytes.
 * @module dsh-fs-observation-bridge/transports/powershell-parser
 */

/** Command names that resolve to Get-Content in a stock `pwsh -NoProfile`. */
const GET_CONTENT_PROGRAMS = new Set(['get-content', 'gc', 'cat', 'type'])

/** The only pipeline stage allowed after Get-Content. */
const SELECT_OBJECT_PROGRAM = 'select-object'

/**
 * Parse one PowerShell read command into a plan.
 * @param {unknown} command - the model-supplied command.
 * @returns {{ ok: true, plan: object } | { ok: false, reason: string }} the plan or rejection.
 */
export function parsePowerShellReadCommand(command) {
  const lexed = lexPowerShell(command)
  if (!lexed.ok) return lexed
  if (lexed.stages.length > 2) return { ok: false, reason: 'unsupported_syntax' }

  const reader = parseGetContent(lexed.stages[0])
  if (reader === undefined) return { ok: false, reason: 'unsupported_syntax' }

  let selectors = reader.selectors
  if (lexed.stages.length === 2) {
    // A pipeline selector over the whole object stream is well defined, but
    // combining it with -Raw or with a Get-Content count is not part of the
    // verified grammar yet.
    if (reader.mode === 'raw') return { ok: false, reason: 'unsupported_syntax' }
    if (selectors.length > 0) return { ok: false, reason: 'unsupported_syntax' }
    const piped = parseSelectObject(lexed.stages[1])
    if (piped === undefined) return { ok: false, reason: 'unsupported_syntax' }
    selectors = piped
  }

  return {
    ok: true,
    plan: {
      dialect: 'powershell',
      file: reader.file,
      mode: reader.mode,
      selectors,
      // Only a complete read (no selector, no -Raw) may observe an empty
      // file: a selector that matched nothing proves nothing.
      permitEmpty: selectors.length === 0,
    },
  }
}

/**
 * Parse the Get-Content stage.
 * @param {Array<object>} tokens - one stage's tokens.
 * @returns {{ file: string, mode: 'lines' | 'raw', selectors: object[] } | undefined}
 *   the reader, or undefined when anything is outside the whitelist.
 */
function parseGetContent(tokens) {
  const program = tokens[0]?.value?.toLowerCase()
  if (!GET_CONTENT_PROGRAMS.has(program)) return undefined

  let file
  let pathSeen = false
  let raw = false
  let totalCount
  let tail

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (isParameter(token)) {
      switch (token.value.toLowerCase()) {
        case '-raw':
          if (raw) return undefined
          raw = true
          break
        case '-totalcount':
        case '-head': {
          if (totalCount !== undefined) return undefined
          totalCount = readCount(tokens[++index], 'positive')
          if (totalCount === undefined) return undefined
          break
        }
        case '-tail': {
          if (tail !== undefined) return undefined
          tail = readCount(tokens[++index], 'positive')
          if (tail === undefined) return undefined
          break
        }
        case '-literalpath': {
          if (pathSeen) return undefined
          const value = tokens[++index]
          if (value === undefined || isParameter(value) || !validPath(value.value, true)) return undefined
          file = value.value
          pathSeen = true
          break
        }
        case '-path': {
          if (pathSeen) return undefined
          const value = tokens[++index]
          if (value === undefined || isParameter(value) || !validPath(value.value, false)) return undefined
          file = value.value
          pathSeen = true
          break
        }
        default:
          // -Encoding, -Stream, -Wait, -AsByteStream, -Delimiter, -ReadCount,
          // -Filter, -Include, -Exclude, ... are deliberately out of scope.
          return undefined
      }
      continue
    }
    // A second positional argument is a path array (or a count): reject.
    if (pathSeen) return undefined
    // Positional binding is -Path, which keeps wildcard semantics even when
    // the token itself was quoted.
    if (!validPath(token.value, false)) return undefined
    file = token.value
    pathSeen = true
  }

  if (file === undefined) return undefined
  if (raw && (totalCount !== undefined || tail !== undefined)) return undefined
  if (totalCount !== undefined && tail !== undefined) return undefined

  const selectors = totalCount !== undefined
    ? [{ kind: 'first', count: totalCount }]
    : tail !== undefined
      ? [{ kind: 'last', count: tail }]
      : []
  return { file, mode: raw ? 'raw' : 'lines', selectors }
}

/**
 * Parse the Select-Object stage.
 * @param {Array<object>} tokens - one stage's tokens.
 * @returns {object[] | undefined} the selectors, or undefined when outside the whitelist.
 */
function parseSelectObject(tokens) {
  if (tokens[0]?.value?.toLowerCase() !== SELECT_OBJECT_PROGRAM) return undefined

  let first
  let last
  let skip
  let index

  for (let position = 1; position < tokens.length; position++) {
    const token = tokens[position]
    if (!isParameter(token)) return undefined
    switch (token.value.toLowerCase()) {
      case '-first':
        if (first !== undefined) return undefined
        first = readCount(tokens[++position], 'positive')
        if (first === undefined) return undefined
        break
      case '-last':
        if (last !== undefined) return undefined
        last = readCount(tokens[++position], 'positive')
        if (last === undefined) return undefined
        break
      case '-skip':
        if (skip !== undefined) return undefined
        skip = readCount(tokens[++position], 'nonnegative')
        if (skip === undefined) return undefined
        break
      case '-index':
        if (index !== undefined) return undefined
        index = readCount(tokens[++position], 'nonnegative')
        if (index === undefined) return undefined
        break
      default:
        // -Property, -ExpandProperty, -Unique, -Wait, ... are out of scope.
        return undefined
    }
  }

  if (index !== undefined) {
    if (first !== undefined || last !== undefined || skip !== undefined) return undefined
    return [{ kind: 'index', index }]
  }
  if (last !== undefined) {
    if (first !== undefined || skip !== undefined) return undefined
    return [{ kind: 'last', count: last }]
  }
  if (first !== undefined) {
    return skip !== undefined
      ? [{ kind: 'skip', count: skip }, { kind: 'first', count: first }]
      : [{ kind: 'first', count: first }]
  }
  // -Skip alone (or no selector at all) is not a verified form.
  return undefined
}

/**
 * Lex one PowerShell command or pipeline into stages of literal tokens.
 * Only single quotes, double quotes without expansion, and bare words are
 * accepted. Variables, subexpressions, arrays, script blocks, redirections,
 * command lists, comments, escapes, and newlines are rejected.
 * @param {unknown} command - the model-supplied command.
 * @returns {{ ok: true, stages: Array<Array<{ value: string, quoted: boolean }>> } | { ok: false, reason: string }}
 *   the stages, or a stable rejection reason.
 */
function lexPowerShell(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, reason: 'unsupported_syntax' }
  }

  const stages = []
  let tokens = []
  let token = null
  let quote = null
  let index = 0

  const startToken = () => {
    if (token === null) token = { value: '', quoted: false, started: false }
    return token
  }
  const flushToken = () => {
    if (token === null) return
    tokens.push({ value: token.value, quoted: token.quoted })
    token = null
  }
  const endStage = () => {
    flushToken()
    if (tokens.length === 0) return false
    stages.push(tokens)
    tokens = []
    return true
  }

  while (index < command.length) {
    const char = command[index]

    if (quote === "'") {
      if (char === "'") {
        if (command[index + 1] === "'") {
          startToken().value += "'"
          index += 2
          continue
        }
        quote = null
        index += 1
        continue
      }
      if (char === '\n' || char === '\r') return { ok: false, reason: 'unsupported_syntax' }
      startToken().value += char
      index += 1
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        if (command[index + 1] === '"') {
          startToken().value += '"'
          index += 2
          continue
        }
        quote = null
        index += 1
        continue
      }
      // Double quotes still expand $variables and subexpressions, and a
      // backtick introduces an escape: all are dynamic.
      if (char === '$' || char === '`' || char === '\n' || char === '\r') {
        return { ok: false, reason: 'unsupported_syntax' }
      }
      startToken().value += char
      index += 1
      continue
    }

    if (char === ' ' || char === '\t') {
      flushToken()
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') return { ok: false, reason: 'unsupported_syntax' }
    if (char === '|') {
      if (command[index + 1] === '|') return { ok: false, reason: 'unsupported_syntax' }
      if (!endStage()) return { ok: false, reason: 'unsupported_syntax' }
      index += 1
      continue
    }
    // Command separators, redirections, grouping, splatting, and arrays.
    if (';&<>(){}@,'.includes(char)) return { ok: false, reason: 'unsupported_syntax' }
    if (char === '$' || char === '`') return { ok: false, reason: 'unsupported_syntax' }
    if (char === '#') {
      // A # at the start of a token begins a comment; inside a word it is a
      // literal character.
      if (token === null) return { ok: false, reason: 'unsupported_syntax' }
      token.value += char
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      const active = startToken()
      if (!active.started) active.quoted = true
      active.started = true
      quote = char
      index += 1
      continue
    }

    const active = startToken()
    active.started = true
    active.value += char
    index += 1
  }

  if (quote !== null) return { ok: false, reason: 'unsupported_syntax' }
  if (!endStage()) return { ok: false, reason: 'unsupported_syntax' }
  return { ok: true, stages }
}

/**
 * @param {object} token - a lexed token.
 * @returns {boolean} whether PowerShell would bind the token as a parameter.
 */
function isParameter(token) {
  return token.quoted === false && token.value.length > 1 && token.value.startsWith('-')
}

/**
 * Read an integer argument.
 * @param {object | undefined} token - the value token.
 * @param {'positive' | 'nonnegative'} kind - allowed range.
 * @returns {number | undefined} the value.
 */
function readCount(token, kind) {
  if (token === undefined || token.quoted === true) return undefined
  if (!/^\d+$/u.test(token.value)) return undefined
  const value = Number(token.value)
  if (!Number.isSafeInteger(value)) return undefined
  if (kind === 'positive' && value < 1) return undefined
  return value
}

/**
 * Validate one literal path argument.
 *
 * Wildcards are only rejected for -Path/positional binding, where PowerShell
 * expands them even when the token was quoted. Provider paths (`Env:`,
 * `HKLM:`), drive-relative paths, alternate data streams, device namespaces,
 * `~`, and empty paths are always rejected.
 * @param {unknown} value - the path value after quote removal.
 * @param {boolean} literal - whether the argument used -LiteralPath.
 * @returns {boolean} whether the path is a safe single filesystem path.
 */
function validPath(value, literal) {
  if (typeof value !== 'string' || value === '' || value === '-') return false
  if (value.includes('\0')) return false
  if (value.startsWith('~')) return false
  if (value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\')) return false
  if (/^[A-Za-z][A-Za-z0-9_-]*:/u.test(value) && !/^[A-Za-z]:[\\/]/u.test(value)) return false
  // Only the drive colon may remain; any other colon is a provider name or an
  // NTFS alternate data stream.
  const remainder = /^[A-Za-z]:/u.test(value) ? value.slice(2) : value
  if (remainder.includes(':')) return false
  if (!literal && /[*?[\]]/u.test(value)) return false
  return true
}
