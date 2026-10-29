import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseShellReadProgram } from '../lib/transports/shell-read.js'
import { renderReadPlan } from '../lib/sources/shell-read-render.js'
import { observeCommand } from './search-test-helpers.js'

const commands=[
 "awk '{print}' f", "awk '{print $0}' f", "awk 'NR>=2 && NR<=4' f",
 "awk 'NR>=2 && NR<=4 {print}' f", "awk 'FNR==2 {print $0}' f", "awk 'NR==2,NR==4' f",
 "awk 'NR>1 && NR<5 {print NR\": \"$0}' f", "awk '{print NR, $0}' f",
 'awk \'NR>=2 && NR<=4 {printf "%d:%s\\n", NR, $0}\' f',
 'awk \'{printf "%6d\\t%s\\n", NR, $0}\' f',
 "awk -v start=2 -v end=4 'NR>=start && NR<=end { print $0 }' f",
 "awk '{if (NR>=2 && NR<=4) print $0}' f", "cat f | awk 'NR>=2 && NR<=4'",
 "awk 'NR>=2 && NR<=4' f | head -1",
]
commands.push(
  "awk '/b/' f", "awk '/^a/,/^c/' f", "awk '/^a/,0 {print}' f",
  "awk '/^b/,/^b/ {print}' f", "awk 'NR>=2 && /b/ {print $0}' f",
  "awk '/^}/ {print}' f", "awk '/end$/ {print NR\": \"$0}' f",
  "awk '/a/,/c/ {printf \"%d:%s\\n\", NR, $0}' f"
)
const contents=['a\nb\nc\nd\ne\n', '}\nbend\na\nb\nc\nb\n','a\n\nb\nc\nd','\n\n中文\n🧪\nlast','one','']
for(const command of commands)test(`awk fixed template: ${command}`,{skip:process.platform==='win32'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-awk-'))
 try{for(const content of contents){
  writeFileSync(join(dir,'f'),content)
  const parsed=parseShellReadProgram(command);assert.equal(parsed.ok,true)
  const run=spawnSync('bash',['--noprofile','--norc','-c',command],{cwd:dir,encoding:'utf8',timeout:5000})
  assert.equal(run.status,0,run.stderr)
  assert.equal(renderReadPlan(parsed.plan,content),run.stdout)
  const r=await observeCommand(dir,command,run.stdout)
  assert.equal(r.emissions.length,run.stdout===''?0:1,JSON.stringify(r.diagnostics))
 }}finally{rmSync(dir,{recursive:true,force:true})}
})
const bad=[
 "awk 'BEGIN{system(\"touch bad\")} {print}' f", "awk '{print > \"bad\"}' f", "awk '{getline;print}' f",
 "awk '{print $1}' f", "awk 'NR>=2 {gsub(/a/,\"x\");print}' f", "awk -f program.awk f",
 "awk -v ORS=x '{print}' f", "awk -F: '{print}' f", "awk '{printf \"%s\",$0}' f",
 "awk 'NR>=2' a b", "awk 'NR>=2' name=value", "awk 'NR>=2{print};END{print 1}' f",
 "awk 'NR>=2 || system(\"x\")' f", "awk -v start=2x 'NR>=start' f", "awk 'NR>0/0' f",
]
for(const command of bad)test(`reject executable/transforming awk: ${command}`,()=>assert.equal(parseShellReadProgram(command).ok,false))


test('multi-file cat with literal awk authorizes only contributing file',{skip:process.platform==='win32'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-awk-provenance-'))
 try{
  writeFileSync(join(dir,'a'),'alpha\n');writeFileSync(join(dir,'b'),'beta\n')
  const result=await observeCommand(dir,"cat a b | awk '/beta/'",'beta\n')
  assert.deepEqual(result.emissions.map(x=>x.target.displayPath),[join(dir,'b')])
 }finally{rmSync(dir,{recursive:true,force:true})}
})
