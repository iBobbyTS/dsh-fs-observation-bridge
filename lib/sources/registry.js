/**
 * Source registry. A Source declares which normalized invocations it accepts
 * and how to extract source evidence from their output.
 * @module dsh-fs-observation-bridge/sources/registry
 */

/**
 * Freeze a source list for one bridge instance.
 * @param {Array<object>} sources - source adapters.
 * @returns {readonly object[]} the immutable registry.
 */
export function createSourceRegistry(sources) {
  return Object.freeze([...sources])
}

/**
 * Report whether a source accepts a normalized invocation.
 * Transport kinds are open-ended: unknown kinds never match, so a new transport
 * can be added without changing existing sources.
 * @param {object} source - source adapter with `accepts`.
 * @param {object} invocation - normalized invocation.
 * @returns {boolean} whether the source claims the invocation.
 */
export function sourceAccepts(source, invocation) {
  const accepts = source.accepts
  if (!Array.isArray(accepts)) return false
  return accepts.some((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    if (entry.transport !== invocation.transport) return false
    switch (entry.transport) {
      case 'mcp':
        return entry.server === invocation.server
          && Array.isArray(entry.tools)
          && entry.tools.includes(invocation.toolName)
      case 'cli':
        return entry.program === invocation.program
          && Array.isArray(entry.operations)
          && entry.operations.includes(invocation.operation)
      case 'native':
        return Array.isArray(entry.tools) && entry.tools.includes(invocation.toolName)
      default:
        return false
    }
  })
}
