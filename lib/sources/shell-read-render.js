/**
 * Pure ReadPlan replay. Given the current file text, reproduce exactly what
 * the allowed command pipeline would write to stdout, preserving missing
 * trailing newlines and blank lines.
 * @module dsh-fs-observation-bridge/sources/shell-read-render
 */

import { normalizeCrlf } from '../text.js'

/**
 * Replay a shell-read plan over current file content.
 * @param {object} plan - normalized plan.
 * @param {string} content - current file text.
 * @returns {string} the expected stdout.
 */
export function renderReadPlan(plan, content) {
  let text = normalizeCrlf(content)
  for (const stage of plan.stages) text = applyStage(stage, text)
  return text
}

/**
 * @param {object} stage - one plan stage.
 * @param {string} text - current pipeline text.
 * @returns {string} the next pipeline text.
 */
function applyStage(stage, text) {
  switch (stage.kind) {
    case 'cat':
      return stage.number === 'none' ? text : numberLines(text, stage.number)
    case 'head':
      return linesOf(text).slice(0, stage.count).join('')
    case 'tail':
      return tailOf(text, stage)
    case 'sed':
      return sedOf(text, stage)
    case 'nl':
      return numberLines(text, 'all')
    default:
      throw new Error(`unknown shell-read stage: ${stage.kind}`)
  }
}

/**
 * Split text into line segments that keep their line terminators. This keeps a
 * missing final newline and consecutive blank lines byte-exact.
 * @param {string} text - LF-normalized text.
 * @returns {string[]} line segments.
 */
function linesOf(text) {
  if (text === '') return []
  const lines = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      lines.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/**
 * @param {string} text - LF-normalized text.
 * @param {{ count?: number, from?: number }} stage - tail stage.
 * @returns {string} selected tail text.
 */
function tailOf(text, stage) {
  const lines = linesOf(text)
  if (stage.from !== undefined) return lines.slice(stage.from - 1).join('')
  if (stage.count === 0) return ''
  return lines.slice(-stage.count).join('')
}

/**
 * @param {string} text - LF-normalized text.
 * @param {{ start: number, end?: number }} stage - sed stage.
 * @returns {string} selected range.
 */
function sedOf(text, stage) {
  const lines = linesOf(text)
  return lines.slice(stage.start - 1, stage.end === undefined ? lines.length : stage.end).join('')
}

/**
 * Reproduce `cat -n`, `cat -b`, and `nl -ba` gutter formatting (width 6, tab).
 * @param {string} text - LF-normalized text.
 * @param {'all' | 'nonblank'} mode - number every line or non-blank lines only.
 * @returns {string} numbered text.
 */
function numberLines(text, mode) {
  let number = 0
  let output = ''
  for (const line of linesOf(text)) {
    const hasNewline = line.endsWith('\n')
    const body = hasNewline ? line.slice(0, -1) : line
    let prefix = ''
    if (mode === 'all' || body !== '') {
      number += 1
      prefix = `${String(number).padStart(6, ' ')}\t`
    }
    output += `${prefix}${body}${hasNewline ? '\n' : ''}`
  }
  return output
}
