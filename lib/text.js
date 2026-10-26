/**
 * Text helpers shared by transports and the observation core.
 * @module dsh-fs-observation-bridge/text
 */

/**
 * Concatenate the text blocks of a tool outcome.
 * @param {{ content?: unknown } | undefined} result - a tool result view.
 * @returns {string} the model-visible text, or an empty string.
 */
export function textOf(result) {
  const content = result?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Normalize CRLF/CR line endings to LF so evidence and current-file content
 * compare on one basis.
 * @param {string} text - arbitrary text.
 * @returns {string} LF-normalized text.
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/gu, '\n')
}
