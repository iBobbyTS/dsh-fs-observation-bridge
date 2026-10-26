/**
 * CodeGraph source adapter: one source accepting both the MCP and CLI
 * transports, sharing one output parser and one project-root rule.
 * @module dsh-fs-observation-bridge/sources/codegraph
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { findAncestor } from '../paths.js'
import { codegraphProjectPath, parseCodegraphEvidence } from './codegraph-output.js'

/**
 * The built-in CodeGraph source.
 * - MCP: the MCP server named `codegraph`, raw tools `codegraph_explore`,
 *   `codegraph_node`, `codegraph_context`.
 * - CLI: the `codegraph` program, operations `explore`, `context`, `node`.
 */
export const codegraphSource = {
  id: 'codegraph',

  accepts: [
    {
      transport: 'mcp',
      server: 'codegraph',
      tools: ['codegraph_explore', 'codegraph_node', 'codegraph_context'],
    },
    {
      transport: 'cli',
      program: 'codegraph',
      operations: ['explore', 'context', 'node'],
    },
  ],

  /**
   * Extract source evidence and attach the project root.
   * @param {object} invocation - normalized invocation.
   * @returns {Array<object>} source evidence.
   */
  extract(invocation) {
    const evidence = parseCodegraphEvidence(invocation.content)
    if (evidence.length === 0) return []
    const base = projectBase(invocation)
    if (base === undefined) return evidence
    const root = resolveRoot(base)
    return evidence.map(item => ({ ...item, root }))
  },

  /**
   * The nearest CodeGraph project root at or above `base`.
   * @param {string} base - a project directory or any directory inside it.
   * @returns {string} the indexed ancestor, or `base` when none is found.
   */
  resolveRoot,
}

/**
 * The project directory the invocation declared, resolved against its cwd.
 * @param {object} invocation - normalized invocation.
 * @returns {string | undefined} the declared base directory.
 */
function projectBase(invocation) {
  const cwd = invocation.cwd
  let declared
  if (invocation.transport === 'mcp' || invocation.transport === 'native') {
    declared = invocation.args?.projectPath
  } else if (invocation.transport === 'cli') {
    declared = codegraphProjectPath(invocation.args?.tokens)
  }
  if (typeof declared !== 'string' || declared === '') return cwd
  if (isAbsolute(declared)) return declared
  return cwd === undefined ? undefined : resolve(cwd, declared)
}

/**
 * The nearest CodeGraph project root at or above `base`.
 * @param {string} base - a project directory or any directory inside it.
 * @returns {string} the indexed ancestor, or `base` when none is found.
 */
function resolveRoot(base) {
  return findAncestor(base, dir => existsSync(join(dir, '.codegraph', 'codegraph.db'))) ?? base
}
