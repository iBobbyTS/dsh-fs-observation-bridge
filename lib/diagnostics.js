/**
 * Structured, model-invisible rejection diagnostics. The bridge never changes
 * a tool result to report an observation refusal; a deployment that wants
 * counters can attach a logger and aggregate these debug records.
 * @module dsh-fs-observation-bridge/diagnostics
 */

/**
 * Record one rejection reason at debug level.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} reason - stable reason code.
 * @param {object} [detail] - bounded structured detail.
 * @returns {void}
 */
export function note(ctx, reason, detail = {}) {
  try {
    const logger = ctx?.logger
    if (logger !== undefined && typeof logger.debug === 'function') {
      logger.debug(`[fs-observation-bridge] ${reason}`, detail)
    }
  } catch {
    // Diagnostics must never affect the tool pipeline.
  }
}
