import assert from 'node:assert/strict'
import test from 'node:test'
import { codegraphProjectPath, parseCodegraphEvidence } from '../lib/sources/codegraph-output.js'

const EXPLORE = [
  '**Exploration: alpha and beta**',
  '',
  'Found 2 symbols across 2 files.',
  '',
  '**Blast radius — what depends on these (update/verify before editing)**',
  '',
  '- `alpha` (src/alpha.js:1) — 1 caller in `src/beta.js`',
  '- `gamma` (src/gamma.js:4) — mentioned only, no source shown',
  '',
  '**Source Code**',
  '',
  '> The code below is the verbatim, current on-disk source.',
  '',
  '**`src/alpha.js`** — alpha(function)',
  '',
  '```javascript',
  '1\texport function alpha() {',
  '2\t  return 1',
  '3\t}',
  '```',
  '',
  '**`src/beta.js`** — beta(function)',
  '',
  '```javascript',
  '1\texport function beta() {}',
  '```',
].join('\n')

test('explore evidence keeps source snippets and drops mention-only files', () => {
  const evidence = parseCodegraphEvidence(EXPLORE)
  assert.deepEqual(evidence.map(item => item.path), ['src/alpha.js', 'src/beta.js'])
  assert.deepEqual(evidence[0].snippets, [{
    text: 'export function alpha() {\n  return 1\n}',
    startLine: 1,
    endLine: 3,
  }])
  assert.deepEqual(evidence[1].snippets, [{ text: 'export function beta() {}', startLine: 1, endLine: 1 }])
})

test('node symbol mode uses the Location heading', () => {
  const text = [
    '**main** (function)',
    '',
    '**Location:** cli/main.mjs:336',
    '**Signature:** `(args)`',
    '',
    '```javascript',
    '336\texport async function main(args) {',
    '337\t  return run(args)',
    '338\t}',
    '```',
  ].join('\n')
  const evidence = parseCodegraphEvidence(text)
  assert.deepEqual(evidence, [{
    path: 'cli/main.mjs',
    snippets: [{ text: 'export async function main(args) {\n  return run(args)\n}', startLine: 336, endLine: 338 }],
  }])
})

test('node file mode keeps a numbered body', () => {
  const text = [
    '**cli/main.mjs** — 444 lines, 23 symbols · used by 6 files: a.mjs, b.mjs',
    '',
    '1\timport fs from "node:fs";',
    '2\timport path from "node:path";',
  ].join('\n')
  assert.deepEqual(parseCodegraphEvidence(text), [{
    path: 'cli/main.mjs',
    snippets: [{ text: 'import fs from "node:fs";\nimport path from "node:path";', startLine: 1, endLine: 2 }],
  }])
})

test('context markdown uses the heading line for an unnumbered block', () => {
  const text = [
    '### Code',
    '',
    '#### removeManagedHooks (cli/commands/maintenance.mjs:106)',
    '',
    '```javascript',
    'function removeManagedHooks(paths) {',
    '  return paths',
    '}',
    '```',
  ].join('\n')
  const evidence = parseCodegraphEvidence(text)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].path, 'cli/commands/maintenance.mjs')
  assert.equal(evidence[0].snippets[0].startLine, 106)
  assert.equal(evidence[0].snippets[0].endLine, 108)
})

test('context JSON codeBlocks become evidence', () => {
  const text = JSON.stringify({
    codeBlocks: [
      { filePath: 'src/a.js', startLine: 1, endLine: 2, content: 'const a = 1\nconst b = 2' },
      { filePath: 'src/b.js', startLine: 5, endLine: 5, content: 'const c = 3' },
    ],
  })
  assert.deepEqual(parseCodegraphEvidence(text), [
    { path: 'src/a.js', snippets: [{ text: 'const a = 1\nconst b = 2', startLine: 1, endLine: 2 }] },
    { path: 'src/b.js', snippets: [{ text: 'const c = 3', startLine: 5, endLine: 5 }] },
  ])
})

test('context JSON without code blocks authorizes nothing', () => {
  assert.deepEqual(parseCodegraphEvidence(JSON.stringify({ codeBlocks: [] })), [])
  assert.deepEqual(parseCodegraphEvidence(JSON.stringify({
    codeBlocks: [{ filePath: 'src/a.js', content: '' }],
  })), [])
})

test('a truncated fence contributes no evidence', () => {
  const text = [
    '**`src/alpha.js`** — alpha(function)',
    '',
    '```javascript',
    '1\texport function alpha() {',
  ].join('\n')
  assert.deepEqual(parseCodegraphEvidence(text), [])
  assert.deepEqual(parseCodegraphEvidence(''), [])
})

test('CodeGraph CLI project paths come from -p/--path', () => {
  assert.equal(codegraphProjectPath(['explore', 'query', '-p', '/repo']), '/repo')
  assert.equal(codegraphProjectPath(['explore', '--path=/repo']), '/repo')
  assert.equal(codegraphProjectPath(['explore', 'query', '-p', '-x']), undefined)
  assert.equal(codegraphProjectPath(['explore', 'query']), undefined)
  assert.equal(codegraphProjectPath(undefined), undefined)
})
