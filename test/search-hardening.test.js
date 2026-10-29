import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import test from 'node:test'
const posixTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'POSIX shell integration; PowerShell tests are separate' : false }, fn)
import { parseShellReadProgram } from '../lib/transports/shell-read.js'
import { observeCommand, fileContext } from './search-test-helpers.js'
import { registerBridge } from '../lib/bridge.js'
import { shellReadTransport } from '../lib/transports/shell-read.js'
import { shellReadSource } from '../lib/sources/shell-read.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-hardening-'))
  mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'src', '[id]'))
  for (const file of ['a.ts', 'b.ts', '[id]/page.ts']) writeFileSync(join(dir, 'src', file), `before\nexport const value = '${file}';\nafter\n`)
  return dir
}
const run = (dir, command) => spawnSync('bash', ['--noprofile','--norc','-c',command], {
  cwd: dir, encoding:'utf8', timeout:5000, maxBuffer:1024*1024,
  env:{PATH:process.env.PATH, LC_ALL:'C.UTF-8', RIPGREP_CONFIG_PATH:''},
})
for (const command of [
  "grep src/a.ts -n -e export", "grep -n -e export -- src/a.ts", "rg src/a.ts -n -e export",
  "grep -n export ./src/*.ts", "rg -Hn export ./src/'[id]'/*.ts", "rg -I -n export src/a.ts",
  "rg --vimgrep export src/", "cd ./src; grep -n export a.ts",
  "grep -n export src/a.ts; echo '---SERVICE---'; grep -n export src/b.ts",
  "grep -n export src/a.ts; grep -n export src/a.ts",
]) test(`second-pass differential: ${command}`, {skip:process.platform==='win32'}, async()=>{
  const dir=fixture(); try {
    const actual=run(dir,command);assert.equal(actual.status,0,actual.stderr);assert.equal(actual.stderr,'')
    const result=await observeCommand(dir,command,actual.stdout)
    assert.ok(result.emissions.length>0, JSON.stringify(result.diagnostics))
  } finally {rmSync(dir,{recursive:true,force:true})}
})

posixTest('metadata-only JSON and base64-only source are not visible source evidence', async()=>{
  const dir=fixture();try{
    const path={text:'src/a.ts'}
    for(const events of [
      [{type:'begin',data:{path}},{type:'end',data:{path}}],
      [{type:'match',data:{path, line_number:2, lines:{bytes:Buffer.from("export const value = 'a.ts';\n").toString('base64')}}}],
      [{type:'match',data:{path:{bytes:Buffer.from('src/a.ts').toString('base64')},line_number:2,lines:{text:"export const value = 'a.ts';\n"}}}],
    ]) assert.equal((await observeCommand(dir,'rg --json export src/',events.map(JSON.stringify).join('\n')+'\n')).emissions.length,0)
  }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('directory search needs provider containment; explicit single file does not',async()=>{
  const dir=fixture();try{
    const configure=ctx=>{delete ctx.fs.contains}
    assert.equal((await observeCommand(dir,'rg -n export src/',run(dir,'rg -n export src/').stdout,{configure})).emissions.length,0)
    assert.equal((await observeCommand(dir,'rg -n export src/a.ts',run(dir,'rg -n export src/a.ts').stdout,{configure})).emissions.length,1)
  }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('opaque target IDs work through provider contains, never by key prefix',async()=>{
  const dir=fixture();try{
    const command='grep -rn export src/',actual=run(dir,command)
    const result=await observeCommand(dir,command,actual.stdout,{configure(ctx){
      const base={...ctx.fs}, ids=new Map(), targets=new Map()
      ctx.fs.resolve=async(...args)=>{const t=await base.resolve(...args);if(!ids.has(t.targetKey)){
        const id=`opaque:${ids.size}`;ids.set(t.targetKey,id);targets.set(id,t)
      }return{...t,targetKey:ids.get(t.targetKey)}}
      ctx.fs.stat=(t,...args)=>base.stat(targets.get(t.targetKey),...args)
      ctx.fs.readText=(t,...args)=>base.readText(targets.get(t.targetKey),...args)
      ctx.fs.contains=(p,c)=>base.contains(targets.get(p.targetKey),targets.get(c.targetKey))
    }})
    assert.equal(result.emissions.length,3)
    assert.ok(result.emissions.every(e=>e.target.targetKey.startsWith('opaque:')))
  }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('ambiguous command segmentation cannot lend file a observation from b',async()=>{
  const dir=fixture();try{
    writeFileSync(join(dir,'src','a.ts'),'same\n');writeFileSync(join(dir,'src','b.ts'),'same\n')
    const r=await observeCommand(dir,"grep x src/a.ts; grep x src/b.ts",'same\n')
    assert.equal(r.emissions.length,0)
  }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('failed cd, hidden background result, search exit 1/2 and dirty stderr refuse observation',async()=>{
  const dir=fixture();try{
    const command='cd ./missing; grep -n export src/a.ts',actual=run(dir,command)
    assert.equal(actual.status,0);assert.notEqual(actual.stderr,'')
    assert.equal((await observeCommand(dir,command,actual.stdout,{value:{stderr:{text:actual.stderr,truncated:false}}})).emissions.length,0)
    for(const value of [{exitCode:1},{exitCode:2},{kind:'background'},{kind:'promoted'},{aborted:true},{timedOut:true},
      {signal:'SIGTERM'},{stopped:'user'},{stderr:{text:'error',truncated:false}}, {sandbox:{denied:true}}, {sandbox:{runnerFailed:true}},
      {stdout:{text:'2:x\n',truncated:false,spillPath:'/tmp/missing'}}]) {
      assert.equal((await observeCommand(dir,'grep -n export src/a.ts',run(dir,'grep -n export src/a.ts').stdout,{value})).emissions.length,0)
    }
  }finally{rmSync(dir,{recursive:true,force:true})}
})

posixTest('file/byte budgets and invalid control bytes fail closed',async()=>{
  const dir=fixture();try{
    const command='rg -n export src/',actual=run(dir,command)
    for(const limits of [{maxEvidenceFiles:1},{maxSourceBytes:8}]) assert.equal((await observeCommand(dir,command,actual.stdout,{limits})).emissions.length,0)
    for(const stdout of ['\x1b[31m'+actual.stdout,actual.stdout+'\0',actual.stdout.slice(0,-1)]) assert.equal((await observeCommand(dir,command,stdout)).emissions.length,0)
  }finally{rmSync(dir,{recursive:true,force:true})}
})

for(const command of ['rg -rn export src/', 'rg --recursive export src/', 'rg -G export src/',
  'rg --replace=x export src/', "grep -n export src/*.ts | awk '{print $1}'"]) {
  test(`flag meaning / transforming filter refused: ${command}`,()=>assert.equal(parseShellReadProgram(command).ok,false))
}

posixTest('hook pipeline skips PTC children and distinguishes parallel executions sharing callId',async()=>{
  const dir=fixture();try{
    const {ctx,emissions}=fileContext(dir),listeners=new Map()
    ctx.effect=()=>{};ctx.on=(name,fn)=>listeners.set(name,fn)
    registerBridge(ctx,[shellReadTransport()],[shellReadSource],{maxSourceBytes:8388608,maxEvidenceFiles:200})
    const post=listeners.get('tools/post-execute'),final=listeners.get('tools/result'), session={}
    const make=(file)=>{
      const command=`grep -n export src/${file}`,stdout=run(dir,command).stdout
      return {exec:{name:'bash',callId:'same',token:Symbol(file),agent:{session},signal:new AbortController().signal,arguments:{command}},
        result:{isError:false,value:{kind:'foreground',cwd:dir,exitCode:0,signal:null,stdout:{text:stdout,truncated:false},stderr:{text:'',truncated:false}},content:[{type:'text',text:stdout}]}}
    }
    const a=make('a.ts'),b=make('b.ts'),child=make('a.ts');child.exec.parent=Symbol('run_code')
    await Promise.all([a,b,child].map(({exec,result})=>post(exec,result,async()=>({kind:'accept'}))))
    final(child.exec,child.result);assert.equal(emissions.length,0)
    final(b.exec,b.result);final(a.exec,a.result)
    assert.deepEqual(emissions.map(e=>basename(e.target.displayPath)),['b.ts','a.ts'])
  }finally{rmSync(dir,{recursive:true,force:true})}
})


posixTest('filename-less glob or directory output cannot establish a unique file',async()=>{
  const dir=fixture();try{
    const c="rg -n export ./src/'[id]'/*.ts",actual=run(dir,c)
    assert.equal(actual.status,0)
    assert.equal((await observeCommand(dir,c,actual.stdout)).emissions.length,0)
    assert.equal((await observeCommand(dir,'rg -I -n export src/',run(dir,'rg -I -n export src/').stdout)).emissions.length,0)
  }finally{rmSync(dir,{recursive:true,force:true})}
})


for(const command of ["cat ~/file | grep x", "awk 'NR>0' ~/.config/file | rg x", "cat *.ts | grep x", "cat a[bc].ts | rg x"]) {
  test(`seed normalization preserves unquoted expansion rejection: ${command}`,()=>assert.equal(parseShellReadProgram(command).ok,false))
}
