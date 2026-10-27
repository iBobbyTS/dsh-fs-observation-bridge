import assert from 'node:assert/strict'
import test from 'node:test'
import { renderReadPlan } from '../lib/sources/shell-read-render.js'

/**
 * @param {Array<object>} stages - plan stages.
 * @returns {object} plan.
 */
function plan(stages) {
  return { dialect: 'bash', file: 'f', stages }
}

const WITH_NEWLINE = 'a\n\nb\n'
const WITHOUT_NEWLINE = 'a\n\nb'

test('cat preserves the file byte-for-byte, including a missing final newline', () => {
  assert.equal(renderReadPlan(plan([{ kind: 'cat', number: 'none' }]), WITH_NEWLINE), WITH_NEWLINE)
  assert.equal(renderReadPlan(plan([{ kind: 'cat', number: 'none' }]), WITHOUT_NEWLINE), WITHOUT_NEWLINE)
  assert.equal(renderReadPlan(plan([{ kind: 'cat', number: 'none' }]), ''), '')
})

test('head and tail preserve blank lines and the final newline state', () => {
  assert.equal(renderReadPlan(plan([{ kind: 'head', count: 2 }]), WITH_NEWLINE), 'a\n\n')
  assert.equal(renderReadPlan(plan([{ kind: 'tail', count: 2 }]), WITH_NEWLINE), '\nb\n')
  assert.equal(renderReadPlan(plan([{ kind: 'tail', from: 2 }]), WITH_NEWLINE), '\nb\n')
  assert.equal(renderReadPlan(plan([{ kind: 'tail', count: 2 }]), WITHOUT_NEWLINE), '\nb')
  assert.equal(renderReadPlan(plan([{ kind: 'head', count: 0 }]), WITH_NEWLINE), '')
})

test('sed ranges are inclusive and preserve a missing final newline', () => {
  assert.equal(renderReadPlan(plan([{ kind: 'sed', start: 2, end: 2 }]), WITH_NEWLINE), '\n')
  assert.equal(renderReadPlan(plan([{ kind: 'sed', start: 2, end: 3 }]), WITHOUT_NEWLINE), '\nb')
  assert.equal(renderReadPlan(plan([{ kind: 'sed', start: 3 }]), WITHOUT_NEWLINE), 'b')
  assert.equal(renderReadPlan(plan([{ kind: 'sed', start: 3 }]), WITH_NEWLINE), 'b\n')
})

test('cat -n, cat -b, and nl -ba use the six-column gutter', () => {
  assert.equal(
    renderReadPlan(plan([{ kind: 'cat', number: 'all' }]), WITH_NEWLINE),
    '     1\ta\n     2\t\n     3\tb\n',
  )
  assert.equal(
    renderReadPlan(plan([{ kind: 'cat', number: 'nonblank' }]), WITH_NEWLINE),
    '     1\ta\n\n     2\tb\n',
  )
  assert.equal(
    renderReadPlan(plan([{ kind: 'nl' }]), WITH_NEWLINE),
    '     1\ta\n     2\t\n     3\tb\n',
  )
  assert.equal(
    renderReadPlan(plan([{ kind: 'nl' }]), WITHOUT_NEWLINE),
    '     1\ta\n     2\t\n     3\tb',
  )
})

test('pipeline replay applies stages from left to right', () => {
  assert.equal(
    renderReadPlan(plan([{ kind: 'cat', number: 'none' }, { kind: 'head', count: 2 }]), WITH_NEWLINE),
    'a\n\n',
  )
  assert.equal(
    renderReadPlan(plan([{ kind: 'nl' }, { kind: 'sed', start: 2, end: 3 }]), WITH_NEWLINE),
    '     2\t\n     3\tb\n',
  )
  assert.equal(
    renderReadPlan(plan([{ kind: 'sed', start: 2, end: 3 }, { kind: 'nl' }]), WITHOUT_NEWLINE),
    '     1\t\n     2\tb',
  )
  assert.equal(
    renderReadPlan(plan([
      { kind: 'cat', number: 'none' },
      { kind: 'head', count: 2 },
      { kind: 'tail', count: 1 },
    ]), WITH_NEWLINE),
    '\n',
  )
  assert.equal(
    renderReadPlan(plan([
      { kind: 'cat', number: 'none' },
      { kind: 'nl' },
      { kind: 'sed', start: 2, end: 3 },
    ]), WITH_NEWLINE),
    '     2\t\n     3\tb\n',
  )
  assert.equal(
    renderReadPlan(plan([
      { kind: 'cat', number: 'none' },
      { kind: 'sed', start: 2, end: 3 },
      { kind: 'nl' },
    ]), WITHOUT_NEWLINE),
    '     1\t\n     2\tb',
  )
})

test('CRLF is normalized only for comparison', () => {
  assert.equal(
    renderReadPlan(plan([{ kind: 'cat', number: 'none' }]), 'a\r\nb\r\n'),
    'a\nb\n',
  )
})
