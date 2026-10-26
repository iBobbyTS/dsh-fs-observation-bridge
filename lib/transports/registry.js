/**
 * Transport registry. Transports are the input channels (MCP, CLI, native,
 * third-party); each one normalizes a tool call into a shared invocation.
 * @module dsh-fs-observation-bridge/transports/registry
 */

/**
 * Freeze a transport list for one bridge instance. Adding a transport is
 * appending to this list; the bridge does not hard-code the built-ins.
 * @param {Array<object>} transports - transport adapters.
 * @returns {readonly object[]} the immutable registry.
 */
export function createTransportRegistry(transports) {
  return Object.freeze([...transports])
}
