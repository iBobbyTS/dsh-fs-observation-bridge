import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePowerShellReadCommand } from '../lib/transports/powershell-parser.js'

/**
 * @param {string} command - command text.
 * @returns {object} the accepted plan.
 */
function plan(command) {
  const parsed = parsePowerShellReadCommand(command)
  assert.equal(parsed.ok, true, command)
  return parsed.plan
}

/**
 * @param {string} command - command text.
 * @returns {void}
 */
function rejected(command) {
  assert.deepEqual(parsePowerShellReadCommand(command), { ok: false, reason: 'unsupported_syntax' }, command)
}

test('Get-Content positional paths form a complete line read', () => {
  for (const command of [
    String.raw`Get-Content .\src\app.ts`,
    String.raw`get-content .\src\app.ts`,
    String.raw`GC .\src\app.ts`,
    String.raw`gc .\src\app.ts`,
    String.raw`cat .\src\app.ts`,
    String.raw`type .\src\app.ts`,
    String.raw`Get-Content src/app.ts`,
    String.raw`Get-Content ..\src\app.ts`,
    String.raw`Get-Content C:\repo\src\app.ts`,
    String.raw`Get-Content '.\src\app.ts'`,
    String.raw`Get-Content ".\src\app.ts"`,
    String.raw`Get-Content 'C:\repo with space\app.ts'`,
    String.raw`Get-Content .\src\app.ts | Select-Object -First 100`,
  ]) {
    const parsed = plan(command)
    assert.equal(parsed.mode, 'lines')
    assert.equal(parsed.dialect, 'powershell')
  }
  assert.deepEqual(plan(String.raw`Get-Content .\src\app.ts`), {
    dialect: 'powershell',
    file: String.raw`.\src\app.ts`,
    mode: 'lines',
    selectors: [],
    permitEmpty: true,
  })
})

test('only -LiteralPath treats wildcard characters as literals', () => {
  const literal = plan(String.raw`Get-Content -LiteralPath '.\src\[id]\page.ts'`)
  assert.equal(literal.file, String.raw`.\src\[id]\page.ts`)
  assert.equal(literal.permitEmpty, true)

  const atLiteral = plan(String.raw`Get-Content -LiteralPath .\src\[id]\page.ts`)
  assert.equal(atLiteral.file, String.raw`.\src\[id]\page.ts`)

  for (const command of [
    String.raw`Get-Content .\src\[id]\page.ts`,
    String.raw`Get-Content -Path '.\src\[id]\page.ts'`,
    String.raw`Get-Content -Path *.ts`,
    String.raw`Get-Content *.ts`,
    String.raw`Get-Content .\a?.ts`,
  ]) {
    rejected(command)
  }
})

test('quoted literals may contain spaces, quotes, and literal dollar signs', () => {
  assert.equal(plan(String.raw`Get-Content '.\a b\c.ts'`).file, String.raw`.\a b\c.ts`)
  assert.equal(plan(String.raw`Get-Content '.\it''s\a.ts'`).file, String.raw`.\it's\a.ts`)
  assert.equal(plan(String.raw`Get-Content ".\it's\a.ts"`).file, String.raw`.\it's\a.ts`)
  assert.equal(plan(String.raw`Get-Content -LiteralPath '.\$folder\a.ts'`).file, String.raw`.\$folder\a.ts`)
})

test('-Raw reads the whole file as one string', () => {
  assert.deepEqual(plan(String.raw`Get-Content .\app.ts -Raw`), {
    dialect: 'powershell',
    file: String.raw`.\app.ts`,
    mode: 'raw',
    selectors: [],
    permitEmpty: true,
  })
  assert.equal(plan(String.raw`Get-Content -Raw -LiteralPath '.\app.ts'`).mode, 'raw')
})

test('-TotalCount, -Head, and -Tail map to first/last selectors', () => {
  assert.deepEqual(plan(String.raw`Get-Content .\app.ts -TotalCount 120`).selectors, [{ kind: 'first', count: 120 }])
  assert.deepEqual(plan(String.raw`Get-Content .\app.ts -Head 120`).selectors, [{ kind: 'first', count: 120 }])
  assert.deepEqual(plan(String.raw`Get-Content -Tail 50 .\app.ts`).selectors, [{ kind: 'last', count: 50 }])
  assert.equal(plan(String.raw`Get-Content .\app.ts -TotalCount 120`).permitEmpty, false)
  assert.equal(plan(String.raw`Get-Content .\app.ts -Tail 50`).permitEmpty, false)
})

test('Select-Object supports exactly the verified selector shapes', () => {
  assert.deepEqual(
    plan(String.raw`Get-Content .\app.ts | Select-Object -First 100`).selectors,
    [{ kind: 'first', count: 100 }],
  )
  assert.deepEqual(
    plan(String.raw`Get-Content .\app.ts | Select-Object -Last 50`).selectors,
    [{ kind: 'last', count: 50 }],
  )
  assert.deepEqual(
    plan(String.raw`Get-Content .\app.ts | Select-Object -Skip 200 -First 100`).selectors,
    [{ kind: 'skip', count: 200 }, { kind: 'first', count: 100 }],
  )
  // PowerShell parameter order does not change the object semantics.
  assert.deepEqual(
    plan(String.raw`Get-Content .\app.ts | Select-Object -First 100 -Skip 200`).selectors,
    [{ kind: 'skip', count: 200 }, { kind: 'first', count: 100 }],
  )
  assert.deepEqual(
    plan(String.raw`Get-Content .\app.ts | Select-Object -Index 42`).selectors,
    [{ kind: 'index', index: 42 }],
  )
  assert.deepEqual(
    plan(String.raw`Get-Content .\app.ts | select-object -index 0`).selectors,
    [{ kind: 'index', index: 0 }],
  )
  assert.equal(
    plan(String.raw`Get-Content .\app.ts | Select-Object -First 100`).permitEmpty,
    false,
  )
})

test('rejects paths and syntax whose reading semantics are not literal', () => {
  for (const command of [
    '',
    '   ',
    'Get-Content',
    String.raw`Get-Content a.ts b.ts`,
    String.raw`Get-Content -Path a.ts -LiteralPath b.ts`,
    String.raw`Get-Content -LiteralPath`,
    String.raw`Get-Content -LiteralPath a.ts -Path b.ts`,
    String.raw`Get-Content a.ts, b.ts`,
    String.raw`Get-Content .\a.ts:secret`,
    String.raw`Get-Content Env:PATH`,
    String.raw`Get-Content HKLM:\SOFTWARE`,
    String.raw`Get-Content C:relative.ts`,
    String.raw`Get-Content \\?\C:\a.ts`,
    String.raw`Get-Content \\.\PhysicalDrive0`,
    String.raw`Get-Content ~\a.ts`,
    String.raw`Get-Content $env:TEMP\a.ts`,
    String.raw`Get-Content $HOME\a.ts`,
    String.raw`Get-Content (Join-Path . a)`,
    String.raw`Get-Content "$env:TEMP\a.ts"`,
    'Get-Content ".\\a`nb.ts"',
    String.raw`Get-Content -`,
    String.raw`Get-Content .\a.ts -Wait`,
    String.raw`Get-Content .\a.ts -Stream secret`,
    String.raw`Get-Content .\a.ts -AsByteStream`,
    String.raw`Get-Content .\a.ts -Delimiter ,`,
    String.raw`Get-Content .\a.ts -ReadCount 5`,
    String.raw`Get-Content .\a.ts -Filter *.ts`,
    String.raw`Get-Content .\a.ts -Include *.ts`,
    String.raw`Get-Content .\a.ts -Exclude *.ts`,
    String.raw`Get-Content .\a.ts -Encoding utf8`,
    String.raw`Get-Content .\a.ts -Tot 5`,
    String.raw`Get-Content .\a.ts -TotalCount 0`,
    String.raw`Get-Content .\a.ts -TotalCount -5`,
    String.raw`Get-Content .\a.ts -TotalCount 5 -Tail 3`,
    String.raw`Get-Content .\a.ts -Raw -TotalCount 5`,
    String.raw`Get-Content .\a.ts -Raw -Tail 5`,
    String.raw`Get-Content .\a.ts -Raw | Select-Object -First 1`,
    String.raw`Get-Content .\a.ts -TotalCount 5 | Select-Object -First 1`,
    String.raw`Get-Content .\a.ts | Select-Object`,
    String.raw`Get-Content .\a.ts | Select-Object -Property Name`,
    String.raw`Get-Content .\a.ts | Select-Object -ExpandProperty Name`,
    String.raw`Get-Content .\a.ts | Select-Object -Unique`,
    String.raw`Get-Content .\a.ts | Select-Object -Skip 200`,
    String.raw`Get-Content .\a.ts | Select-Object -Last 5 -First 2`,
    String.raw`Get-Content .\a.ts | Select-Object -Index 1 -First 2`,
    String.raw`Get-Content .\a.ts | Select-Object -Skip 1 -Index 2`,
    String.raw`Get-Content .\a.ts | Select-Object -Index (20..80)`,
    String.raw`Get-Content .\a.ts | Select-Object -Index $i`,
    String.raw`Get-Content .\a.ts | Select-Object -First '5'`,
    String.raw`Get-Content .\a.ts | Select-Object -First 5 | Select-Object -Last 2`,
    String.raw`Get-Content .\a.ts | head -n 5`,
    String.raw`Get-Content .\a.ts | Select-String -Pattern foo`,
    String.raw`cmd.exe /c type .\a.ts`,
    String.raw`cmd /c type .\a.ts`,
    String.raw`Set-Content .\a.ts x`,
    String.raw`Add-Content .\a.ts x`,
    String.raw`Out-File .\a.ts`,
    String.raw`Get-Content .\a.ts > out.txt`,
    String.raw`Get-Content .\a.ts 2> err.txt`,
    String.raw`Get-Content .\a.ts; Get-Content .\b.ts`,
    String.raw`Get-Content .\a.ts;`,
    String.raw`Get-Content .\a.ts && Get-Content .\b.ts`,
    String.raw`Get-Content .\a.ts # comment`,
    String.raw`Get-Content .\a.ts |`,
    String.raw`| Get-Content .\a.ts`,
    'Get-Content .\a.ts\nGet-Content .\b.ts',
    String.raw`Get-Content '.\a.ts`,
    String.raw`& Get-Content .\a.ts`,
    String.raw`. .\a.ts`,
    String.raw`Get-Content @(.\a.ts)`,
    String.raw`Get-Content { .\a.ts }`,
  ]) {
    rejected(command)
  }
})
