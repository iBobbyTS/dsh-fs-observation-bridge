import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { validateEvidence } from '../lib/observation/evidence.js'

/**
 * Build a Context stub whose `fs` serves an in-memory file table.
 * @param {Record<string, { text: string, type?: string, size?: number }>} files - files by path.
 * @returns {object} the stub context.
 */
function ctxWithFiles(files) {
  return {
    fs: {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat(target) {
        const file = files[target.targetKey]
        if (file === undefined) return undefined
        return { type: file.type ?? 'file', size: file.size ?? file.text.length, version: 'v1' }
      },
      async readText(target) {
        return files[target.targetKey].text
      },
    },
  }
}

const signal = new AbortController().signal

test('a snippet matching the current file is validated', async () => {
  const ctx = ctxWithFiles({ '/repo/a.js': { text: 'const a = 1\nconst b = 2\n' } })
  const evidence = [{
    path: '/repo/a.js',
    snippets: [{ text: 'const a = 1', startLine: 1, endLine: 1 }],
  }]
  const validated = await validateEvidence(ctx, {}, evidence, signal)
  assert.equal(validated.length, 1)
  assert.equal(validated[0].version, 'v1')
  assert.equal(validated[0].snippets.length, 1)
})

test('a snippet missing from the current file is rejected', async () => {
  const ctx = ctxWithFiles({ '/repo/a.js': { text: 'const a = 999\n' } })
  const evidence = [{
    path: '/repo/a.js',
    snippets: [{ text: 'const a = 1', startLine: 1, endLine: 1 }],
  }]
  assert.deepEqual(await validateEvidence(ctx, {}, evidence, signal), [])
})

test('a moved snippet still matches by exact text', async () => {
  const ctx = ctxWithFiles({ '/repo/a.js': { text: '// header\nconst a = 1\n' } })
  const evidence = [{
    path: '/repo/a.js',
    snippets: [{ text: 'const a = 1', startLine: 1, endLine: 1 }],
  }]
  const validated = await validateEvidence(ctx, {}, evidence, signal)
  assert.equal(validated.length, 1)
})

test('relative evidence resolves against the invocation cwd or root', async () => {
  const ctx = ctxWithFiles({
    [join('/repo', 'a.js')]: { text: 'x' },
    [join('/root', 'b.js')]: { text: 'y' },
  })
  const evidence = [
    { path: 'a.js', snippets: [{ text: 'x' }] },
    { path: 'b.js', root: '/root', snippets: [{ text: 'y' }] },
  ]
  const validated = await validateEvidence(ctx, { cwd: '/repo' }, evidence, signal)
  assert.deepEqual(validated.map(item => item.target.targetKey), [join('/repo', 'a.js'), join('/root', 'b.js')])
})

test('oversized, non-file, and unreadable targets are skipped', async () => {
  const ctx = ctxWithFiles({
    '/repo/big.js': { text: 'x', size: 9 * 1024 * 1024 },
    '/repo/dir': { text: 'x', type: 'directory' },
    '/repo/a.js': { text: 'ok' },
  })
  const evidence = [
    { path: '/repo/big.js', snippets: [{ text: 'x' }] },
    { path: '/repo/dir', snippets: [{ text: 'x' }] },
    { path: '/repo/missing.js', snippets: [{ text: 'x' }] },
    { path: '/repo/a.js', snippets: [{ text: 'ok' }] },
  ]
  const validated = await validateEvidence(ctx, {}, evidence, signal)
  assert.deepEqual(validated.map(item => item.target.targetKey), ['/repo/a.js'])
})

test('config limits bound the validated size and file count', async () => {
  const ctx = ctxWithFiles({
    '/repo/a.js': { text: 'const a = 1' },
    '/repo/b.js': { text: 'const b = 2' },
  })
  const evidence = [
    { path: '/repo/a.js', snippets: [{ text: 'const a = 1' }] },
    { path: '/repo/b.js', snippets: [{ text: 'const b = 2' }] },
  ]
  assert.deepEqual(
    (await validateEvidence(ctx, {}, evidence, signal, { maxSourceBytes: 100, maxEvidenceFiles: 1 }))
      .map(item => item.target.targetKey),
    ['/repo/a.js'],
  )
  assert.deepEqual(
    (await validateEvidence(ctx, {}, evidence, signal, { maxSourceBytes: 5 })).map(item => item.target.targetKey),
    [],
  )
})
