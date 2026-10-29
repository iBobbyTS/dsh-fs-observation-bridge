/**
 * Shell-read source: convert one validated ReadPlan invocation into evidence
 * that the observation core can verify against the current file content.
 * @module dsh-fs-observation-bridge/sources/shell-read
 */

import { renderReadPlan } from './shell-read-render.js'

/**
 * The built-in shell-read source.
 *
 * The transport admits only a closed read grammar and clean, untruncated
 * foreground results. Exact readers provide a replay function; search programs
 * provide actual stdout plus declared scopes for source-line validation. The
 * observation core owns filesystem identity, freshness and final visibility.
 */
export const shellReadSource = {
  id: 'shell-read',

  accepts: [
    { transport: 'shell-read', dialects: ['bash'] },
  ],

  /**
   * @param {object} invocation - normalized shell-read invocation.
   * @returns {Array<object>} evidence items for the observation core.
   */
  extract(invocation) {
    if (invocation.dialect !== 'bash') return []
    const plan = invocation.plan
    if (plan?.kind === 'search-program') {
      return typeof invocation.stdout === 'string'
        ? [{ kind: 'shell-search-program', plan, expectedStdout: invocation.stdout }]
        : []
    }
    if (plan?.kind === 'program') {
      return typeof invocation.stdout === 'string'
        ? [{ kind: 'shell-read-program', plan, expectedStdout: invocation.stdout }]
        : []
    }
    if (plan === null || typeof plan !== 'object' || typeof plan.file !== 'string' || plan.file === '') return []
    const expectedStdout = invocation.stdout
    if (typeof expectedStdout !== 'string') return []
    return [{
      path: plan.file,
      stable: true,
      strictFinal: true,
      expectedStdout,
      permitEmpty: plan.permitEmpty === true,
      /**
       * Replay the plan over current file content. The core compares this with
       * the structured stdout the model actually received.
       * @param {string} content - current file text.
       * @returns {string} expected stdout.
       */
      verify(content) {
        return renderReadPlan(plan, content)
      },
    }]
  },
}
