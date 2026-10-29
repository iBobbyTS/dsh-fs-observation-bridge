/**
 * Conservative Bash lexer shared by the shell-read transport and the CLI
 * transport's mutual-exclusion check. It preserves whether each character was
 * quoted or escaped so glob/tilde checks can distinguish `'[id]/+page.svelte'`
 * (literal) from `[id]/+page.svelte` (a glob).
 *
 * Only a single simple command, or a pipeline of simple commands, is lexed.
 * Redirections, command lists, subshells, variable expansion, command
 * substitution, comments, and newlines are rejected instead of guessed.
 * @module dsh-fs-observation-bridge/transports/shell-command
 */

/** Programs the shell-read transport may claim. */
export const SHELL_READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'awk', 'gawk', 'mawk', 'grep', 'egrep', 'fgrep', 'rg'])

/** Characters that trigger Bash glob/brace/tilde expansion when unquoted. */
const GLOB_CHARS = new Set(['*', '?', '[', ']', '{', '}', '~'])

/**
 * One shell word after quote removal.
 * @typedef {{
 *   value: string,
 *   quoted: boolean[],
 *   hasUnquotedGlob: boolean,
 * }} ShellToken
 */

/**
 * @typedef {{ ok: true, stages: ShellToken[][] } | { ok: false, reason: string }} LexResult
 */

/**
 * Lex one command or pipeline.
 * @param {unknown} command - the model-supplied shell command.
 * @returns {LexResult} the stages, or a stable rejection reason.
 */
export function lexShell(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, reason: 'unsupported_syntax' }
  }

  const stages = []
  let tokens = []
  let token = null
  let quote
  let index = 0

  const startToken = () => {
    if (token === null) token = { value: '', quoted: [], hasUnquotedGlob: false }
    return token
  }
  const flushToken = () => {
    if (token === null) return
    tokens.push(token)
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

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
        index += 1
        continue
      }
      if (char === '\n' || char === '\r') return { ok: false, reason: 'unsupported_syntax' }
      const active = startToken()
      if (quote === "'") {
        active.value += char
        active.quoted.push(true)
        index += 1
        continue
      }
      // Double quotes still expand $ and command substitution.
      if (char === '$' || char === '`') return { ok: false, reason: 'unsupported_syntax' }
      if (char === '\\') {
        if (index + 1 >= command.length) return { ok: false, reason: 'unsupported_syntax' }
        const next = command[index + 1]
        if (next === '\n' || next === '\r') return { ok: false, reason: 'unsupported_syntax' }
        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          active.value += next
          active.quoted.push(true)
          index += 2
        } else {
          // Bash keeps the backslash for other characters inside double quotes.
          active.value += '\\'
          active.quoted.push(true)
          index += 1
        }
        continue
      }
      active.value += char
      active.quoted.push(true)
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
      if (command[index + 1] === '|' || command[index + 1] === '&') {
        return { ok: false, reason: 'unsupported_syntax' }
      }
      if (!endStage()) return { ok: false, reason: 'unsupported_syntax' }
      index += 1
      continue
    }
    if ('&;<>()'.includes(char)) return { ok: false, reason: 'unsupported_syntax' }
    if (char === '$' || char === '`') return { ok: false, reason: 'unsupported_syntax' }
    if (char === '#') {
      // A # at the start of a word begins a comment; inside a word it is literal.
      if (token === null || token.value === '') return { ok: false, reason: 'unsupported_syntax' }
      token.value += char
      token.quoted.push(false)
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      startToken()
      quote = char
      index += 1
      continue
    }
    if (char === '\\') {
      if (index + 1 >= command.length) return { ok: false, reason: 'unsupported_syntax' }
      const next = command[index + 1]
      if (next === '\n' || next === '\r') return { ok: false, reason: 'unsupported_syntax' }
      const active = startToken()
      active.value += next
      active.quoted.push(true)
      index += 2
      continue
    }

    const active = startToken()
    active.value += char
    active.quoted.push(false)
    if (GLOB_CHARS.has(char)) active.hasUnquotedGlob = true
    index += 1
  }

  if (quote !== undefined) return { ok: false, reason: 'unsupported_syntax' }
  if (!endStage()) return { ok: false, reason: 'unsupported_syntax' }
  return { ok: true, stages }
}

/**
 * The final path component of one token (shell programs are matched by name).
 * @param {string} token - one literal token.
 * @returns {string} the basename.
 */
export function baseName(token) {
  const clean = token.endsWith('/') ? token.slice(0, -1) : token
  const slash = clean.lastIndexOf('/')
  return slash < 0 ? clean : clean.slice(slash + 1)
}

/**
 * Whether a token is one of the standard absolute locations for a program.
 * A bare name (`cat`) is allowed; `./cat` and `/tmp/cat` are not.
 * @param {string} token - the program token.
 * @param {string} name - expected program name.
 * @returns {boolean} whether the token names the standard program.
 */
export function isStandardProgram(token, name) {
  return token === name || token === `/bin/${name}` || token === `/usr/bin/${name}`
}
