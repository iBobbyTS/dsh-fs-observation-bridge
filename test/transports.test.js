import assert from 'node:assert/strict'
import test from 'node:test'
import { cliTransport, parseSimpleCommand } from '../lib/transports/cli.js'
import { mcpTransport } from '../lib/transports/mcp.js'
import { nativeTransport } from '../lib/transports/native.js'
import { sourceAccepts } from '../lib/sources/registry.js'
import { codegraphSource } from '../lib/sources/codegraph.js'

const signal = new AbortController().signal

/**
 * Build a Context stub exposing only the working-directory service.
 * @param {string} cwd - the directory `ensure` returns.
 * @returns {object} the stub context.
 */
function ctxWithCwd(cwd) {
  return {
    get(name) {
      return name === 'workingDirectory' ? { async ensure() { return cwd } } : undefined
    },
  }
}

const result = { content: [{ type: 'text', text: 'source text' }] }

test('MCP transport normalizes server, raw tool, and content', async () => {
  const exec = {
    name: 'mcp__codegraph__codegraph_explore',
    arguments: { query: 'x', projectPath: '/repo' },
    agent: { session: {} },
    signal,
  }
  const transport = mcpTransport()
  assert.equal(transport.match(exec), true)
  assert.deepEqual(await transport.normalize(ctxWithCwd('/work'), exec, result), {
    transport: 'mcp',
    server: 'codegraph',
    toolName: 'codegraph_explore',
    operation: 'codegraph_explore',
    args: { query: 'x', projectPath: '/repo' },
    content: 'source text',
    cwd: '/work',
  })
})

test('CLI transport normalizes one simple command through a runner', async () => {
  const exec = {
    name: 'bash',
    arguments: { command: 'npx -y codegraph explore "auth flow" -p .' },
    agent: { session: {} },
    signal,
  }
  const transport = cliTransport()
  assert.equal(transport.match(exec), true)
  assert.deepEqual(await transport.normalize(ctxWithCwd('/repo'), exec, result), {
    transport: 'cli',
    program: 'codegraph',
    operation: 'explore',
    args: { tokens: ['explore', 'auth flow', '-p', '.'] },
    content: 'source text',
    cwd: '/repo',
  })
})

test('CLI transport rejects ambiguous shell commands', async () => {
  const transport = cliTransport()
  for (const command of [
    'codegraph explore x | head',
    'cd repo && codegraph explore x',
    'codegraph explore x > out.txt',
    'codegraph explore $DIR',
    'codegraph explore "$(pwd)"',
    'codegraph explore `pwd`',
    'codegraph explore x\ncodegraph node y',
  ]) {
    const exec = { name: 'bash', arguments: { command }, agent: { session: {} }, signal }
    assert.equal(await transport.normalize(ctxWithCwd('/repo'), exec, result), null, command)
  }
})

test('parseSimpleCommand accepts direct, absolute, and runner forms', () => {
  assert.deepEqual(parseSimpleCommand('codegraph explore "x"'), {
    program: 'codegraph', operation: 'explore', tokens: ['explore', 'x'],
  })
  assert.deepEqual(parseSimpleCommand('/opt/bin/codegraph node main'), {
    program: '/opt/bin/codegraph', operation: 'node', tokens: ['node', 'main'],
  })
  assert.deepEqual(parseSimpleCommand('pnpm exec codegraph context task'), {
    program: 'codegraph', operation: 'context', tokens: ['context', 'task'],
  })
  assert.equal(parseSimpleCommand('echo codegraph explore').program, 'echo')
  assert.equal(sourceAccepts(codegraphSource, {
    transport: 'cli', program: 'echo', operation: 'codegraph',
  }), false)
})

test('native transport covers ordinary tools only', async () => {
  const transport = nativeTransport()
  const exec = { name: 'read', arguments: { file_path: 'a' }, agent: { session: {} }, signal }
  assert.equal(transport.match(exec), true)
  assert.deepEqual(await transport.normalize(ctxWithCwd('/repo'), exec, result), {
    transport: 'native',
    toolName: 'read',
    operation: 'read',
    args: { file_path: 'a' },
    content: 'source text',
    cwd: '/repo',
  })
  assert.equal(transport.match({ name: 'mcp__codegraph__codegraph_explore' }), false)
  assert.equal(transport.match({ name: 'bash' }), false)
})

test('CodeGraph source accepts exactly its MCP and CLI forms', () => {
  assert.equal(sourceAccepts(codegraphSource, {
    transport: 'mcp', server: 'codegraph', toolName: 'codegraph_explore',
  }), true)
  assert.equal(sourceAccepts(codegraphSource, {
    transport: 'mcp', server: 'other', toolName: 'codegraph_explore',
  }), false)
  assert.equal(sourceAccepts(codegraphSource, {
    transport: 'cli', program: 'codegraph', operation: 'explore',
  }), true)
  assert.equal(sourceAccepts(codegraphSource, {
    transport: 'cli', program: 'codegraph', operation: 'sync',
  }), false)
  assert.equal(sourceAccepts(codegraphSource, { transport: 'native', toolName: 'read' }), false)
})
