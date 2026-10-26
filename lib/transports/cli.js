/**
 * CLI transport: recognize one unambiguous shell command and normalize its
 * program, operation, arguments, stdout, and working directory.
 *
 * Only a single simple command is accepted. Pipes, redirections, command
 * lists, subshells, background jobs, command substitution, and variable
 * expansion all make the executed command indeterminate, so they are rejected
 * instead of guessed: a `codegraph` string inside an arbitrary script must not
 * count as a CodeGraph read.
 * @module dsh-fs-observation-bridge/transports/cli
 */

import { sessionCwd, resolveWorkdir } from '../paths.js'
import { textOf } from '../text.js'

/** Shell tools whose result can carry a CLI invocation. */
export const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** Wrappers that may precede the real executable. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'npm', 'yarn', 'bun', 'env', 'exec', 'command'])

/** Environment assignment preceding the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u

/**
 * Create the CLI transport adapter.
 * @returns {{ id: string, match: (exec: object) => boolean, normalize: Function }} the adapter.
 */
export function cliTransport() {
  return {
    id: 'cli',

    /**
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @returns {boolean} whether the call is a recognized shell tool.
     */
    match(exec) {
      return SHELL_TOOLS.has(exec.name)
    },

    /**
     * Normalize one simple shell command.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - accepted outcome.
     * @returns {Promise<object | null>} the normalized invocation, or null when ambiguous.
     */
    async normalize(ctx, exec, result) {
      const command = exec.arguments?.command
      const parsed = parseSimpleCommand(command)
      if (parsed === undefined) return null
      const cwd = await sessionCwd(ctx, exec)
      if (cwd === undefined) return null
      const workdir = resolveWorkdir(exec.arguments?.workdir, cwd)
      return {
        transport: 'cli',
        program: baseName(parsed.program),
        operation: parsed.operation,
        args: { tokens: parsed.tokens },
        content: textOf(result),
        cwd: workdir,
      }
    },
  }
}

/**
 * Parse one simple command. Returns undefined whenever the shell semantics are
 * not a single deterministic argv.
 * @param {unknown} command - the shell command text.
 * @returns {{ program: string, operation: string | undefined, tokens: string[] } | undefined}
 *   the program and its arguments after the program, or undefined.
 */
export function parseSimpleCommand(command) {
  const tokens = tokenize(command)
  if (tokens === undefined || tokens.length === 0) return undefined
  let programIndex = -1
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (RUNNERS.has(baseName(token))) continue
    if (token.startsWith('-')) continue
    if (ASSIGNMENT.test(token)) continue
    programIndex = i
    break
  }
  if (programIndex < 0) return undefined
  const tokensAfterProgram = tokens.slice(programIndex + 1)
  return {
    program: tokens[programIndex],
    operation: tokensAfterProgram.find(token => !token.startsWith('-')),
    tokens: tokensAfterProgram,
  }
}

/**
 * Split one simple command into tokens, rejecting any unquoted shell operator
 * that makes the executed argv ambiguous.
 * @param {unknown} command - the command text.
 * @returns {string[] | undefined} tokens, or undefined for an ambiguous command.
 */
function tokenize(command) {
  if (typeof command !== 'string') return undefined
  const tokens = []
  let current = ''
  let hasToken = false
  let quote
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
        continue
      }
      // Double quotes still expand `$` and command substitutions; single
      // quotes are literal, so only the latter may carry those characters.
      if (quote === '"' && (char === '$' || char === '`')) return undefined
      current += char
      hasToken = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (char === '\\') {
      if (i + 1 >= command.length) return undefined
      current += command[++i]
      hasToken = true
      continue
    }
    if (char === '\n' || char === '\r') return undefined
    if (/\s/u.test(char)) {
      if (hasToken || current !== '') {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    if ('|&;<>()`'.includes(char)) return undefined
    if (char === '$') return undefined
    current += char
    hasToken = true
  }
  if (quote !== undefined) return undefined
  if (hasToken || current !== '') tokens.push(current)
  return tokens
}

/**
 * The final path component of a token.
 * @param {string} token - one shell token.
 * @returns {string} the basename.
 */
function baseName(token) {
  const clean = token.endsWith('/') ? token.slice(0, -1) : token
  const slash = clean.lastIndexOf('/')
  return slash < 0 ? clean : clean.slice(slash + 1)
}
