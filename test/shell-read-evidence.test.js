import assert from 'node:assert/strict'
import test from 'node:test'
import { validateEvidence } from '../lib/observation/evidence.js'
import { renderReadPlan } from '../lib/sources/shell-read-render.js'

const signal = new AbortController().signal

/**
 * @param {string} text - current file text.
 * @param {{ versions?: string[], type?: string, size?: number }} [options] - stat sequence.
 * @returns {object} context stub.
 */
function ctxFor(text, options = {}) {
  const versions = [...(options.versions ?? ['v1', 'v1'])]
  return {
    fs: {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat(target) {
        if (target.targetKey !== '/repo/a.ts') return undefined
        return {
          type: options.type ?? 'file',
          size: options.size ?? text.length,
          version: versions.length > 0 ? versions.shift() : 'v1',
        }
      },
      async readText() {
        return text
      },
    },
  }
}

/**
 * @param {object} plan - read plan.
 * @param {string} content - current file text.
 * @param {string} expectedStdout - stdout the model saw.
 * @param {object} [extra] - evidence overrides.
 * @returns {object} evidence item.
 */
function evidence(plan, content, expectedStdout, extra = {}) {
  return {
    path: '/repo/a.ts',
    stable: true,
    expectedStdout,
    permitEmpty: plan.permitEmpty,
    verify(current) {
      return renderReadPlan(plan, current)
    },
    ...extra,
  }
}

const CAT = { dialect: 'bash', file: '/repo/a.ts', stages: [{ kind: 'cat', number: 'none' }], permitEmpty: true }
const HEAD = { dialect: 'bash', file: '/repo/a.ts', stages: [{ kind: 'head', count: 2 }], permitEmpty: false }

test('exact shell output validates against unchanged content', async () => {
  const validated = await validateEvidence(ctxFor('a\nb\n'), {}, [evidence(CAT, 'a\nb\n', 'a\nb\n')], signal)
  assert.equal(validated.length, 1)
  assert.equal(validated[0].expected, 'a\nb\n')
  assert.deepEqual(validated[0].snippets, [{ text: 'a\nb\n' }])
})

test('one-character and line-ending-equivalent differences use the exact rule', async () => {
  assert.deepEqual(
    await validateEvidence(ctxFor('a\nb\n'), {}, [evidence(CAT, 'a\nb\n', 'a\nB\n')], signal),
    [],
  )
  const validated = await validateEvidence(ctxFor('a\r\nb\r\n'), {}, [evidence(CAT, 'a\r\nb\r\n', 'a\r\nb\r\n')], signal)
  assert.equal(validated.length, 1)
  assert.equal(validated[0].expected, 'a\nb\n')
  const loneCr = await validateEvidence(ctxFor('a\rb\r\n'), {}, [evidence(CAT, 'a\rb\r\n', 'a\rb\r\n')], signal)
  assert.equal(loneCr.length, 1)
  assert.equal(loneCr[0].expected, 'a\rb\n')
})

test('partial reads validate only when replay matches the visible window', async () => {
  assert.equal(
    (await validateEvidence(ctxFor('a\nb\nc\n'), {}, [evidence(HEAD, 'a\nb\nc\n', 'a\nb\n')], signal)).length,
    1,
  )
  assert.deepEqual(
    await validateEvidence(ctxFor('a\nb\nc\n'), {}, [evidence(HEAD, 'a\nb\nc\n', 'a\nc\n')], signal),
    [],
  )
})

test('a file changed between the two stats is rejected', async () => {
  const ctx = ctxFor('a\nb\n', { versions: ['v1', 'v2'] })
  assert.deepEqual(await validateEvidence(ctx, {}, [evidence(CAT, 'a\nb\n', 'a\nb\n')], signal), [])
})

test('only full cat may observe an empty file', async () => {
  assert.equal(
    (await validateEvidence(ctxFor('', { versions: ['v1', 'v1'] }), {}, [evidence(CAT, '', '')], signal)).length,
    1,
  )
  assert.deepEqual(
    await validateEvidence(ctxFor('', { versions: ['v1', 'v1'] }), {}, [evidence(HEAD, '', '')], signal),
    [],
  )
})

test('oversized, non-file, and unreadable shell targets are rejected', async () => {
  assert.deepEqual(
    await validateEvidence(ctxFor('a\n', { size: 9 * 1024 * 1024 }), {}, [evidence(CAT, 'a\n', 'a\n')], signal),
    [],
  )
  assert.deepEqual(
    await validateEvidence(ctxFor('a\n', { type: 'directory' }), {}, [evidence(CAT, 'a\n', 'a\n')], signal),
    [],
  )
  assert.deepEqual(
    await validateEvidence(ctxFor('a\n'), { cwd: '/repo' }, [{ ...evidence(CAT, 'a\n', 'a\n'), path: '/repo/missing.ts' }], signal),
    [],
  )
})

test('an unreadable binary target is rejected without throwing', async () => {
  const ctx = {
    fs: {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat() {
        return { type: 'file', size: 4, version: 'v1' }
      },
      async readText() {
        throw new Error('binary')
      },
    },
  }
  assert.deepEqual(
    await validateEvidence(ctx, {}, [evidence(CAT, 'a\n', 'a\n')], signal),
    [],
  )
})
