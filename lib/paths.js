/**
 * Path and Session-directory helpers shared by transports and sources.
 * @module dsh-fs-observation-bridge/paths
 */

import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Resolve the Session's current directory for a tool call.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
 * @returns {Promise<string | undefined>} the directory, when the service exists.
 */
export async function sessionCwd(ctx, exec) {
  if (exec.agent === undefined) return undefined
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined || workingDirectory === null) return undefined
  try {
    return await workingDirectory.ensure(exec.agent, exec.signal)
  } catch {
    return undefined
  }
}

/**
 * Resolve a tool call's `workdir` against the Session directory, mirroring the
 * shell tools: an absent value uses the Session directory and a relative value
 * resolves under it.
 * @param {unknown} modelWorkdir - the call's `workdir` argument.
 * @param {string} cwd - the Session directory.
 * @returns {string} the effective working directory.
 */
export function resolveWorkdir(modelWorkdir, cwd) {
  if (typeof modelWorkdir !== 'string' || modelWorkdir === '') return cwd
  return isAbsolute(modelWorkdir) ? modelWorkdir : join(cwd, modelWorkdir)
}

/**
 * Walk up from a path to the first ancestor satisfying a predicate.
 * @param {string} start - a directory or any path inside it.
 * @param {(dir: string) => boolean} predicate - ancestor test.
 * @returns {string | undefined} the first matching ancestor.
 */
export function findAncestor(start, predicate) {
  let current = resolve(start)
  for (;;) {
    if (predicate(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
