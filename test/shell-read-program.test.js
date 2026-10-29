import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, stat, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseShellReadProgram, parseShellReadCommand, shellReadTransport } from '../lib/transports/shell-read.js'
import { shellReadSource } from '../lib/sources/shell-read.js'
import { validateEvidence } from '../lib/observation/evidence.js'
import { stash, flush, clearPending } from '../lib/observation/emit.js'
import { registerBridge } from '../lib/bridge.js'

// Only fixed commands authored below run, inside a disposable fixture directory.
// Never pass command corpora or arbitrary user input to this helper.
const bash = process.platform !== 'win32'
  && spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
const limits = { maxSourceBytes: 8 * 1024 * 1024, maxEvidenceFiles: 200 }
const signal = () => new AbortController().signal
const quote = text => `'${text.replace(/'/gu, `'\\''`)}'`

async function fixture(t, files = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'observe-read-'))
  t.after(async () => { clearPending(); await rm(cwd, { recursive: true, force: true }) })
  const data = { 'a.ts': 'alpha\nbeta\ngamma\n', 'b.ts': 'delta\nepsilon\n', 'empty.ts': '', ...files }
  for (const [path, content] of Object.entries(data)) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), content)
  }
  const events = []
  const handlers = new Map()
  const ctx = {
    fs: {
      async resolve(path) { const key = await realpath(path); return { targetKey: key, displayPath: path } },
      async stat(target) {
        try { const info = await stat(target.targetKey, { bigint: true }); return {
          version: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: Number(info.size),
        } } catch (e) { if (e.code === 'ENOENT') return undefined; throw e }
      },
      async readText(target) { return await readFile(target.targetKey, 'utf8') },
    },
    get: name => name === 'workingDirectory' ? { ensure: async () => cwd } : undefined,
    emit: (name, target, observation, exec) => events.push({ name, target, observation, exec }),
    effect() {},
    on: (name, handler) => handlers.set(name, handler),
  }
  const makeExec = command => ({ name: 'bash', arguments: { command }, callId: 'call', token: Symbol('call'), agent: { session: {} }, signal: signal() })
  const run = command => {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: cwd },
    })
    const value = { kind: 'foreground', cwd, exitCode: result.status, signal: result.signal,
      timedOut: result.error?.code === 'ETIMEDOUT', aborted: false,
      stdout: { text: result.stdout ?? '', truncated: false }, stderr: { text: result.stderr ?? '', truncated: false } }
    return { isError: false, value, content: [{ type: 'text', text: value.stdout.text || '(no output)' }] }
  }
  async function validate(exec, result) {
    const invocation = await shellReadTransport().normalize(ctx, exec, result)
    return invocation === null ? [] : await validateEvidence(ctx, invocation, shellReadSource.extract(invocation), exec.signal, limits)
  }
  return { cwd, ctx, events, handlers, makeExec, run, validate }
}

const accepted = [
  'cat a.ts; cat b.ts', 'cat a.ts && cat b.ts', 'cat a.ts\ncat b.ts',
  "cat a.ts; echo '=========SERVICE'; cat b.ts", 'cat a.ts; echo; cat b.ts;',
  "cat a.ts; printf '%s\\n' '===SERVICE'; cat b.ts",
  "cat a.ts; printf '\\n===SERVICE\\n'; cat b.ts",
  'cat a.ts b.ts', 'cat -- a.ts b.ts', 'cat a.ts b.ts | head -n 4',
  "cat a.ts; sed -n '1,2p' b.ts", "nl -ba a.ts; tail -n 1 b.ts",
  'cat a.ts && cat b.ts 2>/dev/null', 'cat a.ts 2>/dev/null && cat b.ts',
  'cd ./src && cat a.ts; cat b.ts', 'cd ./src; cat a.ts',
  'cat a.ts; echo "---SERVICE---"; cat b.ts',
]
for (const command of accepted) test(`compile accepted: ${command}`, () => assert.equal(parseShellReadProgram(command).ok, true))
const rejected = [
  'cat a.ts || cat b.ts', 'cat a.ts & cat b.ts', '(cat a.ts); cat b.ts',
  'cat a.ts; rm b.ts', 'cat a.ts; touch b.ts', 'cat a.ts; node -e "42"',
  "node -e \"console.log('cat a.ts; cat b.ts')\"", "echo 'cat a.ts; cat b.ts'",
  'cat a.ts > out; cat out', 'cat a.ts 2>&1; cat b.ts', 'cat a.ts >/dev/null; cat b.ts',
  'cat a.ts 2>/dev/null; cat b.ts', 'cat a.ts 2>/dev/null && echo ok; cat b.ts',
  'cat a.ts 2>/dev/null | head -n 1', 'cat a.ts | head -n 1 2>/dev/null',
  'cd src && cat a.ts', 'cd - && cat a.ts', 'cd "$ROOT" && cat a.ts',
  'cat *.ts; cat b.ts', 'cat "$FILE"; cat b.ts', 'cat $(printf a.ts); cat b.ts',
  'cat a.ts; echo -e hello; cat b.ts', "cat a.ts; printf '%b' 'hello'; cat b.ts",
  'cat a.ts; # ignored\ncat b.ts', 'cat a.ts &&', 'cat a.ts;; cat b.ts',
  'for f in a.ts b.ts; do cat "$f"; done', 'eval "cat a.ts; cat b.ts"',
  'cat -n a.ts b.ts', 'cat a.ts b.ts | tee out', 'cat a.ts; wc -l b.ts',
]
for (const command of rejected) test(`compile rejected: ${command}`, () => assert.equal(parseShellReadProgram(command).ok, false))

test('legacy single-file plans retain their shape', () => {
  for (const command of ['cat a.ts', 'head -n 3 a.ts', "sed -n '1,2p' a.ts", 'nl -ba a.ts | head -n 2']) {
    assert.deepEqual(parseShellReadProgram(command), parseShellReadCommand(command))
  }
})

for (const command of accepted.filter(c => !c.startsWith('cd '))) {
  test(`differential replay: ${command}`, { skip: !bash }, async t => {
    const f = await fixture(t)
    const exec = f.makeExec(command), result = f.run(command)
    assert.equal(result.value.exitCode, 0); assert.equal(result.value.stderr.text, '')
    const evidence = await f.validate(exec, result)
    assert.equal(evidence.length, 2)
    stash(exec, evidence); flush(f.ctx, exec, result)
    assert.equal(f.events.length, 2)
    assert.deepEqual(new Set(f.events.map(e => e.target.targetKey)), new Set([join(f.cwd, 'a.ts'), join(f.cwd, 'b.ts')]))
  })
}

test('initial cd and source path resolution', { skip: !bash }, async t => {
  const f = await fixture(t, { 'src/a.ts': 'A\n', 'src/b.ts': 'B\n' })
  for (const command of ["cd ./src && cat a.ts; echo '=========SERVICE'; cat b.ts", `cd ${quote(join(f.cwd, 'src'))} && cat a.ts; cat b.ts`]) {
    const evidence = await f.validate(f.makeExec(command), f.run(command))
    assert.deepEqual(evidence.map(x => x.target.targetKey).sort(), [join(f.cwd, 'src/a.ts'), join(f.cwd, 'src/b.ts')])
  }
})

test('selector provenance does not authorize invisible cat operands', { skip: !bash }, async t => {
  const f = await fixture(t)
  for (const [command, wanted] of [
    ['cat a.ts b.ts | head -n 2', ['a.ts']],
    ['cat a.ts b.ts | tail -n 2', ['b.ts']],
    ["cat a.ts b.ts | sed -n '3,4p'", ['a.ts', 'b.ts']],
    ['cat a.ts b.ts | head -n 4 | tail -n 1', ['b.ts']],
    ["cat a.ts b.ts | nl -ba | sed -n '4,4p'", ['b.ts']],
  ]) {
    const evidence = await f.validate(f.makeExec(command), f.run(command))
    assert.deepEqual(evidence.map(x => x.target.targetKey).sort(), wanted.map(x => join(f.cwd, x)).sort(), command)
  }
})

test('missing newline across cat boundaries attributes both visible inputs', { skip: !bash }, async t => {
  const f = await fixture(t, { 'a.ts': 'hel', 'b.ts': 'lo\nworld\n' })
  const command = 'cat a.ts b.ts | head -n 1'
  assert.equal((await f.validate(f.makeExec(command), f.run(command))).length, 2)
})

test('literal separator collision is not used as a splitting heuristic', { skip: !bash }, async t => {
  const f = await fixture(t, { 'a.ts': '=========SERVICE\nalpha\n' })
  const command = "cat a.ts; echo '=========SERVICE'; cat b.ts"
  const e = f.makeExec(command), r = f.run(command)
  assert.equal((await f.validate(e, r)).length, 2)
  r.value.stdout.text = r.value.stdout.text.replace('alpha', 'forged')
  assert.equal((await f.validate(e, r)).length, 0)
})

test('compound empty reads do not confer observation', { skip: !bash }, async t => {
  const f = await fixture(t)
  const command = 'cat empty.ts; cat a.ts'
  const evidence = await f.validate(f.makeExec(command), f.run(command))
  assert.deepEqual(evidence.map(x => x.target.targetKey), [join(f.cwd, 'a.ts')])
  const empty = 'cat empty.ts; echo marker'
  assert.equal((await f.validate(f.makeExec(empty), f.run(empty))).length, 0)
})

test('early failure hidden by last exit zero is rejected on stderr', { skip: !bash }, async t => {
  const f = await fixture(t)
  const command = 'cat missing.ts; cat b.ts'
  const result = f.run(command)
  assert.equal(result.value.exitCode, 0); assert.notEqual(result.value.stderr.text, '')
  assert.equal((await f.validate(f.makeExec(command), result)).length, 0)
})

test('suppressed AND failure remains a failed foreground result', { skip: !bash }, async t => {
  const f = await fixture(t)
  const command = 'cat missing.ts 2>/dev/null && cat b.ts'
  assert.equal(parseShellReadProgram(command).ok, true)
  const result = f.run(command)
  assert.notEqual(result.value.exitCode, 0)
  assert.equal((await f.validate(f.makeExec(command), result)).length, 0)
})

test('all lifecycle and capture failures reject the group', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts'
  const exec = f.makeExec(command), good = f.run(command)
  const variants = [
    { exitCode: 1 }, { signal: 'SIGTERM' }, { timedOut: true }, { aborted: true }, { stopped: 'stopped' },
    { kind: 'background' }, { kind: 'promoted' }, { cwd: '/different' }, { cwd: undefined },
    { stdout: { ...good.value.stdout, truncated: true } },
    { stderr: { text: 'warning', truncated: false } }, { stderr: { text: '', truncated: true } },
    { stdout: { ...good.value.stdout, spillPath: '/tmp/spill' } }, { sandbox: { denied: true } }, { sandbox: { runnerFailed: true } },
  ]
  for (const change of variants) assert.equal((await f.validate(exec, { ...good, value: { ...good.value, ...change } })).length, 0, JSON.stringify(change))
})

test('group rechecks an earlier file after reading a later file', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts'
  const exec = f.makeExec(command), result = f.run(command)
  const read = f.ctx.fs.readText
  f.ctx.fs.readText = async target => {
    const text = await read(target)
    if (target.targetKey.endsWith('/b.ts')) await writeFile(join(f.cwd, 'a.ts'), 'changed\n')
    return text
  }
  assert.equal((await f.validate(exec, result)).length, 0)
})

test('all-or-nothing group rejects a different file snapshot', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts'
  const exec = f.makeExec(command), result = f.run(command)
  await writeFile(join(f.cwd, 'b.ts'), 'changed\n')
  assert.equal((await f.validate(exec, result)).length, 0)
})

test('file and byte limits reject the whole group', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts', exec = f.makeExec(command), result = f.run(command)
  const inv = await shellReadTransport().normalize(f.ctx, exec, result)
  const evidence = shellReadSource.extract(inv)
  for (const restricted of [{ ...limits, maxEvidenceFiles: 1 }, { ...limits, maxSourceBytes: 2 }]) {
    assert.equal((await validateEvidence(f.ctx, inv, evidence, exec.signal, restricted)).length, 0)
  }
})

test('final result rewrites cannot preserve authorization by substring', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts', exec = f.makeExec(command), result = f.run(command)
  const evidence = await f.validate(exec, result)
  for (const text of [result.value.stdout.text.slice(0, -1), 'prefix\n' + result.value.stdout.text, 'summary only', result.value.stdout.text + '\nsuffix']) {
    stash(exec, evidence); flush(f.ctx, exec, { ...result, content: [{ type: 'text', text }] })
  }
  assert.equal(f.events.length, 0)
})

test('executor tokens isolate identical callIds from parallel executions', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts'
  const a = f.makeExec(command), b = f.makeExec(command), result = f.run(command)
  const evidence = await f.validate(a, result)
  stash(a, evidence); stash(b, evidence)
  flush(f.ctx, a, result); flush(f.ctx, b, result)
  assert.equal(f.events.length, 4)
})

test('actual bridge emits only for direct visible calls, not PTC nested calls', { skip: !bash }, async t => {
  const f = await fixture(t), command = 'cat a.ts; cat b.ts', result = f.run(command)
  registerBridge(f.ctx, [shellReadTransport()], [shellReadSource], limits)
  const post = f.handlers.get('tools/post-execute'), final = f.handlers.get('tools/result')
  const direct = f.makeExec(command), nested = { ...f.makeExec(command), parent: Symbol('run_code') }
  await post(nested, result, async () => ({ kind: 'accept' })); final(nested, result)
  assert.equal(f.events.length, 0)
  await post(direct, result, async () => ({ kind: 'accept' })); final(direct, result)
  assert.equal(f.events.length, 2)
})

test('symlink file operands retain physical parent traversal', { skip: !bash || process.platform === 'win32' }, async t => {
  const f = await fixture(t, { 'real/sub/nested.ts': 'nested\n', 'real/a.ts': 'real-parent\n' })
  await symlink(join(f.cwd, 'real/sub'), join(f.cwd, 'link'))
  const command = 'cat link/../a.ts; cat b.ts'
  const evidence = await f.validate(f.makeExec(command), f.run(command))
  assert.deepEqual(evidence.map(x => x.target.targetKey).sort(), [join(f.cwd, 'real/a.ts'), join(f.cwd, 'b.ts')].sort())
})

for (const command of [
  'tail -2 a.ts', 'tail -2 a.ts; cat b.ts',
  "cat -n a.ts | sed -n '1,2p'", 'head -n 3 a.ts | tail -n 2',
  'tail -n 2 a.ts | head -n 1', "cat -b a.ts | sed -n '1,2p'; cat b.ts",
]) test(`targeted second-pass replay: ${command}`, { skip: !bash }, async t => {
  const f = await fixture(t)
  assert.equal(parseShellReadProgram(command).ok, true)
  const evidence = await f.validate(f.makeExec(command), f.run(command))
  assert.ok(evidence.length >= 1)
})

test('obsolete tail syntax does not admit unrelated flags or non-integer counts', () => {
  for (const command of ['tail -2f a.ts', 'tail -2c a.ts', 'tail -1.5 a.ts', 'tail -999999999999999999 a.ts']) {
    assert.equal(parseShellReadProgram(command).ok, false, command)
  }
})

for (const marker of ['--', '---', '-----']) test(`literal hyphen separator ${marker} is not an echo option`, { skip: !bash }, async t => {
  const f = await fixture(t), command = `cat a.ts; echo '${marker}'; cat b.ts`
  assert.equal(parseShellReadProgram(command).ok, true)
  assert.equal((await f.validate(f.makeExec(command), f.run(command))).length, 2)
})
test('echo options and implementation-dependent escapes remain rejected', () => {
  for (const marker of ['-n','-e','-E','-ne','--help','--version']) {
    assert.equal(parseShellReadProgram(`cat a.ts; echo '${marker}'; cat b.ts`).ok, false)
  }
})

test('fixed-fixture replay matrix: missing newline, empty/blank lines, Unicode, and CRLF', { skip: !bash }, async t => {
  const f = await fixture(t)
  const texts = ['', '\n', 'a', 'a\n', 'a\n\n', 'a\r\nb\r\n', 'hello; echo marker\n', '你好\n']
  const plans = ['cat a.ts; cat b.ts', "cat a.ts; echo '---'; cat b.ts", 'cat a.ts b.ts',
    'cat a.ts b.ts | head -n 1', 'cat a.ts b.ts | tail -n 1', "cat a.ts b.ts | sed -n '1,2p'"]
  for (const a of texts) for (const b of texts) {
    await writeFile(join(f.cwd, 'a.ts'), a); await writeFile(join(f.cwd, 'b.ts'), b)
    for (const command of plans) {
      const result = f.run(command), evidence = await f.validate(f.makeExec(command), result)
      const needsEvidence = a.length > 0 || b.length > 0
      assert.equal(evidence.length > 0, needsEvidence, JSON.stringify({ a,b,command }))
      for (const item of evidence) {
        const content = item.target.targetKey.endsWith('/a.ts') ? a : b
        assert.ok(content.length > 0, 'empty operand cannot borrow another file observation')
      }
    }
  }
})
