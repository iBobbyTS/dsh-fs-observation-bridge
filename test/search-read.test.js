import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,basename } from 'node:path'
import test from 'node:test'
const posixTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'POSIX shell integration; PowerShell tests are separate' : false }, fn)
import { parseShellReadProgram } from '../lib/transports/shell-read.js'
import { cliTransport } from '../lib/transports/cli.js'
import { observeCommand } from './search-test-helpers.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'bridge-search-'))
  mkdirSync(join(dir,'src'));mkdirSync(join(dir,'src','[id]'))
  writeFileSync(join(dir,'src','a.ts'), 'before\nexport const alpha = 1;\n\nbetween\nexport const beta = 2;\nafter\n')
  writeFileSync(join(dir,'src','b.ts'), 'start\nexport const gamma = 3;\nend\n')
  writeFileSync(join(dir,'src','[id]','page.ts'), 'export const special = true;\n')
  return dir
}
const actual = (dir, command) => spawnSync('bash',['--noprofile','--norc','-c',command],{
  cwd:dir,encoding:'utf8',timeout:5000,maxBuffer:1024*1024,
  env:{PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',RIPGREP_CONFIG_PATH:''},
})
const commands = [
  "grep -n 'export' src/a.ts", "grep 'export' src/a.ts", "grep -Hn 'export' src/a.ts",
  "grep -hn 'export' src/a.ts", "grep -nE 'alpha|beta' src/a.ts", "grep -nF 'const alpha' src/a.ts",
  "grep -inv 'export' src/a.ts", "grep -n -e alpha -e beta src/a.ts",
  "grep -n -A1 -B1 alpha src/a.ts", "grep -n -C1 export src/a.ts",
  "grep -n export src/a.ts src/b.ts", "grep -rn export src/ --include='*.ts'",
  "grep -r export src/", "grep -n export src/*.ts", "grep -n export 'src/[id]/page.ts'",
  "grep -rn export src/ 2>/dev/null | head -n 2",
  "grep -rn export src/ | grep -v gamma | head -n 2",
  "grep -rn export src/ | tail -n 2", "grep -rn export src/ | sed -n '1,2p'",
  "grep -rn export src/ | sort -r | head -n 2",
  "grep -rn export src/ | awk 'NR>=1 && NR<=2'",
  "rg -n export src/", "rg export src/a.ts", "rg -n -C1 export src/", "rg --column -n -C1 export src/a.ts",
  "rg -n --heading export src/", "rg --heading export src/", "rg --json export src/", "rg --json -C1 export src/",
  "rg --json export src/ | head -n 2", "rg -n --no-heading -g '*.ts' export src/",
  "rg --no-config -P -n 'const\\s+alpha' src/a.ts", "rg -n -e alpha -e gamma src/",
  "rg -n -F 'export const' src/a.ts src/b.ts", "rg -n export src/*.ts",
  "cat src/a.ts | grep -n export", "sed -n '2,5p' src/a.ts | grep -n export",
  "grep -n alpha src/a.ts; echo '===B==='; cat src/b.ts",
  "cat src/b.ts; printf '%s\\n' '===A==='; grep -n alpha src/a.ts",
  "grep -Hn alpha src/a.ts; grep -Hn gamma src/b.ts",
  "cd ./src && grep -n alpha a.ts; echo '===B==='; cat b.ts",
  "grep -n absent src/a.ts; echo '===B==='; cat src/b.ts",
]
for (const command of commands) test(`search real stdout: ${command}`, {skip:process.platform==='win32'}, async () => {
  const dir=fixture()
  try {
    const run=actual(dir,command)
    assert.equal(run.error,undefined);assert.equal(run.status,0,run.stderr);assert.equal(run.stderr,'')
    assert.equal(parseShellReadProgram(command).ok,true,'syntax')
    const result=await observeCommand(dir,command,run.stdout)
    assert.ok(result.emissions.length>0,JSON.stringify(result.diagnostics))
    assert.equal(cliTransport().match({name:'bash',arguments:{command}}),false,'single transport owner')
  } finally {rmSync(dir,{recursive:true,force:true})}
})

const rejected = [
 "grep -l foo src/a.ts","grep -c foo src/a.ts","grep -o foo src/a.ts","grep -q foo src/a.ts",
 "grep --only-matching foo src/a.ts","grep --count foo src/a.ts","rg --files src/","rg -l foo src/",
 "rg --pre cat foo src/","rg --pre-glob '*.ts' foo src/","rg --replace x foo src/","rg -r x foo src/",
 "rg -rn foo src/", "rg --trim foo src/","rg -z foo src/","rg --multiline foo src/",
 "grep --label=src/a.ts -Hn foo src/a.ts","rg --path-separator x foo src/","rg --color=always foo src/",
 "grep -n foo src/a.ts > out","grep -n foo src/a.ts 2>&1","grep -n foo src/a.ts | tee out",
 "ssh host grep -n foo src/a.ts","grep -n foo $(pwd)/a.ts","grep -n foo $FILE","grep -n foo src/a.ts & wait",
 "grep -n foo src/a.ts; touch changed", "grep -n foo src/a.ts || cat src/b.ts",
 "python -c 'print(1)' | grep -n foo", "rg -n foo src/ | cut -c1-5", "rg -n foo src/ | grep -o foo",
 "grep -hn foo src/a.ts src/b.ts", "grep -n foo -", "rg -n -f - src/",
]
for(const command of rejected)test(`reject unsupported search: ${command}`,()=>assert.equal(parseShellReadProgram(command).ok,false))

posixTest('search observes only files actually shown after head',async()=>{
 const dir=fixture();try {
  const command='grep -n export src/a.ts src/b.ts | head -1',run=actual(dir,command)
  const r=await observeCommand(dir,command,run.stdout)
  assert.deepEqual(r.emissions.map(x=>basename(x.target.targetKey)),['a.ts'])
 }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('wrong line, wrong content, outside root, changed final and truncation authorize nothing',async()=>{
 const dir=fixture();try{
  const c='grep -rn export src/',run=actual(dir,c)
  for(const stdout of ['src/a.ts:99:export const alpha = 1;\n','src/a.ts:2:changed\n','../outside.ts:2:export const alpha = 1;\n']) {
   assert.equal((await observeCommand(dir,c,stdout)).emissions.length,0)
  }
  assert.equal((await observeCommand(dir,c,run.stdout,{final:'prefix\n'+run.stdout})).emissions.length,0)
  assert.equal((await observeCommand(dir,c,run.stdout,{final:run.stdout.slice(0,-4)})).emissions.length,0)
  assert.equal((await observeCommand(dir,c,run.stdout,{value:{stdout:{text:run.stdout,truncated:true}}})).emissions.length,0)
  assert.equal((await observeCommand(dir,c,run.stdout,{cancel:true})).emissions.length,0)
  assert.equal((await observeCommand(dir,c,'')).emissions.length,0)
 }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('recursive scope rejects symlink escape; explicit symlink file is allowed',async()=>{
 const dir=fixture(),outside=mkdtempSync(join(tmpdir(),'bridge-outside-'))
 try{
  writeFileSync(join(outside,'outside.ts'),'export const escaped = 1;\n');symlinkSync(join(outside,'outside.ts'),join(dir,'src','link.ts'))
  assert.equal((await observeCommand(dir,'grep -Rn export src/','src/link.ts:1:export const escaped = 1;\n')).emissions.length,0)
  const r=await observeCommand(dir,'grep -n export src/link.ts','1:export const escaped = 1;\n')
  assert.equal(r.emissions.length,1)
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
})

posixTest('opaque versions checked after verification and across all snapshots',async()=>{
 const dir=fixture();try{
  const command='grep -n export src/a.ts src/b.ts',run=actual(dir,command)
  let reads=0
  const r=await observeCommand(dir,command,run.stdout,{configure(ctx){
    const original=ctx.fs.readText
    ctx.fs.readText=async target=>{const text=await original(target);if(++reads===2)writeFileSync(join(dir,'src','a.ts'),'mutated\n');return text}
  }})
  assert.equal(r.emissions.length,0)
 }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('ambiguous filename prefix refuses both candidates',async()=>{
 const dir=fixture();try{
  writeFileSync(join(dir,'src','name'),'1:export const shared = 1;\n')
  writeFileSync(join(dir,'src','name:1'),'export const shared = 1;\n')
  assert.equal((await observeCommand(dir,'grep -r export src/','src/name:1:export const shared = 1;\n')).emissions.length,0)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
