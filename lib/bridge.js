/**
 * Observation bridge: transports normalize a tool call, exactly one Source
 * accepts it, validated evidence is stashed, and the final-result observer
 * authorizes only the source that stayed visible to the model.
 * @module dsh-fs-observation-bridge/bridge
 */

import { clearPending, flush, stash } from './observation/emit.js'
import { validateEvidence } from './observation/evidence.js'
import { sourceAccepts } from './sources/registry.js'

/**
 * Register the bridge listeners on the plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {readonly object[]} transports - transport registry.
 * @param {readonly object[]} sources - source registry.
 * @returns {void}
 */
export function registerBridge(ctx, transports, sources) {
  ctx.effect(() => () => clearPending(), 'fs-observation-bridge pending teardown')

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    if (result.isError) return decision
    if (exec.parent !== undefined) return decision
    if (exec.agent?.session === undefined) return decision
    if (decision.value !== undefined) return decision
    try {
      const accepted = decision.content === undefined ? result : { ...result, content: decision.content }
      const invocation = await normalizeInvocation(ctx, transports, exec, accepted)
      if (invocation === undefined) return decision
      const matched = sources.filter(source => sourceAccepts(source, invocation))
      if (matched.length !== 1) {
        if (matched.length > 1) {
          warn(ctx, `ambiguous sources for "${exec.name}": ${matched.map(source => source.id).join(', ')}`)
        }
        return decision
      }
      const evidence = await matched[0].extract(invocation, { ctx, exec })
      if (!Array.isArray(evidence) || evidence.length === 0) return decision
      const validated = await validateEvidence(ctx, invocation, evidence, exec.signal)
      stash(exec, validated)
    } catch (error) {
      warn(ctx, `could not validate source for "${exec.name}"`, error)
    }
    return decision
  }, { prepend: true })

  // The final result is frozen and already passed finalizeContent; this is the
  // first point that proves what the model actually receives.
  ctx.on('tools/result', (exec, result) => {
    try {
      flush(ctx, exec, result)
    } catch (error) {
      warn(ctx, 'could not record validated evidence', error)
    }
  })
}

/**
 * Normalize one call through exactly one transport. Overlapping transports are
 * a configuration error, not a precedence decision.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {readonly object[]} transports - transport registry.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the tool call.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - accepted outcome.
 * @returns {Promise<object | undefined>} the normalized invocation.
 */
async function normalizeInvocation(ctx, transports, exec, result) {
  const invocations = []
  for (const transport of transports) {
    if (!transport.match(exec)) continue
    const invocation = await transport.normalize(ctx, exec, result)
    if (invocation !== undefined && invocation !== null) invocations.push(invocation)
  }
  if (invocations.length !== 1) {
    if (invocations.length > 1) {
      warn(ctx, `ambiguous transports for "${exec.name}": ${invocations.map(item => item.transport).join(', ')}`)
    }
    return undefined
  }
  return invocations[0]
}

/**
 * Best-effort diagnostic logging; observer failures never change a result.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} message - diagnostic.
 * @param {unknown} [error] - optional cause.
 * @returns {void}
 */
function warn(ctx, message, error) {
  try {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(`[fs-observation-bridge] ${message}`, error)
    }
  } catch {
    // Logging must never break the tool pipeline.
  }
}
