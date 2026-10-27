import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderPowerShellOutput } from '../lib/sources/powershell-read-render.js'
import { parsePowerShellReadCommand } from '../lib/transports/powershell-parser.js'
import { normalizeCrlf } from '../lib/text.js'

/**
 * The exact prefix DSH's pwsh-local prepends to every command. Keeping it here
 * makes the fixture's stdout comparable with the bridge's structured stdout.
 */
const ENCODING_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/**
 * @param {string} executable - absolute or PATH name.
 * @returns {boolean} whether this PowerShell can run a trivial command.
 */
function canRun(executable) {
  try {
    execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
      timeout: 30_000,
    })
    return true
  } catch {
    return false
  }
}

const windows = process.platform === 'win32'
const pwshAvailable = windows && canRun('pwsh')
const powershell51Available = windows && canRun('powershell.exe')

/**
 * @param {string} executable - PowerShell executable.
 * @param {string} cwd - working directory.
 * @param {string} command - command text.
 * @returns {string} raw stdout text.
 */
function runPowerShell(executable, cwd, command) {
  return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ENCODING_PREAMBLE + command], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

/**
 * Create the fixture tree.
 * @returns {string} the temporary directory.
 */
function createFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'powershell-read-'))
  const files = {
    'lf-trail.txt': 'a\n\nb\n',
    'lf-notrail.txt': 'a\n\nb',
    'crlf.txt': 'a\r\n\r\nb\r\n',
    'empty.txt': '',
    'blank-first.txt': '\nfirst\n\n',
    'dup.txt': 'x\nx\nx\n',
    'unicode.txt': '第一行\n第二行\n',
    '中文文件.ts': '中文内容\nsecond line\n',
    'space name.ts': 'x\ny',
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  mkdirSync(join(dir, 'sub', '[id]'), { recursive: true })
  writeFileSync(join(dir, 'sub', '[id]', 'page.ts'), 'page one\npage two\n', 'utf8')
  return dir
}

/** Every verified form, each with the fixture whose content it replays. */
const CASES = [
  [String.raw`Get-Content .\lf-trail.txt`, 'lf-trail.txt'],
  [String.raw`get-content .\lf-trail.txt`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-notrail.txt`, 'lf-notrail.txt'],
  [String.raw`Get-Content .\crlf.txt`, 'crlf.txt'],
  [String.raw`Get-Content .\empty.txt`, 'empty.txt'],
  [String.raw`Get-Content .\blank-first.txt`, 'blank-first.txt'],
  [String.raw`Get-Content .\dup.txt`, 'dup.txt'],
  [String.raw`Get-Content .\dup.txt -Tail 2`, 'dup.txt'],
  [String.raw`Get-Content .\dup.txt | Select-Object -Index 2`, 'dup.txt'],
  [String.raw`Get-Content .\dup.txt | Select-Object -Skip 1 -First 2`, 'dup.txt'],
  [String.raw`Get-Content .\unicode.txt`, 'unicode.txt'],
  [String.raw`Get-Content -LiteralPath '.\中文文件.ts'`, '中文文件.ts'],
  [String.raw`Get-Content '.\space name.ts'`, 'space name.ts'],
  [String.raw`Get-Content -LiteralPath '.\sub\[id]\page.ts'`, 'sub/[id]/page.ts'],
  [String.raw`Get-Content .\lf-trail.txt -Raw`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-notrail.txt -Raw`, 'lf-notrail.txt'],
  [String.raw`Get-Content .\crlf.txt -Raw`, 'crlf.txt'],
  [String.raw`Get-Content .\empty.txt -Raw`, 'empty.txt'],
  [String.raw`Get-Content .\lf-trail.txt -TotalCount 2`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-trail.txt -Head 99`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-trail.txt -Tail 2`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-notrail.txt -Tail 2`, 'lf-notrail.txt'],
  [String.raw`Get-Content .\lf-trail.txt | Select-Object -First 2`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-trail.txt | Select-Object -Last 2`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-notrail.txt | Select-Object -Last 2`, 'lf-notrail.txt'],
  [String.raw`Get-Content .\lf-trail.txt | Select-Object -Skip 1 -First 2`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-trail.txt | Select-Object -First 2 -Skip 1`, 'lf-trail.txt'],
  [String.raw`Get-Content .\lf-trail.txt | Select-Object -Index 2`, 'lf-trail.txt'],
  [String.raw`gc .\lf-trail.txt`, 'lf-trail.txt'],
  [String.raw`cat .\lf-trail.txt`, 'lf-trail.txt'],
  [String.raw`type .\lf-trail.txt`, 'lf-trail.txt'],
]

/** Fixtures whose content is not ASCII: 5.1 reads those through the ANSI page. */
const NON_ASCII_FIXTURES = new Set(['unicode.txt', '中文文件.ts'])

/** Forms whose semantics are encoding-independent, for the 5.1 fallback. */
const ASCII_CASES = CASES.filter(([, file]) => !NON_ASCII_FIXTURES.has(file))

/**
 * Assert every case renders exactly what the real shell wrote.
 * @param {string} executable - PowerShell executable.
 */
function assertDifferential(executable) {
  const dir = createFixtures()
  try {
    for (const [command, file] of CASES) {
      const parsed = parsePowerShellReadCommand(command)
      assert.equal(parsed.ok, true, command)
      const content = readFileSync(join(dir, file), 'utf8')
      const expected = normalizeCrlf(renderPowerShellOutput(parsed.plan, content))
      const actual = normalizeCrlf(runPowerShell(executable, dir, command))
      assert.equal(actual, expected, `${executable}: ${command}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

test('PowerShell 7 stdout replay matches the real shell', {
  skip: windows ? pwshAvailable ? false : 'pwsh is not installed' : 'Windows-only fixture',
}, () => {
  assertDifferential('pwsh')
})

test('Windows PowerShell 5.1 fallback matches for encoding-independent reads', {
  skip: windows
    ? powershell51Available ? false : 'powershell.exe is not installed'
    : 'Windows-only fixture',
}, () => {
  const dir = createFixtures()
  try {
    for (const [command, file] of ASCII_CASES) {
      const parsed = parsePowerShellReadCommand(command)
      assert.equal(parsed.ok, true, command)
      const content = readFileSync(join(dir, file), 'utf8')
      const expected = normalizeCrlf(renderPowerShellOutput(parsed.plan, content))
      const actual = normalizeCrlf(runPowerShell('powershell.exe', dir, command))
      assert.equal(actual, expected, `powershell.exe: ${command}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
