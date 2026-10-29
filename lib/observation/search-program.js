/**
 * Search evidence verifier. Actual stdout is the evidence; rereads only check
 * its file/line identity and freshness. Regex matching is deliberately not
 * replayed. Bounded transcript segmentation keeps only universally attributable targets.
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { note } from '../diagnostics.js'
import { normalizeCrlf } from '../text.js'
import { renderReadPlan } from '../sources/shell-read-render.js'
import { visibleInputs } from './shell-program.js'

const MAX_OUTPUT = 1024 * 1024
const MAX_RECORDS = 16_384
const MAX_STATES = 4096
const MAX_WORK = 100_000
const MAX_PATH_SPLITS = 64
const contained = (root, file) => { const r = relative(root, file); return r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') }
const positive = value => Number.isSafeInteger(value) && value > 0

/** Validate a bounded program without spawning grep, rg, awk or a shell. */
export async function validateSearchProgram(ctx, item, signal, limits) {
  const reject = reason => { note(ctx, reason, { source: 'shell-search' }); return [] }
  if (!Array.isArray(item.plan?.steps) || typeof item.expectedStdout !== 'string') return reject('invalid_program')
  const stdout = normalizeCrlf(item.expectedStdout)
  if (!stdout || Buffer.byteLength(stdout) > MAX_OUTPUT || /[\0\x1b]/u.test(stdout)) return reject('invalid_search_output')
  const snapshots = new Map(), byPath = new Map(), lineIndexes = new WeakMap()
  let totalBytes = 0, work = 0, states = 0
  const check = () => { if (signal.aborted) throw new Error('program_aborted'); if (++work > MAX_WORK) throw new Error('search_work_limit') }
  const load = async path => {
    check()
    if (byPath.has(path)) return byPath.get(path)
    const target = await ctx.fs.resolve(path, { signal })
    const info = await ctx.fs.stat(target, signal)
    if (info?.type !== 'file') { byPath.set(path, null); return null }
    let snap = snapshots.get(target.targetKey)
    if (snap) { if (snap.version !== info.version) throw new Error('revision_changed') }
    else {
      if (snapshots.size >= limits.maxEvidenceFiles || info.size !== undefined && info.size > limits.maxSourceBytes) throw new Error('program_limit')
      const content = await ctx.fs.readText(target, signal)
      totalBytes += Buffer.byteLength(content)
      if (totalBytes > limits.maxSourceBytes) throw new Error('program_limit')
      if ((await ctx.fs.stat(target, signal))?.version !== info.version) throw new Error('revision_changed')
      const normalized = normalizeCrlf(content)
      const segments = normalized.match(/[^\n]*\n|[^\n]+$/gu) ?? []
      const lines = segments.map(line => line.endsWith('\n') ? line.slice(0, -1) : line)
      snap = { target, version: info.version, content, normalized, segments, lines, lineSet: new Set(lines) }
      snapshots.set(target.targetKey, snap)
    }
    byPath.set(path, snap); return snap
  }
  const safeLoad = async path => {
    try { return await load(path) } catch (error) {
      if (['revision_changed','program_limit','program_aborted','search_work_limit'].includes(error.message)) throw error
      return null
    }
  }
  try {
    const prepared = []
    for (const step of item.plan.steps) {
      check()
      if (step.kind === 'cd') {
        if (!isAbsolute(step.path)) return reject('unresolved_program_path')
        const target = await ctx.fs.resolve(step.path, { signal })
        if ((await ctx.fs.stat(target, signal))?.type !== 'directory') return reject('invalid_program_cwd')
        prepared.push({ kind: 'exact', text: '', keys: new Set() }); continue
      }
      if (step.kind === 'literal') { prepared.push({ kind: 'exact', text: normalizeCrlf(step.text), keys: new Set() }); continue }
      if (step.kind === 'read') {
        let text = '', spans = []
        for (const path of step.files) {
          const snap = await load(path)
          if (!snap) return reject('unreadable_program_input')
          spans.push({ start: text.length, end: text.length + snap.normalized.length, key: snap.target.targetKey })
          text += snap.normalized
        }
        const output = renderReadPlan({ stages: step.stages }, text)
        if (output.length > MAX_OUTPUT) return reject('program_limit')
        prepared.push({ kind: 'exact', text: output, keys: visibleInputs(text, spans, step.stages) }); continue
      }
      if (step.kind !== 'search') return reject('invalid_program')
      prepared.push(await prepareSearch(step))
    }
    // Consider every feasible complete segmentation. A target is authorized
    // only if it contributes source records in ALL of them. Ambiguous markers
    // cannot transfer an observation from one file to a different file.
    const memo = new Map()
    const solve = async (index, pos) => {
      check()
      const key = `${index}:${pos}`
      if (memo.has(key)) return memo.get(key)
      if (++states > MAX_STATES) throw new Error('search_partition_limit')
      if (index === prepared.length) return pos === stdout.length ? { keys: new Set() } : null
      const step = prepared[index]
      let result = null
      const visit = async (end, keys) => {
        const suffix = await solve(index + 1, end)
        if (suffix === null) return
        const candidate = new Set([...keys, ...suffix.keys])
        if (result === null) result = { keys: candidate }
        else result.keys = new Set([...result.keys].filter(k => candidate.has(k)))
      }
      if (step.kind === 'exact') {
        if (stdout.startsWith(step.text, pos)) await visit(pos + step.text.length, step.keys)
      } else {
        const next = prepared[index + 1]
        const viable = end => index + 1 === prepared.length ? end === stdout.length
          : next.kind === 'exact' && next.text !== '' ? stdout.startsWith(next.text, end) : true
        const keys = new Set()
        if (step.after !== '&&' && viable(pos)) await visit(pos, keys)
        let cursor = pos, heading = null, records = 0
        // Once the intersection is empty further alternatives cannot add any
        // guaranteed target, so stopping here is safe and bounds ambiguity.
        while (cursor < stdout.length && (result === null || result.keys.size > 0)) {
          check()
          if (++records > MAX_RECORDS) throw new Error('search_record_limit')
          const newline = stdout.indexOf('\n', cursor)
          if (newline < 0) break
          const row = stdout.slice(cursor, newline)
          const parsed = await step.record(row, heading)
          if (!parsed) break
          heading = parsed.heading ?? heading
          for (const key of parsed.keys ?? []) keys.add(key)
          cursor = newline + 1
          if (viable(cursor) && (step.after !== '&&' || keys.size > 0)) await visit(cursor, keys)
        }
      }
      memo.set(key, result)
      return result
    }
    const solution = await solve(0, 0)
    if (solution === null) return reject('search_content_mismatch')
    if (!solution.keys.size) return reject('empty_or_ambiguous_search_evidence')
    // Group-wide freshness: a later verification read must not refresh or hide
    // a mutation of a previously verified file.
    for (const snap of snapshots.values()) {
      check()
      if ((await ctx.fs.stat(snap.target, signal))?.version !== snap.version) return reject('revision_changed')
    }
    return [...solution.keys].map(key => {
      const { target, version } = snapshots.get(key)
      return { target, version, snippets: [], expected: stdout, strictFinal: true }
    })
  } catch (error) { return reject(error.message === 'revision_changed' ? error.message : 'search_validation_failed') }

  async function prepareSearch(step) {
    const query = step.query
    let seed, scopes = []
    if (step.seed) {
      const snap = await load(step.seed.files[0])
      if (!snap) throw new Error('unreadable_search_input')
      const text = renderReadPlan({ stages: step.seed.stages }, snap.normalized)
      const segments = text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
      seed = { snap, lines: segments.map(line => line.endsWith('\n') ? line.slice(0, -1) : line) }
    } else {
      for (const spec of query.paths) {
        if (!isAbsolute(spec.absolute)) throw new Error('unresolved_program_path')
        if (spec.glob) {
          const matcher = compilePathGlob(spec, step.cwd)
          if (!matcher) throw new Error('unsupported_path_glob')
          const target = await ctx.fs.resolve(matcher.root, { signal })
          if ((await ctx.fs.stat(target, signal))?.type !== 'directory') continue
          scopes.push({ kind: 'glob', ...matcher, target }); continue
        }
        const target = await ctx.fs.resolve(spec.absolute, { signal })
        const info = await ctx.fs.stat(target, signal)
        if (info?.type === 'file') scopes.push({ kind: 'file', path: resolve(spec.absolute), input: spec.absolute, target })
        else if (info?.type === 'directory' && query.recursive) scopes.push({ kind: 'directory', path: resolve(spec.absolute), target })
      }
      if (!scopes.length) throw new Error('unknown_search_scope')
    }
    const single = !seed && scopes.length === 1 && scopes[0].kind === 'file' && query.paths.length === 1
    const filename = !seed && (query.filename === 'yes' || query.filename === 'auto' && !single)
    if (query.filename === 'no' && !seed && !single) throw new Error('ambiguous_search_scope')
    const scopedFile = async value => {
      if (!value || /[\0\r\n]/u.test(value) || value.startsWith('~')) return null
      const rawPath = isAbsolute(value) ? value : `${step.cwd}/${value}`
      const path = resolve(rawPath)
      const candidates = scopes.filter(scope => scope.kind === 'file' ? scope.path === path
        : scope.kind === 'directory' ? contained(scope.path, path) : scope.matches(path))
      if (!candidates.length) return null
      // Target keys are opaque: only the provider may test physical containment.
      // A backend lacking contains can still verify explicit file operands,
      // but must not authorize paths discovered under directory/glob scopes.
      let target
      try { target = await ctx.fs.resolve(rawPath, { signal }) } catch { return null }
      const allowed = candidates.some(scope => scope.kind === 'file'
        ? scope.target.targetKey === target.targetKey
        : typeof ctx.fs.contains === 'function' && ctx.fs.contains(scope.target, target) === true)
      if (!allowed) return null
      const snap = await safeLoad(rawPath)
      // resolve() is async: a symlink may be retargeted before the actual read.
      return snap?.target.targetKey === target.targetKey ? snap : null
    }
    const checkBody = async (body, snap, lines, numbered, column) => {
      let content = body, line, separator = ':'
      if (numbered) {
        const match = /^([1-9]\d*)([:-])([\s\S]*)$/u.exec(content)
        if (!match || !positive(Number(match[1])) || match[2] === '-' && !query.context) return null
        line = Number(match[1]); separator = match[2]; content = match[3]
      }
      if (column && separator === ':') {
        const match = /^([1-9]\d*):([\s\S]*)$/u.exec(content)
        if (!match || !positive(Number(match[1]))) return null
        content = match[2]
      }
      // An actual blank source line is valid (as in native windowed read), but
      // an empty result without a record is never an observation.
      let index = lineIndexes.get(lines)
      if (!index) { index = new Set(lines); lineIndexes.set(lines, index) }
      if (line !== undefined ? lines[line - 1] !== content : !index.has(content)) return null
      return snap.target.targetKey
    }
    const record = async (row, heading) => {
      check()
      if (query.json) return jsonRecord(row)
      if (query.context && row === '--') return { keys: [] }
      if (query.heading && row === '') return { keys: [] }
      if (seed) {
        const key = await checkBody(row, seed.snap, seed.lines, query.numbered, query.column)
        return key === null ? null : { keys: [key] }
      }
      if (query.heading) {
        const header = await scopedFile(row)
        // A row that can be both a header and source evidence is ambiguous.
        const bodyKey = heading ? await checkBody(row, heading, heading.lines, query.numbered, query.column) : null
        if (header && bodyKey !== null) return null
        if (header) return { keys: [], heading: header }
        return bodyKey === null ? null : { keys: [bodyKey] }
      }
      if (!filename) {
        const snap = await safeLoad(scopes[0].input)
        if (!snap) return null
        const key = await checkBody(row, snap, snap.lines, query.numbered, query.column)
        return key === null ? null : { keys: [key] }
      }
      const found = new Set()
      let splits = 0
      for (let i = 1; i < row.length; i++) {
        const sep = row[i]
        if (sep !== ':' && !(query.context && sep === '-')) continue
        if (++splits > MAX_PATH_SPLITS) return null
        const snap = await scopedFile(row.slice(0, i))
        if (!snap) continue
        const key = await checkBody(row.slice(i + 1), snap, snap.lines, query.numbered, query.column)
        if (key !== null) found.add(key)
      }
      return found.size === 1 ? { keys: found } : null
    }
    const jsonRecord = async row => {
      let event
      try { event = JSON.parse(row) } catch { return null }
      if (!event || typeof event !== 'object' || !event.data || typeof event.data !== 'object') return null
      if (event.type === 'summary') return { keys: [] }
      if (!['begin','end','match','context'].includes(event.type)) return null
      const path = jsonText(event.data.path)
      if (path === undefined) return null
      const snap = await scopedFile(path)
      if (!snap) return null
      if (event.type === 'begin' || event.type === 'end') return { keys: [] }
      const text = jsonText(event.data.lines)
      const line = event.data.line_number
      if (text === undefined || !text || !positive(line)) return null
      const normalized = normalizeCrlf(text)
      const count = (normalized.match(/[^\n]*\n|[^\n]+$/gu) ?? []).length
      if (!count || snap.segments.slice(line - 1, line - 1 + count).join('') !== normalized) return null
      return { keys: [snap.target.targetKey] }
    }
    return { kind: 'search', after: step.after, record }
  }
}

function jsonText(value) {
  // A base64-only field is not model-visible plaintext source evidence.
  return value && typeof value === 'object' && typeof value.text === 'string'
    && value.bytes === undefined ? value.text : undefined
}

/** Small shell glob language; no brace, globstar, expansion, command execution. */
function compilePathGlob(spec, cwd) {
  if (spec.value.includes('**') || /(?:^|\/)\.\.(?:\/|$)/u.test(spec.value)) return undefined
  // Normalize only redundant slash/dot components, retaining quote provenance.
  let offset = 0
  const parts = []
  for (const part of spec.value.split('/')) {
    if (part && part !== '.') parts.push({ value: part, quoted: (spec.quoted ?? []).slice(offset, offset + part.length) })
    offset += part.length + 1
  }
  let value = spec.value.startsWith('/') ? '/' : '', quoted = value ? [false] : []
  for (const part of parts) {
    if (value && !value.endsWith('/')) { value += '/'; quoted.push(false) }
    value += part.value; quoted.push(...part.quoted)
  }
  const prefix = isAbsolute(value) ? '' : resolve(cwd) + '/'
  const tokens = [...prefix].map(c => ({ kind: 'literal', c }))
  let first = -1
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (!quoted[i] && c === '*') { if (first < 0) first = i; tokens.push({ kind: 'star' }) }
    else if (!quoted[i] && c === '?') { if (first < 0) first = i; tokens.push({ kind: 'any' }) }
    else if (!quoted[i] && c === '[') {
      const end = value.indexOf(']', i + 1)
      if (end < 0) return undefined
      const inner = value.slice(i + 1, end)
      if (!/^[!^]?[A-Za-z0-9_-]+$/u.test(inner)) return undefined
      if (first < 0) first = i
      try { tokens.push({ kind: 'class', regex: new RegExp('^[' + (inner.startsWith('!') ? '^' + inner.slice(1) : inner) + ']$', 'u') }) } catch { return undefined }
      i = end
    } else tokens.push({ kind: 'literal', c })
  }
  if (first < 0 || tokens.length > 1024) return undefined
  const pre = value.slice(0, first), slash = pre.lastIndexOf('/')
  const root = resolve(cwd, slash < 0 ? '.' : pre.slice(0, slash + 1))
  return { root, matches(path) {
    // Dynamic programming, not an untrusted backtracking regex. The explicit
    // product cap bounds even adversarial patterns/paths in a tool result.
    if (path.length * tokens.length > 200_000) return false
    let previous = new Uint8Array(path.length + 1); previous[0] = 1
    for (const token of tokens) {
      const next = new Uint8Array(path.length + 1)
      if (token.kind === 'star') next[0] = previous[0]
      for (let j = 1; j <= path.length; j++) {
        const c = path[j - 1]
        if (token.kind === 'star') next[j] = previous[j] || c !== '/' && next[j - 1] ? 1 : 0
        else if (previous[j - 1] && (token.kind === 'literal' ? c === token.c
          : c !== '/' && (token.kind === 'any' || token.regex.test(c)))) next[j] = 1
      }
      previous = next
    }
    return previous[path.length] === 1
  } }
}
