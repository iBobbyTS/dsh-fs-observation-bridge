/**
 * Evidence validation: before anything is authorized, the source's snippets
 * must still exist in the current file. A tool that only names a path, a symbol,
 * or a line range therefore cannot satisfy read-before-edit.
 * @module dsh-fs-observation-bridge/observation/evidence
 */

import { isAbsolute, join } from 'node:path'
import { DEFAULT_MAX_EVIDENCE_FILES, DEFAULT_MAX_SOURCE_BYTES } from '../config.js'
import { note } from '../diagnostics.js'
import { normalizeCrlf, normalizeNewlines } from '../text.js'
import { validateSearchProgram } from './search-program.js'
import { validateShellProgram } from './shell-program.js'

/**
 * Validate source evidence against the current filesystem.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `fs`.
 * @param {object} invocation - normalized invocation (supplies a cwd fallback).
 * @param {Array<object>} evidence - source evidence from a Source.
 * @param {AbortSignal} signal - the tool call's cancellation signal.
 * @param {{ maxSourceBytes?: number, maxEvidenceFiles?: number }} [limits] - resolved limits.
 * @returns {Promise<Array<{ target: object, version: string, snippets: object[] }>>}
 *   files whose shown snippets still match their current content.
 */
export async function validateEvidence(ctx, invocation, evidence, signal, limits = {}) {
  const maxSourceBytes = limits.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const maxEvidenceFiles = limits.maxEvidenceFiles ?? DEFAULT_MAX_EVIDENCE_FILES
  const validated = []
  for (const item of evidence.slice(0, maxEvidenceFiles)) {
    if (signal.aborted) return validated
    if (item.kind === 'shell-search-program') {
      validated.push(...await validateSearchProgram(ctx, item, signal, { maxSourceBytes, maxEvidenceFiles }))
      continue
    }
    if (item.kind === 'shell-read-program') {
      // A compound transcript is one validation unit: never validate a prefix
      // or authorize the other files after a sibling fails.
      const group = await validateShellProgram(ctx, item, signal, { maxSourceBytes, maxEvidenceFiles })
      validated.push(...group)
      continue
    }
    const absolute = absolutePath(item, invocation)
    if (absolute === undefined) continue
    try {
      const target = await ctx.fs.resolve(absolute, { signal })
      const info = await ctx.fs.stat(target, signal)
      if (info?.type !== 'file') continue
      if (info.size !== undefined && info.size > maxSourceBytes) continue
      // The version describes the file before the verification read; a change
      // after this point leaves the observation stale, which is the safe side.
      const version = info.version
      const rawContent = await ctx.fs.readText(target, signal)
      const content = normalizeNewlines(rawContent)
      if (Buffer.byteLength(rawContent, 'utf8') > maxSourceBytes) continue
      if (item.stable === true) {
        // Shell evidence additionally requires the file to be unchanged across
        // the verification read; comparing the opaque versions is enough.
        const after = await ctx.fs.stat(target, signal)
        if (after?.version !== version) {
          note(ctx, 'revision_changed', { path: target.displayPath })
          continue
        }
      }

      let snippets
      let expected
      if (typeof item.verify === 'function') {
        // Exact replay sources own their own stdout reconstruction. The full
        // expected output must equal the structured stdout the model received;
        // no trimming or free-form substring matching is allowed here.
        expected = normalizeCrlf(item.verify(rawContent))
        if (expected !== normalizeCrlf(item.expectedStdout ?? '')) {
          note(ctx, 'content_mismatch', { path: target.displayPath })
          continue
        }
        if (expected === '' && item.permitEmpty !== true) {
          note(ctx, 'empty_evidence', { path: target.displayPath })
          continue
        }
        snippets = expected === '' ? [] : [{ text: expected }]
      } else {
        snippets = item.snippets.filter(snippet => snippetMatches(content, snippet))
      }
      if (snippets.length === 0 && item.permitEmpty !== true) {
        note(ctx, 'empty_evidence', { path: target.displayPath })
        continue
      }
      validated.push({
        target,
        version,
        snippets,
        ...item.strictFinal === true ? { strictFinal: true } : {},
        ...expected === undefined ? {} : { expected },
        ...item.permitEmpty === true ? { permitEmpty: true } : {},
      })
    } catch {
      // An unreadable file contributes nothing; sibling evidence still counts.
    }
  }
  return validated
}

/**
 * Resolve one evidence path against its project root or the invocation cwd.
 * @param {{ path: string, root?: string }} item - source evidence.
 * @param {object} invocation - normalized invocation.
 * @returns {string | undefined} an absolute path.
 */
function absolutePath(item, invocation) {
  if (isAbsolute(item.path)) return item.path
  if (typeof item.root === 'string' && item.root !== '') return join(item.root, item.path)
  if (typeof invocation.cwd === 'string' && invocation.cwd !== '') return join(invocation.cwd, item.path)
  return undefined
}

/**
 * Report whether a snippet still appears in the current file content. A line
 * range is checked first; a moved snippet still counts when its exact text is
 * present somewhere in the file.
 * @param {string} content - LF-normalized current file content.
 * @param {{ text: string, startLine?: number, endLine?: number }} snippet - shown source.
 * @returns {boolean} whether the snippet is current.
 */
function snippetMatches(content, snippet) {
  const text = normalizeNewlines(snippet.text)
  if (text === '') return false
  if (snippet.startLine !== undefined) {
    const lines = content.split('\n')
    const endLine = snippet.endLine ?? snippet.startLine
    const slice = lines.slice(snippet.startLine - 1, endLine).join('\n')
    if (slice === text) return true
  }
  return content.includes(text)
}
