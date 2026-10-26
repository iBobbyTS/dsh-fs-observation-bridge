/**
 * MCP transport: recognize `mcp__<server>__<tool>` calls and normalize their
 * identity, arguments, text output, and Session directory.
 * @module dsh-fs-observation-bridge/transports/mcp
 */

import { sessionCwd } from '../paths.js'
import { textOf } from '../text.js'

/** Public MCP tool name: `mcp__<server>__<rawName>`. */
const MCP_NAME = /^mcp__(.+?)__(.+)$/u

/**
 * Create the MCP transport adapter.
 * @returns {{ id: string, match: (exec: object) => boolean, normalize: Function }} the adapter.
 */
export function mcpTransport() {
  return {
    id: 'mcp',

    /**
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @returns {boolean} whether the call is an MCP tool.
     */
    match(exec) {
      return MCP_NAME.test(exec.name)
    },

    /**
     * Normalize one MCP call. The raw tool name keeps its server prefix
     * (`codegraph_explore`), because that is what the server declared.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - accepted outcome.
     * @returns {Promise<object | null>} the normalized invocation.
     */
    async normalize(ctx, exec, result) {
      const match = MCP_NAME.exec(exec.name)
      if (match === null) return null
      const cwd = await sessionCwd(ctx, exec)
      return {
        transport: 'mcp',
        server: match[1],
        toolName: match[2],
        operation: match[2],
        args: exec.arguments ?? {},
        content: textOf(result),
        ...(cwd === undefined ? {} : { cwd }),
      }
    },
  }
}
