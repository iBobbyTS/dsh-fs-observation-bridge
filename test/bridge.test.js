import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { registerBridge } from '../lib/bridge.js'
import { clearPending } from '../lib/observation/emit.js'
import { codegraphSource } from '../lib/sources/codegraph.js'
import { powershellReadSource } from '../lib/sources/powershell-read.js'
import { createSourceRegistry } from '../lib/sources/registry.js'
import { shellReadSource } from '../lib/sources/shell-read.js'
import { cliTransport } from '../lib/transports/cli.js'
import { mcpTransport } from '../lib/transports/mcp.js'
import { nativeTransport } from '../lib/transports/native.js'
import { createTransportRegistry } from '../lib/transports/registry.js'
import { shellReadTransport } from '../lib/transports/shell-read.js'

const signal = new AbortController().signal

const SOURCE_TEXT = [
  '**`alpha.js`** — alpha(const)',
  '',
  '```javascript',
  '1\texport const alpha = 1',
  '```',
].join('\n')

/**
 * Create a temporary indexed project and a fake fs/mount harness.
 * @param {{ content?: string }} [options] - file content override.
 * @returns {object} harness with handlers, emissions, project, and cleanup.
 */
function harness(options = {}) {
  const project = mkdtempSync(join(tmpdir(), 'fs-bridge-'))
  mkdirSync(join(project, '.codegraph'))
  writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
  const alpha = join(project, 'alpha.js')
  const files = { [alpha]: options.content ?? 'export const alpha = 1\n' }
  const emissions = []
  const handlers = new Map()
  const ctx = {
    fs: {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat(target) {
        const text = files[target.targetKey]
        if (text === undefined) return undefined
        return { type: 'file', size: text.length, version: 'v1' }
      },
      async readText(target) {
        return files[target.targetKey]
      },
    },
    get(name) {
      return name === 'workingDirectory' ? { async ensure() { return project } } : undefined
    },
    on(event, listener) {
      handlers.set(event, listener)
      return () => {}
    },
    effect(callback) {
      return callback()
    },
    emit(event, target, observation, actor) {
      emissions.push({ event, target, observation, actor })
    },
    logger: undefined,
  }
  registerBridge(
    ctx,
    options.transports ?? createTransportRegistry([mcpTransport(), cliTransport(), nativeTransport()]),
    options.sources ?? createSourceRegistry([codegraphSource]),
  )
  return {
    project,
    alpha,
    emissions,
    handlers,
    async post(exec, result) {
      return handlers.get('tools/post-execute')(exec, result, async () => ({ kind: 'accept' }))
    },
    result(exec, result) {
      handlers.get('tools/result')(exec, result)
    },
    cleanup() {
      rmSync(project, { recursive: true, force: true })
    },
  }
}

/**
 * Build an MCP tool call for the fixture.
 * @param {string} project - fixture directory.
 * @param {string} [callId] - call identity.
 * @returns {object} the execution view.
 */
function mcpExec(project, callId = 'call-mcp') {
  return {
    name: 'mcp__codegraph__codegraph_explore',
    arguments: { query: 'alpha', projectPath: project },
    callId,
    agent: { session: {} },
    signal,
  }
}

beforeEach(() => {
  clearPending()
})

test('MCP output validates and authorizes after the final result', async () => {
  const h = harness()
  try {
    const exec = mcpExec(h.project)
    const result = { isError: false, content: [{ type: 'text', text: SOURCE_TEXT }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 1)
    assert.equal(h.emissions[0].event, 'fs/observed')
    assert.equal(h.emissions[0].target.targetKey, h.alpha)
    assert.deepEqual(h.emissions[0].observation, { kind: 'present', version: 'v1' })
  } finally {
    h.cleanup()
  }
})

test('CLI output authorizes through the -p project path', async () => {
  const h = harness()
  try {
    const exec = {
      name: 'bash',
      arguments: { command: `codegraph explore "alpha" -p ${h.project}` },
      callId: 'call-cli',
      agent: { session: {} },
      signal,
    }
    const result = { isError: false, content: [{ type: 'text', text: SOURCE_TEXT }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 1)
  } finally {
    h.cleanup()
  }
})

test('a rewritten final result authorizes nothing', async () => {
  const h = harness()
  try {
    const exec = mcpExec(h.project)
    const result = { isError: false, content: [{ type: 'text', text: SOURCE_TEXT }] }
    await h.post(exec, result)
    h.result(exec, { isError: false, content: [{ type: 'text', text: 'spilled preview' }] })
    assert.equal(h.emissions.length, 0)
  } finally {
    h.cleanup()
  }
})

test('evidence that no longer matches the file authorizes nothing', async () => {
  const h = harness({ content: 'export const alpha = 999\n' })
  try {
    const exec = mcpExec(h.project)
    const result = { isError: false, content: [{ type: 'text', text: SOURCE_TEXT }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 0)
  } finally {
    h.cleanup()
  }
})

test('ambiguous sources are skipped instead of resolved by order', async () => {
  const h = harness({ sources: createSourceRegistry([codegraphSource, codegraphSource]) })
  try {
    const exec = mcpExec(h.project)
    const result = { isError: false, content: [{ type: 'text', text: SOURCE_TEXT }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 0)
  } finally {
    h.cleanup()
  }
})

test('PTC nested calls are skipped', async () => {
  const h = harness()
  try {
    const exec = { ...mcpExec(h.project), parent: { token: 'outer' } }
    const result = { isError: false, content: [{ type: 'text', text: SOURCE_TEXT }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 0)
  } finally {
    h.cleanup()
  }
})


test('shell-read cat authorizes the file after exact final-output verification', async () => {
  const h = harness({
    transports: createTransportRegistry([mcpTransport(), cliTransport(), shellReadTransport(), nativeTransport()]),
    sources: createSourceRegistry([codegraphSource, shellReadSource]),
  })
  try {
    const exec = {
      name: 'bash',
      arguments: { command: 'cat alpha.js' },
      callId: 'call-shell',
      agent: { session: {} },
      signal,
    }
    const value = {
      kind: 'foreground',
      cwd: h.project,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: { text: 'export const alpha = 1\n', truncated: false },
      stderr: { text: '', truncated: false },
    }
    const result = { isError: false, value, content: [{ type: 'text', text: value.stdout.text }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 1)
    assert.equal(h.emissions[0].target.targetKey, h.alpha)
  } finally {
    h.cleanup()
  }
})

test('pwsh Get-Content authorizes through Windows CRLF stdout', async () => {
  const h = harness({
    transports: createTransportRegistry([mcpTransport(), cliTransport(), shellReadTransport(), nativeTransport()]),
    sources: createSourceRegistry([codegraphSource, shellReadSource, powershellReadSource]),
  })
  try {
    const exec = {
      name: 'pwsh',
      arguments: { command: 'Get-Content alpha.js' },
      callId: 'call-pwsh',
      agent: { session: {} },
      signal,
    }
    const stdout = 'export const alpha = 1\r\n'
    const value = {
      kind: 'foreground',
      cwd: h.project,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: { text: stdout, truncated: false },
      stderr: { text: '', truncated: false },
    }
    const result = { isError: false, value, content: [{ type: 'text', text: stdout }] }
    await h.post(exec, result)
    h.result(exec, result)
    assert.equal(h.emissions.length, 1)
    assert.equal(h.emissions[0].target.targetKey, h.alpha)
    assert.deepEqual(h.emissions[0].observation, { kind: 'present', version: 'v1' })
  } finally {
    h.cleanup()
  }
})
