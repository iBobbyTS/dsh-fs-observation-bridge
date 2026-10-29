/**
 * Shell-read transport: recognize exact-replay readers and scoped searches.
 * `bash` uses a closed POSIX grammar; `pwsh` uses the strict PowerShell ReadPlan
 * grammar. Search patterns are not replayed: actual source lines are verified
 * against bounded filesystem snapshots and declared input scopes;
 * anything else stays unclaimed so no other transport can turn a command name
 * into authorization.
 * @module dsh-fs-observation-bridge/transports/shell-read
 */

import { isAbsolute, resolve } from 'node:path'
import { resolveWorkdir, sessionCwd } from '../paths.js'
import { parsePowerShellReadCommand } from './powershell-parser.js'
import { isStandardProgram, lexShell } from './shell-command.js'
import { parseAwkRead } from './awk-read.js'
import { foregroundValue, successful } from './shell-result.js'
import { parseSearchProgram, resolveSearchProgram } from './search-read.js'
import { parseReadProgram, resolveReadProgram } from './shell-read-program.js'

/**
 * Parse one shell-read command into a plan.
 * @param {unknown} command - the model-supplied command.
 * @returns {{ ok: true, plan: object } | { ok: false, reason: string }} the plan or rejection.
 */
export function parseShellReadCommand(command) {
  const lexed = lexShell(command)
  if (!lexed.ok) return lexed
  const parsed = lexed.stages.map((tokens, index) => parseStage(tokens, index > 0))
  if (parsed.some(stage => stage === undefined)) return { ok: false, reason: 'unsupported_syntax' }
  const stages = parsed.map(stage => stage.stage)
  const files = parsed.map(stage => stage.file).filter(file => file !== undefined)

  if (files.length !== 1) return { ok: false, reason: 'unsupported_syntax' }
  const file = files[0]

  if (stages.length === 1) {
    return {
      ok: true,
      plan: {
        dialect: 'bash',
        file,
        stages,
        permitEmpty: stages[0].kind === 'cat' && stages[0].number === 'none',
      },
    }
  }

  if (stages.length > 3) return { ok: false, reason: 'unsupported_syntax' }
  const [reader, ...selectors] = stages
  if (!isReader(reader)) return { ok: false, reason: 'unsupported_syntax' }
  if (!selectors.every(isSelector)) return { ok: false, reason: 'unsupported_syntax' }
  // Numbering twice has no useful reading semantics and only widens the test
  // matrix; every other one/two-selector order is a pure text transform.
  if (stages.filter(stage => stage.kind === 'nl').length > 1) {
    return { ok: false, reason: 'unsupported_syntax' }
  }

  return {
    ok: true,
    plan: { dialect: 'bash', file, stages, permitEmpty: false },
  }
}

/** Parse the old single-read grammar first, then the closed read-only list grammar. */
export function parseShellReadProgram(command) {
  const single = parseShellReadCommand(command)
  if (single.ok) return single
  const program = parseReadProgram(command, parseShellReadCommand)
  return program.ok ? program : parseSearchProgram(command, parseShellReadCommand)
}

/**
 * @param {object} stage - one plan stage.
 * @returns {boolean} whether the stage can read the target file.
 */
function isReader(stage) {
  return stage.kind === 'cat'
    || stage.kind === 'head'
    || stage.kind === 'tail'
    || stage.kind === 'nl'
    || stage.kind === 'sed'
    || stage.kind === 'awk'
}

/**
 * @param {object} stage - one plan stage.
 * @returns {boolean} whether the stage is a stdin-only selector or numberer.
 */
function isSelector(stage) {
  return stage.kind === 'head'
    || stage.kind === 'tail'
    || stage.kind === 'sed'
    || stage.kind === 'awk'
    || stage.kind === 'nl'
}

/**
 * Create the shell-read transport adapter.
 * @returns {{ id: string, match: Function, normalize: Function }} the adapter.
 */
export function shellReadTransport() {
  return {
    id: 'shell-read',

    /**
     * Claim only a syntactically valid shell-read plan. Normalization performs
     * the result/foreground/cwd checks that require the completed call.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @returns {boolean} whether the command is an allowed shell-read grammar.
     */
    match(exec) {
      if (exec.name === 'bash') return parseShellReadProgram(exec.arguments?.command).ok
      if (exec.name === 'pwsh') return parsePowerShellReadCommand(exec.arguments?.command).ok
      return false
    },

    /**
     * Normalize one completed foreground shell call.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - accepted outcome.
     * @returns {Promise<object | null>} the normalized invocation, or null when unsafe.
     */
    async normalize(ctx, exec, result) {
      if (exec.name === 'pwsh') return normalizePowerShell(exec, result)
      const parsed = parseShellReadProgram(exec.arguments?.command)
      if (!parsed.ok) return null
      if (exec.arguments?.run_in_background === true) return null
      const value = foregroundValue(result)
      if (value === undefined) return null
      if (!successful(value)) return null

      const cwd = await sessionCwd(ctx, exec)
      if (cwd === undefined) return null
      const workdir = resolveWorkdir(exec.arguments?.workdir, cwd)
      if (typeof value.cwd === 'string' && value.cwd !== '' && resolve(value.cwd) !== resolve(workdir)) return null

      if (parsed.plan.kind === 'program' || parsed.plan.kind === 'search-program') {
        // New list forms require the executor's authoritative initial cwd.
        if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return null
        const plan = parsed.plan.kind === 'search-program'
          ? resolveSearchProgram(parsed.plan, value.cwd) : resolveReadProgram(parsed.plan, value.cwd)
        if (plan === undefined) return null
        return {
          transport: 'shell-read', dialect: 'bash', plan, cwd: value.cwd,
          stdout: value.stdout.text, stderr: value.stderr.text,
          exitCode: value.exitCode, truncated: value.stdout.truncated,
        }
      }
      const file = isAbsolute(parsed.plan.file) ? parsed.plan.file : resolve(workdir, parsed.plan.file)
      return {
        transport: 'shell-read',
        dialect: 'bash',
        plan: { ...parsed.plan, file, effectiveCwd: workdir },
        cwd: workdir,
        stdout: value.stdout.text,
        stderr: value.stderr.text,
        exitCode: value.exitCode,
        truncated: value.stdout.truncated,
      }
    },
  }
}

/**
 * Normalize one completed foreground `pwsh` call.
 *
 * The result's `cwd` is the directory the process actually ran in, so relative
 * paths resolve against it instead of being guessed from model arguments.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - accepted outcome.
 * @returns {object | null} the normalized invocation, or null when unsafe.
 */
function normalizePowerShell(exec, result) {
  const parsed = parsePowerShellReadCommand(exec.arguments?.command)
  if (!parsed.ok) return null
  if (exec.arguments?.run_in_background === true) return null
  const value = foregroundValue(result)
  if (value === undefined) return null
  if (!successful(value)) return null
  if (typeof value.cwd !== 'string' || value.cwd === '' || !isAbsolute(value.cwd)) return null

  const file = isAbsolute(parsed.plan.file) ? parsed.plan.file : resolve(value.cwd, parsed.plan.file)
  return {
    transport: 'shell-read',
    dialect: 'powershell',
    plan: { ...parsed.plan, file, effectiveCwd: value.cwd },
    cwd: value.cwd,
    stdout: value.stdout.text,
    stderr: value.stderr.text,
    exitCode: value.exitCode,
    truncated: value.stdout.truncated,
  }
}

/**
 * Parse one simple stage.
 * @param {Array<object>} tokens - stage tokens.
 * @param {boolean} stdinMode - whether this stage reads stdin instead of a file.
 * @returns {{ stage: object, file?: string } | undefined} parsed stage.
 */
function parseStage(tokens, stdinMode) {
  const program = tokens[0]?.value
  if (program === undefined) return undefined
  const awk = parseAwkRead(tokens, stdinMode)
  if (awk !== undefined) return awk
  if (isStandardProgram(program, 'cat')) return parseCat(tokens.slice(1), stdinMode)
  if (isStandardProgram(program, 'head')) return parseHead(tokens.slice(1), stdinMode)
  if (isStandardProgram(program, 'tail')) return parseTail(tokens.slice(1), stdinMode)
  if (isStandardProgram(program, 'sed')) return parseSed(tokens.slice(1), stdinMode)
  if (isStandardProgram(program, 'nl')) return parseNl(tokens.slice(1), stdinMode)
  return undefined
}

/**
 * @param {Array<object>} args - arguments after `cat`.
 * @param {boolean} stdinMode - whether this stage operates on stdin.
 * @returns {{ stage: object, file?: string } | undefined} parsed stage.
 */
function parseCat(args, stdinMode) {
  let number = 'none'
  let endOptions = false
  let file
  for (const token of args) {
    if (file !== undefined) return undefined
    if (!endOptions && token.value === '--') {
      endOptions = true
      continue
    }
    if (!endOptions && (token.value === '-n' || token.value === '-b')) {
      if (number !== 'none') return undefined
      number = token.value === '-n' ? 'all' : 'nonblank'
      continue
    }
    if (!endOptions && token.value.startsWith('-')) return undefined
    if (file !== undefined) return undefined
    file = readPath(token)
    if (file === undefined) return undefined
  }
  if (stdinMode) {
    if (file !== undefined) return undefined
  } else if (file === undefined) {
    return undefined
  }
  return { stage: { kind: 'cat', number }, ...file === undefined ? {} : { file } }
}

/**
 * @param {Array<object>} args - arguments after `head`.
 * @param {boolean} stdinMode - whether this stage operates on stdin.
 * @returns {{ stage: object, file?: string } | undefined} parsed stage.
 */
function parseHead(args, stdinMode) {
  let count = 10
  let countSeen = false
  let endOptions = false
  let file
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (file !== undefined) return undefined
    if (!endOptions && token.value === '--') {
      endOptions = true
      continue
    }
    if (!endOptions && token.value === '-n') {
      if (countSeen) return undefined
      const next = args[++i]
      const parsed = next === undefined ? undefined : parsePositive(next.value)
      if (parsed === undefined) return undefined
      count = parsed
      countSeen = true
      continue
    }
    if (!endOptions && /^-n\d+$/u.test(token.value)) {
      if (countSeen) return undefined
      count = Number(token.value.slice(2))
      countSeen = true
      continue
    }
    if (!endOptions && /^-\d+$/u.test(token.value)) {
      if (countSeen) return undefined
      count = Number(token.value.slice(1))
      countSeen = true
      continue
    }
    if (!endOptions && token.value.startsWith('-')) return undefined
    if (file !== undefined) return undefined
    file = readPath(token)
    if (file === undefined) return undefined
  }
  if (stdinMode) {
    if (file !== undefined) return undefined
  } else if (file === undefined) {
    return undefined
  }
  return { stage: { kind: 'head', count }, ...file === undefined ? {} : { file } }
}

/**
 * @param {Array<object>} args - arguments after `tail`.
 * @param {boolean} stdinMode - whether this stage operates on stdin.
 * @returns {{ stage: object, file?: string } | undefined} parsed stage.
 */
function parseTail(args, stdinMode) {
  let count = 10
  let from = undefined
  let countSeen = false
  let endOptions = false
  let file
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (file !== undefined) return undefined
    if (!endOptions && token.value === '--') {
      endOptions = true
      continue
    }
    if (!endOptions && token.value === '-n') {
      if (countSeen) return undefined
      const next = args[++i]
      if (next === undefined) return undefined
      if (next.value.startsWith('+')) {
        const parsed = parsePositive(next.value.slice(1))
        if (parsed === undefined) return undefined
        from = parsed
      } else {
        const parsed = parsePositive(next.value)
        if (parsed === undefined) return undefined
        count = parsed
      }
      countSeen = true
      continue
    }
    if (!endOptions && /^-n\+\d+$/u.test(token.value)) {
      if (countSeen) return undefined
      from = Number(token.value.slice(3))
      countSeen = true
      continue
    }
    if (!endOptions && /^-n\d+$/u.test(token.value)) {
      if (countSeen) return undefined
      count = Number(token.value.slice(2))
      countSeen = true
      continue
    }
    if (!endOptions && i === 0 && /^-[1-9]\d*$/u.test(token.value)) {
      if (countSeen) return undefined
      count = parsePositive(token.value.slice(1))
      if (count === undefined) return undefined
      countSeen = true
      continue
    }
    if (!endOptions && token.value.startsWith('-')) return undefined
    if (file !== undefined) return undefined
    file = readPath(token)
    if (file === undefined) return undefined
  }
  if (stdinMode) {
    if (file !== undefined) return undefined
  } else if (file === undefined) {
    return undefined
  }
  return {
    stage: from === undefined ? { kind: 'tail', count } : { kind: 'tail', from },
    ...file === undefined ? {} : { file },
  }
}

/**
 * @param {Array<object>} args - arguments after `sed`.
 * @param {boolean} stdinMode - whether this stage operates on stdin.
 * @returns {{ stage: object, file?: string } | undefined} parsed stage.
 */
function parseSed(args, stdinMode) {
  if (args[0]?.value !== '-n') return undefined
  const script = args[1]
  if (script === undefined) return undefined
  const range = /^(\d+)(?:,(\d+|\$))?p$/u.exec(script.value)
  if (range === null) return undefined
  const start = Number(range[1])
  if (start < 1) return undefined
  let end
  if (range[2] === undefined) {
    end = start
  } else if (range[2] === '$') {
    end = null
  } else {
    end = Number(range[2])
    if (end < start) return undefined
  }

  let file
  let endOptions = false
  for (let i = 2; i < args.length; i++) {
    const token = args[i]
    if (file !== undefined) return undefined
    if (!endOptions && token.value === '--') {
      endOptions = true
      continue
    }
    if (!endOptions && token.value.startsWith('-')) return undefined
    if (file !== undefined) return undefined
    file = readPath(token)
    if (file === undefined) return undefined
  }
  if (stdinMode) {
    if (file !== undefined) return undefined
  } else if (file === undefined) {
    return undefined
  }
  return {
    stage: { kind: 'sed', start, ...end === null ? {} : { end } },
    ...file === undefined ? {} : { file },
  }
}

/**
 * @param {Array<object>} args - arguments after `nl`.
 * @param {boolean} stdinMode - whether this stage operates on stdin.
 * @returns {{ stage: object, file?: string } | undefined} parsed stage.
 */
function parseNl(args, stdinMode) {
  if (args[0]?.value !== '-ba') return undefined
  let file
  let endOptions = false
  for (let i = 1; i < args.length; i++) {
    const token = args[i]
    if (file !== undefined) return undefined
    if (!endOptions && token.value === '--') {
      endOptions = true
      continue
    }
    if (!endOptions && token.value.startsWith('-')) return undefined
    if (file !== undefined) return undefined
    file = readPath(token)
    if (file === undefined) return undefined
  }
  if (stdinMode) {
    if (file !== undefined) return undefined
  } else if (file === undefined) {
    return undefined
  }
  return { stage: { kind: 'nl' }, ...file === undefined ? {} : { file } }
}

/**
 * Validate one path token after quote removal. Quoted glob characters are
 * literal filenames; unquoted ones would be expanded by Bash and are rejected.
 * @param {object} token - a lexed token.
 * @returns {string | undefined} the literal path.
 */
function readPath(token) {
  if (typeof token?.value !== 'string' || token.value === '') return undefined
  if (token.value === '-' || token.value.includes('\0')) return undefined
  if (token.hasUnquotedGlob) return undefined
  return token.value
}

/**
 * Parse a positive decimal count.
 * @param {string} value - token value.
 * @returns {number | undefined} the count.
 */
function parsePositive(value) {
  if (!/^[1-9]\d*$/u.test(value)) return undefined
  const count = Number(value)
  return Number.isSafeInteger(count) ? count : undefined
}
