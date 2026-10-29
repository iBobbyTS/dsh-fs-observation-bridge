/**
 * Grep/ripgrep selection grammar. Patterns are never executed by the bridge.
 * Only complete source lines can become evidence; counts, replacements,
 * preprocessors and arbitrary shell/script operators are not readers.
 */
import { isAbsolute, resolve } from 'node:path'
import { isStandardProgram, lexShell } from './shell-command.js'
import { splitReadList, parseReadBlock, literalMarker } from './shell-read-program.js'

const fail = reason => ({ ok: false, reason })
const N = value => /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 1_000_000_000
const GREP_NAMES = ['grep', 'egrep', 'fgrep']

/** Return the actual command family; rg -r is replacement, NOT recursion. */
export function searchFamily(name) {
  if (GREP_NAMES.some(base => isStandardProgram(name, base))) return 'grep'
  if (isStandardProgram(name, 'rg')) return 'rg'
  return undefined
}

/** Parse option arity rather than looking for a flag character anywhere in argv. */
export function parseSearchStage(tokens, stdin = false) {
  const family = searchFamily(tokens[0]?.value)
  if (!family) return undefined
  const plan = { family, paths: [], numbered: false, filename: 'auto', heading: false,
    column: false, context: false, json: false, recursive: family === 'rg', stdin }
  let explicitPattern = false, options = true
  const positionals = []
  const argument = (name, value, token) => {
    if (value === undefined || value.includes('\0')) return false
    if (['e','regexp','f','file'].includes(name)) {
      if (token?.hasUnquotedGlob || value === '-' && ['f','file'].includes(name)) return false
      explicitPattern = true; return true
    }
    if (['A','B','C','after-context','before-context','context','m','max-count','j','threads','max-depth'].includes(name)) {
      if (!N(value)) return false
      if (['A','B','C','after-context','before-context','context'].includes(name)) plan.context ||= Number(value) > 0
      return true
    }
    if (['color','colour'].includes(name)) return ['never','auto'].includes(value)
    if (['encoding','E'].includes(name) && family === 'rg') return ['utf-8','utf8','auto'].includes(value.toLowerCase())
    if (name === 'binary-files') return ['without-match','text','binary'].includes(value)
    if (name === 'engine') return ['default','pcre2','auto'].includes(value)
    if (['d','directories'].includes(name)) {
      if (!['read','skip','recurse'].includes(value)) return false
      plan.recursive = value === 'recurse'; return true
    }
    // These only restrict a search. Identity still comes from the declared
    // root/file operands AND the real target, never from glob/type expansion.
    return ['include','exclude','exclude-dir','exclude-from','g','glob','iglob','t','type','T','type-not',
      'type-add','type-clear','ignore-file','max-filesize'].includes(name)
  }
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i], value = token.value
    if (value.includes('\0')) return undefined
    if (options && value === '--') { options = false; continue }
    if (options && value.startsWith('--')) {
      const eq = value.indexOf('=')
      const name = value.slice(2, eq < 0 ? undefined : eq)
      const bools = {
        'line-number': () => { plan.numbered = true }, 'no-line-number': () => { plan.numbered = false },
        'with-filename': () => { plan.filename = 'yes' }, 'no-filename': () => { plan.filename = 'no' },
        'recursive': () => { plan.recursive = true }, 'dereference-recursive': () => { plan.recursive = true },
        'heading': () => { plan.heading = true }, 'no-heading': () => { plan.heading = false },
        'column': () => { plan.column = true; plan.numbered = true }, 'no-column': () => { plan.column = false },
        'json': () => { plan.json = true },
        'vimgrep': () => { plan.filename = 'yes'; plan.numbered = true; plan.column = true },
      }
      if (bools[name]) {
        if (eq >= 0 || family === 'grep' && ['heading','no-heading','column','no-column','json','no-line-number','vimgrep'].includes(name)) return undefined
        if (family === 'rg' && ['recursive', 'dereference-recursive'].includes(name)) return undefined
        bools[name](); continue
      }
      const noArg = family === 'grep'
        ? ['ignore-case','no-ignore-case','invert-match','word-regexp','line-regexp','fixed-strings','extended-regexp','basic-regexp','perl-regexp','text','binary','line-buffered','no-messages']
        : ['ignore-case','case-sensitive','smart-case','invert-match','word-regexp','line-regexp','fixed-strings','pcre2','no-pcre2','auto-hybrid-regex','text','hidden','no-hidden',
          'glob-case-insensitive','ignore-file-case-insensitive','no-ignore','no-ignore-vcs','no-ignore-parent','no-ignore-global','no-ignore-dot','no-ignore-files','no-ignore-messages',
          'follow','no-follow','one-file-system','line-buffered','block-buffered','no-messages','no-config','crlf','no-crlf','no-unicode','unicode','no-mmap','mmap','no-require-git','require-git','no-heading']
      if (noArg.includes(name)) { if (eq >= 0) return undefined; continue }
      const arity = family === 'grep'
        ? ['regexp','file','after-context','before-context','context','max-count','include','exclude','exclude-dir','exclude-from','color','colour','binary-files','directories']
        : ['regexp','file','after-context','before-context','context','max-count','glob','iglob','type','type-not','type-add','type-clear','ignore-file','color','encoding','engine','max-depth','max-filesize','threads']
      if (!arity.includes(name)) return undefined
      const argToken = eq >= 0 ? { ...token, value: value.slice(eq + 1) } : tokens[++i]
      if (!argument(name, argToken?.value, argToken)) return undefined
      continue
    }
    if (options && value.startsWith('-') && value !== '-') {
      if (/^-\d+$/u.test(value)) { if (!N(value.slice(1))) return undefined; plan.context ||= Number(value.slice(1)) > 0; continue }
      for (let k = 1; k < value.length; k++) {
        const flag = value[k]
        if (flag === 'n') { plan.numbered = true; continue }
        if (flag === 'N' && family === 'rg') { plan.numbered = false; continue }
        if (flag === 'I' && family === 'rg') { plan.filename = 'no'; continue }
        if (flag === 'H') { plan.filename = 'yes'; continue }
        if (flag === 'h') { if (family !== 'grep') return undefined; plan.filename = 'no'; continue }
        if (family === 'grep' && 'rR'.includes(flag)) { plan.recursive = true; continue }
        if ((family === 'grep' ? 'ivwxFEGPaIsU' : 'iSsvwxFPaIuL').includes(flag)) continue
        const arity = family === 'grep' ? 'efABCmd' : 'efgtTABCmjE'
        if (!arity.includes(flag)) return undefined
        const attached = value.slice(k + 1)
        const argToken = attached ? { ...token, value: attached } : tokens[++i]
        if (!argument(flag, argToken?.value, argToken)) return undefined
        break
      }
      continue
    }
    positionals.push(token)
  }
  if (!explicitPattern) {
    const pattern = positionals.shift()
    if (!pattern || pattern.hasUnquotedGlob) return undefined
  }
  for (const token of positionals) {
    const value = token.value
    if (!value || value === '-' || value.startsWith('~') || /[{}\r\n]/u.test(value)) return undefined
    plan.paths.push({ value, glob: token.hasUnquotedGlob, quoted: token.quoted })
  }
  if (stdin) {
    if (plan.paths.length || plan.heading || plan.json || plan.filename !== 'auto' || plan.column || plan.numbered || plan.context) return undefined
    // stdin filters can select/drop complete records, not prepend/remove text.
  } else if (plan.paths.length === 0) {
    if (family !== 'rg' && !plan.recursive) return undefined
    plan.paths = [{ value: '.', glob: false }]
  }
  if (plan.paths.length > 200 || plan.heading && family !== 'rg') return undefined
  // No-filename across unknown/multiple scopes cannot establish identity.
  if (plan.filename === 'no' && (plan.paths.length !== 1 || plan.paths[0].glob)) return undefined
  return plan
}

/** A quote-aware stderr-only redirection remover. It does not execute a shell. */
export function stripSearchStderr(text) {
  let quote, out = '', suppressed = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      out += c
      if (c === quote) quote = undefined
      else if (quote === '"' && c === '\\' && '$`"\\'.includes(text[i + 1] ?? '')) out += text[++i]
      continue
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue }
    if (c === '\\') { out += c + (text[++i] ?? ''); continue }
    if (c === '2' && (i === 0 || /[ \t]/u.test(text[i - 1])) && text[i + 1] === '>') {
      const m = /^2>[ \t]*(?:\/dev\/null|'\/dev\/null'|"\/dev\/null")(?=[ \t|]|$)/u.exec(text.slice(i))
      if (!m) return fail('redirection_unsupported')
      out += ' '; i += m[0].length - 1; suppressed = true; continue
    }
    if (c === '<' || c === '>') return fail('redirection_unsupported')
    out += c
  }
  return { ok: true, text: out.trim(), suppressed }
}

const quoteWord = value => `'${value.replace(/'/gu, `'\\''`)}'`
const stageText = stages => stages.map(tokens => tokens.map(t => quoteWord(t.value)).join(' ')).join(' | ')

/** Program containing at least one grep/rg reader, mixed with replayable reads and literal markers. */
export function parseSearchProgram(command, parseSingle) {
  const list = splitReadList(command)
  if (!list.ok) return list
  const steps = []
  let searches = 0
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i], stripped = stripSearchStderr(item.text)
    if (!stripped.ok) return stripped
    const lexed = lexShell(stripped.text)
    if (!lexed.ok) return lexed
    const first = lexed.stages[0], name = first[0]?.value
    if (name === 'cd') {
      const args = first.slice(first[1]?.value === '--' ? 2 : 1)
      if (i || stripped.suppressed || lexed.stages.length !== 1 || !['&&', ';'].includes(item.after) || args.length !== 1
        || args[0].hasUnquotedGlob || !/^(?:\/|\.\/|\.\.\/|\.$|\.\.$)/u.test(args[0].value)) return fail('unsupported_cd')
      steps.push({ kind: 'cd', path: args[0].value }); continue
    }
    if (isStandardProgram(name, 'echo') || isStandardProgram(name, 'printf')) {
      const text = literalMarker(first)
      if (stripped.suppressed || lexed.stages.length !== 1 || text === undefined) return fail('unsupported_marker')
      steps.push({ kind: 'literal', text }); continue
    }
    let searchAt = lexed.stages.findIndex(tokens => searchFamily(tokens[0]?.value))
    if (searchAt >= 0) {
      let seed
      if (searchAt > 0) {
        const before = { stages: lexed.stages.slice(0, searchAt) }
        // Re-quoting tokens below must never hide a Bash expansion that was
        // active in the original command (e.g. cat ~/x | grep pattern).
        if (before.stages.some(words => words.some(token => token.hasUnquotedGlob))) return fail('unsupported_search_seed')
        seed = parseReadBlock(stageText(before.stages), before, parseSingle)
        if (!seed || seed.files.length !== 1) return fail('unsupported_search_seed')
      }
      const search = parseSearchStage(lexed.stages[searchAt], false)
      // For a seeded stdin query, unlike a filter we allow -n/-A/-B/-C; its
      // numbers refer to the replayed stream, not the original file.
      const seeded = seed && parseSeedSearch(lexed.stages[searchAt])
      const query = seed ? seeded : search
      if (!query) return fail('unsupported_search_options')
      const filters = []
      for (const tokens of lexed.stages.slice(searchAt + 1)) {
        if (parseSearchStage(tokens, true)) { filters.push({ kind: 'filter' }); continue }
        if (['sort','uniq'].some(program => isStandardProgram(tokens[0]?.value, program))
          && tokens.slice(1).every(t => ['-r','-u','-d'].includes(t.value))) {
          if (tokens[0].value.endsWith('uniq') && tokens.slice(1).some(t => t.value === '-r')) return fail('unsupported_filter')
          filters.push({ kind: 'filter' }); continue
        }
        if (tokens.some(token => token.hasUnquotedGlob)) return fail('unsupported_filter')
        const selector = parseSingle(`cat __bridge_input__ | ${stageText([tokens])}`)
        if (!selector.ok || selector.plan.stages.length !== 2
          || !['head','tail','sed','awk'].includes(selector.plan.stages[1].kind)
          || selector.plan.stages[1].kind === 'awk' && selector.plan.stages[1].format.kind !== 'plain') return fail('unsupported_filter')
        filters.push(selector.plan.stages[1])
      }
      if (filters.length > 4 || query.json && filters.some(s => s.kind !== 'head' && s.kind !== 'tail')) return fail('unsupported_filter')
      steps.push({ kind: 'search', query, seed, filters, after: item.after, suppressed: stripped.suppressed })
      searches++; continue
    }
    const read = parseReadBlock(stripped.text, lexed, parseSingle)
    if (!read) return fail('unsupported_statement')
    if (stripped.suppressed && (read.stages.length !== 1 || list.items.slice(i, -1).some(p => p.after !== '&&'))) return fail('masked_failure')
    steps.push({ kind: 'read', ...read })
  }
  const inputs = steps.reduce((n, step) => n + (step.files?.length ?? 0) + (step.query?.paths.length ?? 0) + (step.seed?.files.length ?? 0), 0)
  if (inputs > 200) return fail('program_limit')
  return searches ? { ok: true, plan: { dialect: 'bash', kind: 'search-program', steps } } : fail('no_search_read')
}

function parseSeedSearch(tokens) {
  // A synthetic path disambiguates the optional regexp without evaluating it.
  const p = parseSearchStage([...tokens, { value: '__bridge_stdin__', quoted: [], hasUnquotedGlob: false }])
  if (!p || p.paths.length !== 1 || p.paths[0].value !== '__bridge_stdin__' || p.filename === 'yes' || p.heading || p.json) return undefined
  return { ...p, paths: [], stdin: true, filename: 'no' }
}

/** Resolve only known literal cwd effects; directory/glob membership is verified later. */
export function resolveSearchProgram(plan, cwd) {
  if (!isAbsolute(cwd)) return undefined
  let directory = cwd
  const absolute = p => isAbsolute(p) ? p : `${directory.endsWith('/') ? directory : directory + '/'}${p}`
  const steps = plan.steps.map(step => {
    if (step.kind === 'cd') { directory = resolve(directory, step.path); return { ...step, path: directory } }
    if (step.kind === 'read') return { ...step, files: step.files.map(absolute) }
    if (step.kind === 'search') return { ...step, cwd: directory,
      query: { ...step.query, paths: step.query.paths.map(p => ({ ...p, absolute: absolute(p.value) })) },
      ...step.seed ? { seed: { ...step.seed, files: step.seed.files.map(absolute) } } : {} }
    return step
  })
  return { ...plan, steps, effectiveCwd: directory }
}
