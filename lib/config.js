/**
 * Deployment configuration for the observation bridge.
 *
 * The schema is validated here rather than through a Cordis Config schema so
 * the bridge keeps zero package dependencies: a profile passes the fields under
 * the plugin row's `config` key and invalid values fail at activation.
 * @module dsh-fs-observation-bridge/config
 */

/** Default largest file read to verify snippets (8 MiB). */
export const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024

/** Default largest number of evidence files validated per tool result. */
export const DEFAULT_MAX_EVIDENCE_FILES = 200

/**
 * Resolve and validate the plugin config.
 * @param {unknown} raw - the loader-provided config object.
 * @returns {{ maxSourceBytes: number, maxEvidenceFiles: number, disabledSources: readonly string[] }}
 *   the resolved config.
 * @throws {TypeError} when a field has the wrong type or an invalid value.
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('config must be an object')
  }
  const maxSourceBytes = config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  if (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1) {
    throw new TypeError('config.maxSourceBytes must be a positive integer')
  }
  const maxEvidenceFiles = config.maxEvidenceFiles ?? DEFAULT_MAX_EVIDENCE_FILES
  if (!Number.isInteger(maxEvidenceFiles) || maxEvidenceFiles < 1) {
    throw new TypeError('config.maxEvidenceFiles must be a positive integer')
  }
  const disabledSources = config.disabledSources ?? []
  if (!Array.isArray(disabledSources) || disabledSources.some(id => typeof id !== 'string' || id === '')) {
    throw new TypeError('config.disabledSources must be an array of non-empty source ids')
  }
  return Object.freeze({
    maxSourceBytes,
    maxEvidenceFiles,
    disabledSources: Object.freeze([...new Set(disabledSources)]),
  })
}

/**
 * Filter the built-in sources by the config's disabled ids. Unknown ids fail
 * loud so a typo cannot silently leave an unwanted source active.
 * @param {readonly object[]} sources - all built-in sources.
 * @param {readonly string[]} disabledSources - ids to disable.
 * @returns {readonly object[]} the active sources.
 * @throws {TypeError} when a disabled id names no built-in source.
 */
export function selectSources(sources, disabledSources) {
  const known = new Set(sources.map(source => source.id))
  for (const id of disabledSources) {
    if (!known.has(id)) {
      throw new TypeError(`config.disabledSources names unknown source "${id}" (known: ${[...known].join(', ')})`)
    }
  }
  return sources.filter(source => !disabledSources.includes(source.id))
}
