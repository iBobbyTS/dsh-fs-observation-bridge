/**
 * All-or-nothing evidence validation of a closed, read-only shell program. Validate the complete
 * stdout (including literal separators), never split on echo markers or search
 * for a matching substring. A failure in any input invalidates the whole group.
 * @module dsh-fs-observation-bridge/observation/shell-program
 */
import { isAbsolute } from 'node:path'
import { note } from '../diagnostics.js'
import { selectAwkRecords } from '../transports/awk-read.js'
import { renderReadPlan } from '../sources/shell-read-render.js'
import { normalizeCrlf } from '../text.js'

const MAX_REPLAY_LINES = 200_000

/** Read snapshots, replay, then recheck every version before publishing evidence. */
export async function validateShellProgram(ctx, item, signal, limits) {
  const reject = reason => { note(ctx, reason, { source: 'shell-read-program' }); return [] }
  const steps = item.plan?.steps
  if (!Array.isArray(steps) || typeof item.expectedStdout !== 'string') return reject('invalid_program')
  const reads = steps.filter(step => step.kind === 'read')
  const files = reads.flatMap(step => step.files)
  if (files.length === 0 || files.length > limits.maxEvidenceFiles) return reject('program_limit')
  const byPath = new Map()
  const snapshots = new Map()
  let totalBytes = 0
  try {
    for (const step of steps) {
      if (step.kind !== 'cd') continue
      if (!isAbsolute(step.path)) return reject('unresolved_program_path')
      const target = await ctx.fs.resolve(step.path, { signal })
      if ((await ctx.fs.stat(target, signal))?.type !== 'directory') return reject('invalid_program_cwd')
    }
    for (const path of files) {
      if (signal.aborted) return reject('program_aborted')
      if (byPath.has(path)) continue
      if (typeof path !== 'string' || !isAbsolute(path)) return reject('unresolved_program_path')
      const target = await ctx.fs.resolve(path, { signal })
      const info = await ctx.fs.stat(target, signal)
      if (info?.type !== 'file') return reject('unreadable_program_input')
      if (info.size !== undefined && info.size > limits.maxSourceBytes) return reject('program_limit')
      let snapshot = snapshots.get(target.targetKey)
      if (snapshot !== undefined) {
        if (snapshot.version !== info.version) return reject('revision_changed')
      } else {
        const content = await ctx.fs.readText(target, signal)
        totalBytes += Buffer.byteLength(content, 'utf8')
        if (totalBytes > limits.maxSourceBytes) return reject('program_limit')
        if ((await ctx.fs.stat(target, signal))?.version !== info.version) return reject('revision_changed')
        snapshot = { target, version: info.version, content }
        snapshots.set(target.targetKey, snapshot)
      }
      byPath.set(path, snapshot)
    }
    const stdout = normalizeCrlf(item.expectedStdout)
    const observed = new Set()
    let expected = ''
    let replayBytes = 0
    for (const step of steps) {
      if (signal.aborted) return reject('program_aborted')
      if (step.kind === 'literal') {
        expected += normalizeCrlf(step.text)
      } else if (step.kind === 'read') {
        const inputs = step.files.map(path => byPath.get(path))
        for (const input of inputs) replayBytes += Buffer.byteLength(input.content, 'utf8')
        if (replayBytes > limits.maxSourceBytes) return reject('program_limit')
        const spans = []
        let content = ''
        for (const input of inputs) {
          const text = normalizeCrlf(input.content)
          spans.push({ start: content.length, end: content.length + text.length, key: input.target.targetKey })
          content += text
        }
        const visible = visibleInputs(content, spans, step.stages)
        const output = renderReadPlan({ stages: step.stages }, content)
        expected += output
        // A cat concatenation can be followed by a selector. Only files with
        // retained source characters count; files cut off by head are not read
        // evidence merely because their paths occurred in argv.
        if (output !== '') {
          for (const key of visible) observed.add(key)
        }
      } else if (step.kind !== 'cd') return reject('invalid_program')
      if (expected.length > stdout.length) return reject('content_mismatch')
    }
    if (expected !== stdout) return reject('content_mismatch')
    if (observed.size === 0) return reject('empty_evidence')
    // Rechecking only after each individual read is insufficient: a later
    // read could race a mutation of an earlier file. Do one group-wide pass.
    for (const snapshot of snapshots.values()) {
      if (signal.aborted) return reject('program_aborted')
      if ((await ctx.fs.stat(snapshot.target, signal))?.version !== snapshot.version) return reject('revision_changed')
    }
    return [...observed].map(key => {
      const { target, version } = snapshots.get(key)
      return { target, version, snippets: [], expected, strictFinal: true }
    })
  } catch {
    return reject('program_validation_failed')
  }
}

/** Track original character intervals through line-preserving selectors. */
export function visibleInputs(text, spans, stages) {
  let lines = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue
    lines.push({ start, end: i + 1, rendered: text.slice(start, i + 1) }); start = i + 1
    if (lines.length > MAX_REPLAY_LINES) throw new Error('too many replay lines')
  }
  if (start < text.length) lines.push({ start, end: text.length, rendered: text.slice(start) })
  for (const stage of stages) {
    const input = lines.map(line => line.rendered).join('')
    let chosen = lines
    switch (stage.kind) {
      case 'cat': case 'nl': break
      case 'head': chosen = lines.slice(0, stage.count); break
      case 'tail': chosen = stage.from !== undefined ? lines.slice(stage.from - 1)
        : stage.count === 0 ? [] : lines.slice(-stage.count); break
      case 'awk': chosen = selectAwkRecords(stage, input).map(row => lines[row.number - 1]); break
      case 'sed': chosen = lines.slice(stage.start - 1, stage.end); break
      default: throw new Error('unknown provenance selector')
    }
    const output = renderReadPlan({ stages: [stage] }, input)
    const rendered = output.match(/[^\n]*\n|[^\n]+$/gu) ?? []
    if (rendered.length !== chosen.length) throw new Error('unmapped replay lines')
    lines = chosen.map((line, i) => ({ ...line, rendered: rendered[i] }))
  }
  const visible = new Set()
  for (const span of spans) {
    if (span.end > span.start && lines.some(line => line.start < span.end && line.end > span.start)) visible.add(span.key)
  }
  return visible
}
