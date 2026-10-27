import assert from 'node:assert/strict'
import test from 'node:test'
import { renderPowerShellOutput } from '../lib/sources/powershell-read-render.js'

/**
 * @param {Array<object>} selectors - plan selectors.
 * @param {'lines' | 'raw'} [mode] - read mode.
 * @returns {object} plan.
 */
function plan(selectors, mode = 'lines') {
  return { dialect: 'powershell', file: 'f', mode, selectors }
}

const WHOLE = plan([])
const RAW = plan([], 'raw')

test('a line read reproduces line objects followed by one host newline', () => {
  assert.equal(renderPowerShellOutput(WHOLE, 'a\n\nb\n'), 'a\n\nb\n')
  assert.equal(renderPowerShellOutput(WHOLE, 'a\n\nb'), 'a\n\nb\n')
  assert.equal(renderPowerShellOutput(WHOLE, 'a'), 'a\n')
  assert.equal(renderPowerShellOutput(WHOLE, '\n'), '\n')
  assert.equal(renderPowerShellOutput(WHOLE, 'a\n\n'), 'a\n\n')
  assert.equal(renderPowerShellOutput(WHOLE, ''), '')
})

test('CRLF and lone CR both become host line boundaries', () => {
  assert.equal(renderPowerShellOutput(WHOLE, 'a\r\nb\r\n'), 'a\nb\n')
  assert.equal(renderPowerShellOutput(WHOLE, 'a\rb'), 'a\nb\n')
})

test('-Raw keeps the file text and the host adds one newline', () => {
  assert.equal(renderPowerShellOutput(RAW, 'a\n\nb\n'), 'a\n\nb\n\n')
  assert.equal(renderPowerShellOutput(RAW, 'a\n\nb'), 'a\n\nb\n')
  assert.equal(renderPowerShellOutput(RAW, 'a'), 'a\n')
  assert.equal(renderPowerShellOutput(RAW, ''), '')
})

test('first/last/skip select line objects, not bytes', () => {
  const content = 'a\n\nb\nc'
  assert.equal(renderPowerShellOutput(plan([{ kind: 'first', count: 2 }]), content), 'a\n\n')
  assert.equal(renderPowerShellOutput(plan([{ kind: 'last', count: 2 }]), content), 'b\nc\n')
  assert.equal(
    renderPowerShellOutput(plan([{ kind: 'skip', count: 1 }, { kind: 'first', count: 2 }]), content),
    '\nb\n',
  )
  assert.equal(renderPowerShellOutput(plan([{ kind: 'index', index: 0 }]), content), 'a\n')
  assert.equal(renderPowerShellOutput(plan([{ kind: 'index', index: 2 }]), content), 'b\n')
})

test('a selector past the end of the file produces no output', () => {
  assert.equal(renderPowerShellOutput(plan([{ kind: 'index', index: 9 }]), 'a\nb\n'), '')
  assert.equal(renderPowerShellOutput(plan([{ kind: 'skip', count: 9 }, { kind: 'first', count: 2 }]), 'a\nb\n'), '')
  assert.equal(renderPowerShellOutput(plan([{ kind: 'first', count: 9 }]), ''), '')
})

test('selectors clamp to the available lines', () => {
  assert.equal(renderPowerShellOutput(plan([{ kind: 'first', count: 9 }]), 'a\nb'), 'a\nb\n')
  assert.equal(renderPowerShellOutput(plan([{ kind: 'last', count: 9 }]), 'a\nb'), 'a\nb\n')
})
