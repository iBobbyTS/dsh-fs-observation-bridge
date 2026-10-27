import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { clearPending, flush, stash } from '../lib/observation/emit.js'

const signal = new AbortController().signal
const target = { targetKey: '/repo/a.js', displayPath: '/repo/a.js' }
const exec = { callId: 'call-1', agent: { session: {} }, signal }

/**
 * Build a context stub that records `fs/observed`.
 * @returns {{ ctx: object, emissions: object[] }} recorder.
 */
function recorder() {
  const emissions = []
  return {
    emissions,
    ctx: {
      emit(event, observedTarget, observation, actor) {
        emissions.push({ event, target: observedTarget, observation, actor })
      },
    },
  }
}

beforeEach(() => {
  clearPending()
})

test('final content that still shows the snippet authorizes the file', () => {
  const { ctx, emissions } = recorder()
  stash(exec, [{ target, version: 'v1', snippets: [{ text: 'const a = 1' }] }])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'prefix const a = 1 suffix' }] })
  assert.equal(emissions.length, 1)
  assert.deepEqual(emissions[0].observation, { kind: 'present', version: 'v1' })
  assert.equal(emissions[0].actor, exec)
})

test('JSON codeBlocks content authorizes the file', () => {
  const { ctx, emissions } = recorder()
  const snippet = 'const a = 1\nconst b = 2'
  stash(exec, [{ target, version: 'v1', snippets: [{ text: snippet }] }])
  const json = JSON.stringify({ codeBlocks: [{ filePath: 'a.js', content: snippet }] })
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: json }] })
  assert.equal(emissions.length, 1)
})

test('a spilled or rewritten result authorizes nothing', () => {
  const { ctx, emissions } = recorder()
  stash(exec, [{ target, version: 'v1', snippets: [{ text: 'const a = 1' }] }])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'preview only' }] })
  assert.equal(emissions.length, 0)
})

test('an error result authorizes nothing', () => {
  const { ctx, emissions } = recorder()
  stash(exec, [{ target, version: 'v1', snippets: [{ text: 'const a = 1' }] }])
  flush(ctx, exec, { isError: true, content: [{ type: 'text', text: 'const a = 1' }] })
  assert.equal(emissions.length, 0)
})

test('one file is emitted once per call', () => {
  const { ctx, emissions } = recorder()
  stash(exec, [
    { target, version: 'v1', snippets: [{ text: 'const a = 1' }] },
    { target, version: 'v1', snippets: [{ text: 'const a = 1' }] },
  ])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'const a = 1' }] })
  assert.equal(emissions.length, 1)
})

test('flushing without stashed evidence is a no-op', () => {
  const { ctx, emissions } = recorder()
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'const a = 1' }] })
  assert.equal(emissions.length, 0)
})

test('exact expected output must remain complete in the final result', () => {
  const { ctx, emissions } = recorder()
  stash(exec, [{ target, version: 'v1', expected: 'a\nb\n', snippets: [{ text: 'a\nb\n' }] }])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'prefix\na\nb\nsuffix' }] })
  assert.equal(emissions.length, 1)
})

test('a truncated exact expected output authorizes nothing', () => {
  const { ctx, emissions } = recorder()
  stash(exec, [{ target, version: 'v1', expected: 'a\nb\nc\n', snippets: [] }])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'a\nb\n' }] })
  assert.equal(emissions.length, 0)
})

test('an exact empty cat requires the explicit no-output result', () => {
  for (const text of ['(no output)', '']) {
    const { ctx, emissions } = recorder()
    stash(exec, [{ target, version: 'v1', expected: '', snippets: [], permitEmpty: true }])
    flush(ctx, exec, { isError: false, content: [{ type: 'text', text }] })
    assert.equal(emissions.length, 1, JSON.stringify(text))
  }
  const { ctx, emissions } = recorder()
  stash(exec, [{ target, version: 'v1', expected: '', snippets: [], permitEmpty: false }])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: '(no output)' }] })
  assert.equal(emissions.length, 0)
})

test('separate calls keep separate pending evidence and sessions', () => {
  const { ctx, emissions } = recorder()
  const second = { callId: 'call-2', agent: { session: {} }, signal }
  const anonymous = { callId: 'call-3', signal }
  stash(exec, [{ target, version: 'v1', expected: 'a\n', snippets: [{ text: 'a\n' }] }])
  stash(second, [{ target, version: 'v2', expected: 'a\n', snippets: [{ text: 'a\n' }] }])
  stash(anonymous, [{ target, version: 'v3', expected: 'a\n', snippets: [{ text: 'a\n' }] }])
  flush(ctx, exec, { isError: false, content: [{ type: 'text', text: 'a\n' }] })
  flush(ctx, second, { isError: false, content: [{ type: 'text', text: 'a\n' }] })
  flush(ctx, anonymous, { isError: false, content: [{ type: 'text', text: 'a\n' }] })
  assert.equal(emissions.length, 2)
  assert.deepEqual(emissions.map(item => item.observation.version), ['v1', 'v2'])
})
