/**
 * Pure PowerShell read-plan replay.
 *
 * PowerShell does not copy a file's bytes to stdout: `Get-Content` emits one
 * string object per line (line terminators consumed), and the host writes each
 * formatted object followed by its own newline. `-Raw` emits one string holding
 * the whole file and the host appends one more newline. This renderer models
 * exactly that, so a replay can be compared with the structured stdout the
 * model actually received.
 *
 * Only CRLF/LF line-ending representation is normalized; line bodies, blank
 * lines, tabs, trailing spaces, and a missing final newline are preserved
 * exactly. A file whose lines do not split the way `StreamReader.ReadLine`
 * splits them (for example mixed lone CR and CRLF) fails the comparison and is
 * never observed.
 * @module dsh-fs-observation-bridge/sources/powershell-read-render
 */

import { normalizeCrlf } from '../text.js'

/**
 * Replay a PowerShell read plan over current file content.
 * @param {object} plan - normalized plan (`mode` plus `selectors`).
 * @param {string} content - current file text.
 * @returns {string} the expected stdout.
 */
export function renderPowerShellOutput(plan, content) {
  const text = normalizeCrlf(content)
  if (plan.mode === 'raw') {
    // Get-Content -Raw returns no object for an empty file; otherwise the host
    // writes the string plus one newline.
    return text === '' ? '' : `${text}\n`
  }

  let lines = splitLines(text)
  for (const selector of plan.selectors) lines = applySelector(selector, lines)
  if (lines.length === 0) return ''
  return `${lines.join('\n')}\n`
}

/**
 * Split text into PowerShell line objects: `StreamReader.ReadLine` treats CRLF,
 * a lone CR, and a lone LF as terminators, and a trailing terminator does not
 * create an extra empty line.
 * @param {string} text - text with CRLF already collapsed to LF.
 * @returns {string[]} line bodies.
 */
function splitLines(text) {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/u)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * @param {object} selector - one plan selector.
 * @param {string[]} lines - current line objects.
 * @returns {string[]} the selected line objects.
 */
function applySelector(selector, lines) {
  switch (selector.kind) {
    case 'first':
      return lines.slice(0, selector.count)
    case 'last':
      return lines.slice(-selector.count)
    case 'skip':
      return lines.slice(selector.count)
    case 'index':
      return lines.slice(selector.index, selector.index + 1)
    default:
      throw new Error(`unknown powershell read selector: ${selector.kind}`)
  }
}
