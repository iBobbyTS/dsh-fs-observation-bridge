import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { sourceAccepts } from '../lib/sources/registry.js'
import { shellReadSource } from '../lib/sources/shell-read.js'
import { cliTransport } from '../lib/transports/cli.js'
import { shellReadTransport } from '../lib/transports/shell-read.js'

const signal = new AbortController().signal

/**
 * @param {string} cwd - session directory.
 * @returns {object} minimal context stub.
 */
function ctxWithCwd(cwd) {
  return {
    get(name) {
      return name === 'workingDirectory' ? { async ensure() { return cwd } } : undefined
    },
  }
}

/**
 * @param {object} [overrides] - foreground result overrides.
 * @returns {object} a tool result carrying a normal foreground Bash value.
 */
function foreground(overrides = {}) {
  return {
    isError: false,
    value: {
      kind: 'foreground',
      cwd: '/repo',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: { text: 'a\n', truncated: false },
      stderr: { text: '', truncated: false },
      ...overrides,
    },
  }
}

test('shell-read transport normalizes cat with the effective workdir', async () => {
  const transport = shellReadTransport()
  const exec = {
    name: 'bash',
    arguments: { command: 'cat src/a.ts', workdir: 'sub' },
    agent: { session: {} },
    signal,
  }
  const normalized = await transport.normalize(ctxWithCwd('/repo'), exec, foreground({ cwd: '/repo/sub' }))
  assert.equal(transport.match(exec), true)
  assert.equal(normalized.transport, 'shell-read')
  assert.equal(normalized.plan.file, resolve(join('/repo', 'sub'), 'src/a.ts'))
  assert.equal(normalized.plan.effectiveCwd, join('/repo', 'sub'))
  assert.deepEqual(normalized.plan.stages, [{ kind: 'cat', number: 'none' }])
  assert.equal(normalized.stdout, 'a\n')
  assert.equal(normalized.exitCode, 0)
})

test('shell-read transport preserves absolute paths and pipeline plans', async () => {
  const transport = shellReadTransport()
  const exec = {
    name: 'bash',
    arguments: { command: "nl -ba /repo/a.ts | sed -n '2,3p'" },
    agent: { session: {} },
    signal,
  }
  const normalized = await transport.normalize(ctxWithCwd('/repo'), exec, foreground())
  assert.deepEqual(normalized.plan.stages, [
    { kind: 'nl' },
    { kind: 'sed', start: 2, end: 3 },
  ])
  assert.equal(normalized.plan.file, '/repo/a.ts')

  const three = { ...exec, arguments: { command: "cat /repo/a.ts | head -n 5 | tail -n 2" } }
  const triple = await transport.normalize(ctxWithCwd('/repo'), three, foreground())
  assert.deepEqual(triple.plan.stages, [
    { kind: 'cat', number: 'none' },
    { kind: 'head', count: 5 },
    { kind: 'tail', count: 2 },
  ])
})

test('shell-read rejects non-foreground, failed, truncated, and dirty executions', async () => {
  const transport = shellReadTransport()
  const exec = {
    name: 'bash',
    arguments: { command: 'cat a.ts' },
    agent: { session: {} },
    signal,
  }
  const cases = [
    { value: { kind: 'promoted', stdout: { text: 'a\n', truncated: false }, stderr: { text: '', truncated: false } } },
    foreground({ exitCode: 1 }),
    foreground({ signal: 'SIGTERM' }),
    foreground({ timedOut: true }),
    foreground({ aborted: true }),
    foreground({ stopped: 'killed' }),
    foreground({ stdout: { text: 'a\n', truncated: true } }),
    foreground({ stderr: { text: 'warning', truncated: false } }),
    foreground({ stderr: { text: '', truncated: true } }),
    foreground({ stdout: { text: 'a\n', truncated: false, spillPath: '/tmp/out' } }),
    foreground({ sandbox: { denied: true } }),
    foreground({ sandbox: { runnerFailed: true } }),
    foreground({ cwd: '/elsewhere' }),
  ]
  for (const result of cases) {
    assert.equal(await transport.normalize(ctxWithCwd('/repo'), exec, result), null)
  }
  assert.equal(await transport.normalize(ctxWithCwd('/repo'), { ...exec, arguments: { command: 'cat a.ts', run_in_background: true } }, foreground()), null)
})

test('shell-read does not claim unsupported syntax or persistent-shaped results', async () => {
  const transport = shellReadTransport()
  assert.equal(transport.match({ name: 'bash', arguments: { command: 'cat a b' } }), true)
  assert.equal(transport.match({ name: 'bash', arguments: { command: 'cat a | tee b' } }), false)
  assert.equal(transport.match({ name: 'bash', arguments: { command: 'git show HEAD:a' } }), false)
  assert.equal(transport.match({ name: 'bash', arguments: { command: 'cat a' } }), true)

  const exec = { name: 'bash', arguments: { command: 'cat a' }, agent: { session: {} }, signal }
  const persistent = { isError: false, value: 'a\n' }
  assert.equal(await transport.normalize(ctxWithCwd('/repo'), exec, persistent), null)
})

test('CLI and shell-read transports are mutually exclusive', () => {
  const cli = cliTransport()
  const shell = shellReadTransport()
  for (const command of ['cat a', 'head -n 2 a', 'tail a', "sed -n '1,2p' a", 'nl -ba a']) {
    const exec = { name: 'bash', arguments: { command } }
    assert.equal(shell.match(exec), true, command)
    assert.equal(cli.match(exec), false, command)
  }
  assert.equal(cli.match({ name: 'bash', arguments: { command: 'codegraph explore x' } }), true)
  assert.equal(shell.match({ name: 'bash', arguments: { command: 'codegraph explore x' } }), false)
  assert.equal(cli.match({ name: 'bash', arguments: { command: 'cat a | head' } }), false)
})

test('shell-read source accepts only the bash shell-read dialect', () => {
  assert.equal(sourceAccepts(shellReadSource, { transport: 'shell-read', dialect: 'bash' }), true)
  assert.equal(sourceAccepts(shellReadSource, { transport: 'shell-read', dialect: 'pwsh' }), false)
  assert.equal(sourceAccepts(shellReadSource, { transport: 'cli', program: 'cat', operation: 'a' }), false)
})
