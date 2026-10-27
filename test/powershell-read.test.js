import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { validateEvidence } from '../lib/observation/evidence.js'
import { sourceAccepts } from '../lib/sources/registry.js'
import { powershellReadSource } from '../lib/sources/powershell-read.js'
import { shellReadSource } from '../lib/sources/shell-read.js'
import { cliTransport } from '../lib/transports/cli.js'
import { parsePowerShellReadCommand } from '../lib/transports/powershell-parser.js'
import { shellReadTransport } from '../lib/transports/shell-read.js'

const signal = new AbortController().signal
const root = resolve('repo')

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
 * @returns {object} a tool result carrying a normal foreground pwsh value.
 */
function foreground(overrides = {}) {
  return {
    isError: false,
    value: {
      kind: 'foreground',
      cwd: root,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: { text: 'a\r\n', truncated: false },
      stderr: { text: '', truncated: false },
      ...overrides,
    },
  }
}

/**
 * @param {string} command - PowerShell command.
 * @param {object} [argumentsOverride] - extra tool arguments.
 * @returns {object} the tool execution view.
 */
function execFor(command, argumentsOverride = {}) {
  return {
    name: 'pwsh',
    arguments: { command, ...argumentsOverride },
    agent: { session: {} },
    signal,
  }
}

test('shell-read claims PowerShell read commands and normalizes them', async () => {
  const transport = shellReadTransport()
  const exec = execFor('Get-Content src/a.ts')
  assert.equal(transport.match(exec), true)

  const normalized = await transport.normalize(ctxWithCwd('/elsewhere'), exec, foreground())
  assert.equal(normalized.transport, 'shell-read')
  assert.equal(normalized.dialect, 'powershell')
  assert.equal(normalized.plan.file, resolve(root, 'src/a.ts'))
  assert.equal(normalized.plan.effectiveCwd, root)
  assert.equal(normalized.plan.mode, 'lines')
  assert.deepEqual(normalized.plan.selectors, [])
  assert.equal(normalized.cwd, root)
  assert.equal(normalized.stdout, 'a\r\n')
  assert.equal(normalized.exitCode, 0)
})

test('relative literal paths resolve against the result cwd, not model arguments', async () => {
  const transport = shellReadTransport()
  const exec = execFor(String.raw`Get-Content -LiteralPath '.\sub\[id]\page.ts'`)
  const normalized = await transport.normalize(
    ctxWithCwd('/model-workdir'),
    exec,
    foreground({ cwd: root, stdout: { text: 'page\r\n', truncated: false } }),
  )
  assert.equal(normalized.plan.file, resolve(root, String.raw`.\sub\[id]\page.ts`))
})

test('shell-read rejects unsafe or incomplete pwsh executions', async () => {
  const transport = shellReadTransport()
  const exec = execFor('Get-Content a.ts')
  const cases = [
    { value: { kind: 'promoted', cwd: root, output: 'a\n' } },
    { value: { kind: 'background', cwd: root, jobId: 'job-1' } },
    foreground({ exitCode: 1 }),
    foreground({ signal: 'SIGTERM' }),
    foreground({ timedOut: true }),
    foreground({ aborted: true }),
    foreground({ stopped: 'killed' }),
    foreground({ stdout: { text: 'a\r\n', truncated: true } }),
    foreground({ stderr: { text: 'warning', truncated: false } }),
    foreground({ stderr: { text: '', truncated: true } }),
    foreground({ stdout: { text: 'a\r\n', truncated: false, spillPath: 'C:\\spill' } }),
    foreground({ stderr: { text: '', truncated: false, spillPath: 'C:\\spill' } }),
    foreground({ sandbox: { denied: true, mode: 'workspace-write' } }),
    foreground({ sandbox: { runnerFailed: true, mode: 'workspace-write' } }),
    foreground({ cwd: '' }),
    foreground({ cwd: 'relative' }),
    { isError: false, value: 'a\r\n' },
  ]
  for (const result of cases) {
    assert.equal(await transport.normalize(ctxWithCwd(root), exec, result), null)
  }
  const background = execFor('Get-Content a.ts', { run_in_background: true })
  assert.equal(await transport.normalize(ctxWithCwd(root), background, foreground()), null)
  const unsupported = execFor('Get-ChildItem src')
  assert.equal(await transport.normalize(ctxWithCwd(root), unsupported, foreground()), null)
})

test('PowerShell reads are not also claimed by the CLI transport', async () => {
  const shell = shellReadTransport()
  const cli = cliTransport()
  for (const command of [
    String.raw`Get-Content a.ts`,
    String.raw`gc a.ts`,
    String.raw`cat a.ts`,
    String.raw`type a.ts`,
    String.raw`Get-Content a.ts | Select-Object -First 1`,
  ]) {
    const exec = execFor(command)
    assert.equal(shell.match(exec), true, command)
    assert.equal(cli.match(exec), false, command)
  }
  // A non-read PowerShell command still belongs to the CLI transport only.
  const codegraph = execFor('codegraph explore auth')
  assert.equal(shell.match(codegraph), false)
  assert.equal(cli.match(codegraph), true)
})

test('the powershell source accepts exactly the powershell dialect', () => {
  assert.equal(sourceAccepts(powershellReadSource, { transport: 'shell-read', dialect: 'powershell' }), true)
  assert.equal(sourceAccepts(powershellReadSource, { transport: 'shell-read', dialect: 'bash' }), false)
  assert.equal(sourceAccepts(shellReadSource, { transport: 'shell-read', dialect: 'powershell' }), false)
  assert.deepEqual(powershellReadSource.extract({ dialect: 'bash' }), [])
})

/**
 * @param {string} file - absolute target path.
 * @param {string} text - current file text.
 * @returns {object} context stub serving one file.
 */
function ctxWithFile(file, text) {
  return {
    fs: {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat(target) {
        if (target.targetKey !== file) return undefined
        return { type: 'file', size: Buffer.byteLength(text, 'utf8'), version: 'v1' }
      },
      async readText() {
        return text
      },
    },
  }
}

/**
 * @param {string} command - PowerShell command.
 * @param {object} planOverrides - extra plan fields.
 * @param {string} stdout - structured stdout the model saw.
 * @returns {object} normalized invocation.
 */
function invocationFor(command, planOverrides, stdout) {
  const parsed = parsePowerShellReadCommand(command)
  assert.equal(parsed.ok, true, command)
  return {
    transport: 'shell-read',
    dialect: 'powershell',
    plan: { ...parsed.plan, ...planOverrides },
    cwd: root,
    stdout,
  }
}

test('PowerShell stdout validates against DSH text after CRLF normalization', async () => {
  const file = resolve(root, 'a.ts')
  const ctx = ctxWithFile(file, 'a\n\nb\n')
  const invocation = invocationFor(
    'Get-Content a.ts',
    { file },
    'a\r\n\r\nb\r\n',
  )
  const validated = await validateEvidence(ctx, invocation, powershellReadSource.extract(invocation), signal)
  assert.equal(validated.length, 1)
  assert.equal(validated[0].expected, 'a\n\nb\n')
  assert.deepEqual(validated[0].snippets, [{ text: 'a\n\nb\n' }])
})

test('changed content, a wrong window, and a wrong -Raw tail never validate', async () => {
  const file = resolve(root, 'a.ts')
  const changed = await validateEvidence(
    ctxWithFile(file, 'a\n\nc\n'),
    {},
    powershellReadSource.extract(invocationFor('Get-Content a.ts', { file }, 'a\r\n\r\nb\r\n')),
    signal,
  )
  assert.deepEqual(changed, [])

  const wrongWindow = await validateEvidence(
    ctxWithFile(file, 'a\n\nb\n'),
    {},
    powershellReadSource.extract(invocationFor('Get-Content a.ts | Select-Object -Index 1', {
      file, selectors: [{ kind: 'index', index: 1 }],
    }, 'a\r\n')),
    signal,
  )
  assert.deepEqual(wrongWindow, [])

  const wrongRaw = await validateEvidence(
    ctxWithFile(file, 'a\n\nb\n'),
    {},
    powershellReadSource.extract(invocationFor('Get-Content a.ts -Raw', { file, mode: 'raw' }, 'a\r\n\r\nb\r\n')),
    signal,
  )
  assert.deepEqual(wrongRaw, [])
})

test('only a complete read may observe an empty file', async () => {
  const file = resolve(root, 'empty.ts')
  const whole = invocationFor('Get-Content empty.ts', { file }, '')
  assert.equal(
    (await validateEvidence(ctxWithFile(file, ''), {}, powershellReadSource.extract(whole), signal)).length,
    1,
  )

  const selected = invocationFor('Get-Content empty.ts | Select-Object -First 1', {
    file, selectors: [{ kind: 'first', count: 1 }],
  }, '')
  assert.deepEqual(
    await validateEvidence(ctxWithFile(file, ''), {}, powershellReadSource.extract(selected), signal),
    [],
  )
})
