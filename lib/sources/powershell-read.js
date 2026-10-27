/**
 * PowerShell read source: convert one validated PowerShell ReadPlan invocation
 * into evidence the observation core can verify against current file content.
 * @module dsh-fs-observation-bridge/sources/powershell-read
 */

import { renderPowerShellOutput } from './powershell-read-render.js'

/**
 * The built-in PowerShell read source.
 *
 * The transport already checked that the command is a deterministic
 * single-file grammar and that its execution was a clean, untruncated
 * foreground `pwsh` success. This source only supplies the replay function; the
 * observation core performs the filesystem/version/exact-output validation
 * against DSH's own text read, which is what decides whether the on-disk
 * encoding matches what PowerShell printed.
 */
export const powershellReadSource = {
  id: 'powershell-read',

  accepts: [
    { transport: 'shell-read', dialects: ['powershell'] },
  ],

  /**
   * @param {object} invocation - normalized PowerShell read invocation.
   * @returns {Array<object>} evidence items for the observation core.
   */
  extract(invocation) {
    if (invocation?.dialect !== 'powershell') return []
    const plan = invocation.plan
    if (plan === null || typeof plan !== 'object') return []
    if (typeof plan.file !== 'string' || plan.file === '') return []
    if (plan.mode !== 'lines' && plan.mode !== 'raw') return []
    if (!Array.isArray(plan.selectors)) return []
    const expectedStdout = invocation.stdout
    if (typeof expectedStdout !== 'string') return []
    return [{
      path: plan.file,
      stable: true,
      expectedStdout,
      permitEmpty: plan.permitEmpty === true,
      /**
       * Replay the plan over current file content. The core compares this with
       * the structured stdout the model actually received.
       * @param {string} content - current file text.
       * @returns {string} expected stdout.
       */
      verify(content) {
        return renderPowerShellOutput(plan, content)
      },
    }]
  },
}
