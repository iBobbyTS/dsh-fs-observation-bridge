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
import { baseName, lexShell, SHELL_READ_PROGRAMS } from './shell-command.js'

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
      if (!SHELL_TOOLS.has(exec.name)) return false
      const parsed = parseSimpleCommand(exec.arguments?.command)
      if (parsed === undefined) return false
      // shell-read owns cat/head/tail/sed/nl; a transport must have exactly one
      // claimant or the bridge rejects the call as ambiguous.
      return !SHELL_READ_PROGRAMS.has(baseName(parsed.program))
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
  const lexed = lexShell(command)
  if (!lexed.ok || lexed.stages.length !== 1) return undefined
  const tokens = lexed.stages[0]
  let programIndex = -1
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (RUNNERS.has(baseName(token.value))) continue
    if (token.value.startsWith('-')) continue
    // A quoted `FOO=bar` is a command word, not a shell assignment.
    if (ASSIGNMENT.test(token.value) && !token.quoted.some(Boolean)) continue
    programIndex = i
    break
  }
  if (programIndex < 0) return undefined
  const values = tokens.slice(programIndex + 1).map(token => token.value)
  return {
    program: tokens[programIndex].value,
    operation: values.find(value => !value.startsWith('-')),
    tokens: values,
  }
}
