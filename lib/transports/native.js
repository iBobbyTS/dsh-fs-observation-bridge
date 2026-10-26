/**
 * Native transport: normalize ordinary in-process DSH tools (anything that is
 * not an MCP call or a recognized shell tool) so a Source can accept one.
 * @module dsh-fs-observation-bridge/transports/native
 */

import { sessionCwd } from '../paths.js'
import { textOf } from '../text.js'
import { SHELL_TOOLS } from './cli.js'

/**
 * Create the native transport adapter.
 * @returns {{ id: string, match: (exec: object) => boolean, normalize: Function }} the adapter.
 */
export function nativeTransport() {
  return {
    id: 'native',

    /**
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @returns {boolean} whether the call is an ordinary DSH tool.
     */
    match(exec) {
      return !exec.name.startsWith('mcp__') && !SHELL_TOOLS.has(exec.name)
    },

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
     * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - accepted outcome.
     * @returns {Promise<object>} the normalized invocation.
     */
    async normalize(ctx, exec, result) {
      const cwd = await sessionCwd(ctx, exec)
      return {
        transport: 'native',
        toolName: exec.name,
        operation: exec.name,
        args: exec.arguments ?? {},
        content: textOf(result),
        ...(cwd === undefined ? {} : { cwd }),
      }
    },
  }
}
