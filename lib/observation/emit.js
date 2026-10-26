/**
 * Deferred authorization: `tools/post-execute` validates evidence, then the
 * synchronous `tools/result` observer confirms the final model-visible content
 * still contains that source before emitting `fs/observed`.
 *
 * This two-phase split matters because `finalizeContent` and later
 * post-execute listeners can still rewrite or drop the source after the
 * validation phase; an observation must describe what the model actually saw.
 * @module dsh-fs-observation-bridge/observation/emit
 */

import { normalizeNewlines, textOf } from '../text.js'

/** Upper bound on stashed calls awaiting their final result. */
const MAX_PENDING = 1024

/** Validated evidence keyed by the tool call awaiting its final result. */
const pending = new Map()

/**
 * Stash validated evidence for the final-result phase.
 * @param {{ callId: string }} exec - the tool call.
 * @param {Array<object>} validated - validated source evidence.
 * @returns {void}
 */
export function stash(exec, validated) {
  if (!Array.isArray(validated) || validated.length === 0) return
  pending.set(exec.callId, validated)
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next()
    if (oldest.done) break
    pending.delete(oldest.value)
  }
}

/**
 * Confirm the final result still shows the validated snippets, then emit
 * `fs/observed` for each file. Runs synchronously inside `tools/result`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec - the finished call.
 * @param {import('@deepseek-ai/dsh-tools').ToolExecutionResult} result - the frozen final outcome.
 * @returns {void}
 */
export function flush(ctx, exec, result) {
  const validated = pending.get(exec.callId)
  if (validated === undefined) return
  pending.delete(exec.callId)
  if (result.isError) return
  if (exec.agent?.session === undefined) return
  const finalText = visibleContent(normalizeNewlines(textOf(result)))
  if (finalText === '') return
  const seen = new Set()
  for (const item of validated) {
    if (seen.has(item.target.targetKey)) continue
    if (!item.snippets.some(snippet => finalContentShows(finalText, snippet.text))) continue
    seen.add(item.target.targetKey)
    ctx.emit('fs/observed', item.target, { kind: 'present', version: item.version }, exec)
  }
}

/**
 * Report whether the final model-visible result still shows a snippet. Markdown
 * output carries source lines directly (with optional line-number prefixes);
 * JSON output carries them as escaped strings inside `codeBlocks.content`.
 * @param {string} finalText - LF-normalized final result text.
 * @param {string} snippetText - validated snippet text.
 * @returns {boolean} whether the snippet is present.
 */
function finalContentShows(finalText, snippetText) {
  const normalized = normalizeNewlines(snippetText)
  if (visibleContent(finalText).includes(normalized)) return true
  return finalText.includes(JSON.stringify(snippetText).slice(1, -1))
}

/**
 * Drop CodeGraph's line-number prefixes so the final visible content compares
 * against validated snippet text. The parser strips `N\t` inside source blocks;
 * the model-visible result still carries those prefixes.
 * @param {string} text - LF-normalized result text.
 * @returns {string} text without leading line numbers.
 */
function visibleContent(text) {
  return text.split('\n').map(line => line.replace(/^\d+\t/u, '')).join('\n')
}

/**
 * Drop all pending evidence (tests / disposal safety).
 * @returns {void}
 */
export function clearPending() {
  pending.clear()
}
