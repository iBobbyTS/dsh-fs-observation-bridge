import assert from 'node:assert/strict'
import test from 'node:test'
import { lexShell } from '../lib/transports/shell-command.js'
import { parseShellReadCommand } from '../lib/transports/shell-read.js'

/**
 * @param {string} command - shell command.
 * @returns {object | undefined} the parsed plan, if accepted.
 */
function plan(command) {
  const parsed = parseShellReadCommand(command)
  return parsed.ok ? parsed.plan : undefined
}

test('lexer preserves quoted glob characters as literal path text', () => {
  const quoted = lexShell("cat '[id]/+page.svelte'")
  assert.equal(quoted.ok, true)
  assert.equal(quoted.stages[0][1].value, '[id]/+page.svelte')
  assert.equal(quoted.stages[0][1].hasUnquotedGlob, false)

  const bare = lexShell('cat [id]/+page.svelte')
  assert.equal(bare.ok, true)
  assert.equal(bare.stages[0][1].hasUnquotedGlob, true)
})

test('P0 cat forms produce one exact-file plan', () => {
  assert.deepEqual(plan('cat app.ts'), {
    dialect: 'bash',
    file: 'app.ts',
    stages: [{ kind: 'cat', number: 'none' }],
    permitEmpty: true,
  })
  assert.equal(plan("cat '[id]/+page.svelte'").file, '[id]/+page.svelte')
  assert.equal(plan('cat -- -draft.ts').file, '-draft.ts')
  assert.equal(plan('cat "space in name.ts"').file, 'space in name.ts')
})

test('P0 head, tail, sed, and line-number forms parse', () => {
  assert.deepEqual(plan('head app.ts').stages, [{ kind: 'head', count: 10 }])
  assert.deepEqual(plan('head -n 80 app.ts').stages, [{ kind: 'head', count: 80 }])
  assert.deepEqual(plan('head -80 app.ts').stages, [{ kind: 'head', count: 80 }])
  assert.deepEqual(plan('tail app.ts').stages, [{ kind: 'tail', count: 10 }])
  assert.deepEqual(plan('tail -n 50 app.ts').stages, [{ kind: 'tail', count: 50 }])
  assert.deepEqual(plan('tail -n +522 README.md').stages, [{ kind: 'tail', from: 522 }])
  assert.deepEqual(plan("sed -n '42p' app.ts").stages, [{ kind: 'sed', start: 42, end: 42 }])
  assert.deepEqual(plan("sed -n '40,120p' app.ts").stages, [{ kind: 'sed', start: 40, end: 120 }])
  assert.deepEqual(plan("sed -n '40,$p' app.ts").stages, [{ kind: 'sed', start: 40 }])
  assert.deepEqual(plan('cat -n app.ts').stages, [{ kind: 'cat', number: 'all' }])
  assert.deepEqual(plan('cat -b app.ts').stages, [{ kind: 'cat', number: 'nonblank' }])
  assert.deepEqual(plan('nl -ba app.ts').stages, [{ kind: 'nl' }])
})

test('P1 pipelines preserve stage order and allow two selectors', () => {
  assert.deepEqual(plan('cat app.ts | head -n 80').stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'head', count: 80 },
  ])
  assert.deepEqual(plan('cat app.ts | tail -n 80').stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'tail', count: 80 },
  ])
  assert.deepEqual(plan("cat app.ts | sed -n '20,80p'").stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'sed', start: 20, end: 80 },
  ])
  assert.deepEqual(plan('cat app.ts | nl -ba').stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'nl' },
  ])
  assert.deepEqual(plan("nl -ba app.ts | sed -n '20,80p'").stages, [
    { kind: 'nl' },
    { kind: 'sed', start: 20, end: 80 },
  ])
  assert.deepEqual(plan("sed -n '20,80p' app.ts | nl -ba").stages, [
    { kind: 'sed', start: 20, end: 80 },
    { kind: 'nl' },
  ])
  assert.deepEqual(plan('cat app.ts | head -n 5 | tail -n 2').stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'head', count: 5 },
    { kind: 'tail', count: 2 },
  ])
  assert.deepEqual(plan("cat app.ts | sed -n '2,4p' | nl -ba").stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'sed', start: 2, end: 4 },
    { kind: 'nl' },
  ])
  assert.deepEqual(plan("cat app.ts | nl -ba | sed -n '2,4p'").stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'nl' },
    { kind: 'sed', start: 2, end: 4 },
  ])
})

test('unsupported shell shapes are rejected', () => {
  for (const command of [
    'cat f1 f2',
    'cat -',
    'cat -A f',
    'cat -s f',
    'cat $FILE',
    'cat $(pwd)',
    'cat `pwd`',
    'cat f | tee out',
    'cat f > out',
    'cat f; echo x',
    'cat f && echo x',
    'cd sub && cat f',
    'npx cat f',
    'ssh host cat f',
    'docker exec c cat f',
    "sed -i 's/a/b/' f",
    "sed 's/a/b/' f",
    "sed -n '1p;2p' f",
    'tail -f f',
    'head -c 10 f',
    'rg --files',
    'git show HEAD:f',
    'python -c "print(1)"',
    'cat f | head -n 80 | tail -n 5 | nl -ba',
    'cat f | nl -ba | nl -ba',
    'cat f | head | sed | tail',
    'cat -n f | head',
    'head f | sed -n 1,2p',
  ]) {
    assert.equal(parseShellReadCommand(command).ok, false, command)
  }
})
