import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MAX_EVIDENCE_FILES,
  DEFAULT_MAX_SOURCE_BYTES,
  resolveConfig,
  selectSources,
} from '../lib/config.js'
import { codegraphSource } from '../lib/sources/codegraph.js'

test('config defaults are applied', () => {
  assert.deepEqual(resolveConfig(undefined), {
    maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
    maxEvidenceFiles: DEFAULT_MAX_EVIDENCE_FILES,
    disabledSources: [],
  })
})

test('config overrides are validated and frozen', () => {
  const config = resolveConfig({
    maxSourceBytes: 1024,
    maxEvidenceFiles: 3,
    disabledSources: ['codegraph', 'codegraph'],
  })
  assert.equal(config.maxSourceBytes, 1024)
  assert.equal(config.maxEvidenceFiles, 3)
  assert.deepEqual(config.disabledSources, ['codegraph'])
  assert.equal(Object.isFrozen(config), true)
})

test('invalid config values fail at activation', () => {
  for (const raw of [
    { maxSourceBytes: 0 },
    { maxSourceBytes: 1.5 },
    { maxSourceBytes: '8' },
    { maxEvidenceFiles: 0 },
    { maxEvidenceFiles: -1 },
    { disabledSources: 'codegraph' },
    { disabledSources: [''] },
    [],
  ]) {
    assert.throws(() => resolveConfig(raw), TypeError)
  }
})

test('disabledSources only accepts known built-in source ids', () => {
  assert.deepEqual(selectSources([codegraphSource], []), [codegraphSource])
  assert.deepEqual(selectSources([codegraphSource], ['codegraph']), [])
  assert.throws(() => selectSources([codegraphSource], ['missing']), /unknown source/)
})
