import { realpath, stat, readFile } from 'node:fs/promises'
import { resolve, isAbsolute, relative } from 'node:path'
import { TextDecoder } from 'node:util'
import { shellReadTransport } from '../lib/transports/shell-read.js'
import { shellReadSource } from '../lib/sources/shell-read.js'
import { validateEvidence } from '../lib/observation/evidence.js'
import { clearPending, stash, flush } from '../lib/observation/emit.js'

/** A small fs seam for differential tests, not a claim of native DSH integration. */
export function fileContext(cwd) {
  const diagnostics = [], emissions = []
  const ctx = {
    get: name => name === 'workingDirectory' ? { ensure: async () => cwd } : undefined,
    logger: { debug: (...args) => diagnostics.push(args) },
    emit: (event,target,observation,exec) => emissions.push({ event,target,observation,exec }),
    fs: {
      async resolve(path) {
        let key = isAbsolute(path) ? path : `${cwd}/${path}`
        try { key = await realpath(key) } catch {}
        return { targetKey: key, displayPath: resolve(cwd, path) }
      },
      contains(parent, child) {
        const r = relative(parent.targetKey, child.targetKey)
        return r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\')
      },
      async stat(target) {
        try {
          const s = await stat(target.targetKey, { bigint: true })
          return {type:s.isFile()?'file':s.isDirectory()?'directory':'other',size:Number(s.size),version:`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`}
        } catch { return undefined }
      },
      async readText(target) {
        const b = await readFile(target.targetKey)
        if (b.subarray(0,8192).includes(0)) throw new Error('binary')
        return new TextDecoder('utf-8', { fatal:true }).decode(b)
      },
    },
  }
  return {ctx,diagnostics,emissions}
}

export async function observeCommand(cwd, command, stdout, options = {}) {
  const {ctx, diagnostics, emissions} = fileContext(cwd)
  options.configure?.(ctx)
  const controller = new AbortController()
  const exec = { name:'bash', callId:'test', token:Symbol('test'), arguments:{command}, agent:{session:{}}, signal:controller.signal }
  const result = {isError:false,value:{kind:'foreground',cwd,exitCode:0,signal:null,timedOut:false,aborted:false,
    stdout:{text:stdout,truncated:false},stderr:{text:'',truncated:false},...options.value},content:[{type:'text',text:options.final ?? (stdout || '(no output)')}]}
  const transport = shellReadTransport()
  const invocation = await transport.normalize(ctx,exec,result)
  if (!invocation) return {validated:[],emissions,diagnostics,invocation}
  const validated = await validateEvidence(ctx,invocation,shellReadSource.extract(invocation),exec.signal,options.limits)
  clearPending();stash(exec,validated)
  if (options.cancel) controller.abort()
  flush(ctx,exec,result)
  return {validated,emissions,diagnostics,invocation}
}
