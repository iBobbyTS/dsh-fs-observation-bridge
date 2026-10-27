import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderReadPlan } from '../lib/sources/shell-read-render.js'

/**
 * @param {Array<object>} stages - plan stages.
 * @returns {object} plan.
 */
function plan(stages) {
  return { dialect: 'bash', file: 'f', stages }
}

test('ReadPlan replay matches the platform commands for common forms', {
  // The Windows preset runs PowerShell and system32\bash.exe is WSL, which
  // cannot use a Windows temp path as its cwd. PowerShell coverage lives in
  // powershell-differential.test.js.
  skip: process.platform === 'win32'
    ? 'GNU coreutils are not available in the Windows preset'
    : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-read-'))
  try {
    writeFileSync(join(dir, 'f'), 'a\n\nb\n')
    const content = readFileSync(join(dir, 'f'), 'utf8')
    const cases = [
      ['cat f', plan([{ kind: 'cat', number: 'none' }])],
      ['cat -n f', plan([{ kind: 'cat', number: 'all' }])],
      ['cat -b f', plan([{ kind: 'cat', number: 'nonblank' }])],
      ['nl -ba f', plan([{ kind: 'nl' }])],
      ['head -n 2 f', plan([{ kind: 'head', count: 2 }])],
      ['tail -n 2 f', plan([{ kind: 'tail', count: 2 }])],
      ['tail -n +2 f', plan([{ kind: 'tail', from: 2 }])],
      ["sed -n '2p' f", plan([{ kind: 'sed', start: 2, end: 2 }])],
      ["sed -n '2,3p' f", plan([{ kind: 'sed', start: 2, end: 3 }])],
      ['cat f | head -n 2', plan([{ kind: 'cat', number: 'none' }, { kind: 'head', count: 2 }])],
      ["nl -ba f | sed -n '2,3p'", plan([{ kind: 'nl' }, { kind: 'sed', start: 2, end: 3 }])],
      ["sed -n '2,3p' f | nl -ba", plan([{ kind: 'sed', start: 2, end: 3 }, { kind: 'nl' }])],
      ['cat f | head -n 2 | tail -n 1', plan([{ kind: 'cat', number: 'none' }, { kind: 'head', count: 2 }, { kind: 'tail', count: 1 }])],
      ["cat f | sed -n '1,2p' | nl -ba", plan([{ kind: 'cat', number: 'none' }, { kind: 'sed', start: 1, end: 2 }, { kind: 'nl' }])],
      ["cat f | nl -ba | sed -n '2,3p'", plan([{ kind: 'cat', number: 'none' }, { kind: 'nl' }, { kind: 'sed', start: 2, end: 3 }])],
      ['cat f | head -n 2 | head -n 1', plan([{ kind: 'cat', number: 'none' }, { kind: 'head', count: 2 }, { kind: 'head', count: 1 }])],
      ['cat f | tail -n 2 | head -n 1', plan([{ kind: 'cat', number: 'none' }, { kind: 'tail', count: 2 }, { kind: 'head', count: 1 }])],
      ['cat f | head -n 2 | nl -ba', plan([{ kind: 'cat', number: 'none' }, { kind: 'head', count: 2 }, { kind: 'nl' }])],
      ['nl -ba f | head -n 2', plan([{ kind: 'nl' }, { kind: 'head', count: 2 }])],
      ["sed -n '2,3p' f | head -n 1", plan([{ kind: 'sed', start: 2, end: 3 }, { kind: 'head', count: 1 }])],
    ]
    for (const [command, readPlan] of cases) {
      const actual = execFileSync('bash', ['-c', command], { cwd: dir, encoding: 'utf8' })
      assert.equal(renderReadPlan(readPlan, content), actual, command)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
