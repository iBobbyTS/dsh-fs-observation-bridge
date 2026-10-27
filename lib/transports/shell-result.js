/**
 * Shared narrowing for a completed shell call. Bash and PowerShell expose the
 * same normalized foreground shape, so both read transports apply the same
 * success checks before anything is treated as model-visible source.
 * @module dsh-fs-observation-bridge/transports/shell-result
 */

/**
 * Narrow a normal foreground shell result value. Persistent shells use a
 * different schema (plain text or a PTY stream) and are intentionally
 * unsupported.
 * @param {object | undefined} result - the accepted tool result.
 * @returns {object | undefined} the foreground value, if present.
 */
export function foregroundValue(result) {
  const value = result?.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.kind !== 'foreground') return undefined
  if (value.stdout === null || typeof value.stdout !== 'object') return undefined
  if (value.stderr === null || typeof value.stderr !== 'object') return undefined
  if (typeof value.stdout.text !== 'string' || typeof value.stderr.text !== 'string') return undefined
  if (typeof value.stdout.truncated !== 'boolean' || typeof value.stderr.truncated !== 'boolean') return undefined
  return value
}

/**
 * Whether a foreground shell result is a clean, complete success whose output
 * the model actually saw in full. A cmdlet's non-terminating error does not
 * always produce a non-zero exit code, so stderr must also be empty.
 * @param {object} value - foreground shell result.
 * @returns {boolean} whether the call is a clean, non-truncated, non-sandboxed success.
 */
export function successful(value) {
  return value.exitCode === 0
    && value.signal === null
    && value.timedOut !== true
    && value.aborted !== true
    && value.stopped === undefined
    && value.stdout.truncated === false
    && value.stderr.truncated === false
    && value.stderr.text === ''
    && value.stdout.spillPath === undefined
    && value.stderr.spillPath === undefined
    && value.sandbox?.denied !== true
    && value.sandbox?.runnerFailed !== true
}
