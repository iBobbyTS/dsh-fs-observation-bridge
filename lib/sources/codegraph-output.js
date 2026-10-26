/**
 * CodeGraph output parsing.
 *
 * The parser returns source evidence, not bare paths: each file carries the
 * verbatim snippets that were shown to the model. The observation core later
 * checks those snippets against the current file, so a tool that merely names
 * a file or a symbol cannot authorize a mutation.
 *
 * Recognized shapes:
 * - `explore` / MCP `codegraph_explore`: `**`path`**` heading + fenced,
 *   line-numbered source.
 * - `node <symbol>`: `**Location:** path:line` + fenced source.
 * - `node <file>`: `**path** — N lines, ...` + line-numbered body without a fence.
 * - `context`: `#### symbol (path:line)` + fenced source.
 *
 * A fence without a closing fence is truncated and contributes no evidence.
 * @module dsh-fs-observation-bridge/sources/codegraph-output
 */

/** `**`path`** — symbols` heading from `explore`. */
const SOURCE_HEADING = /^\*\*`([^`]+)`\*\*/u

/** `**Location:** path:line` heading from `node <symbol>`. */
const LOCATION_HEADING = /^\*\*Location:\*\*\s+(.+?)(?::(\d+))?\s*$/u

/** `#### symbol (path:line)` heading from `context`. */
const CONTEXT_HEADING = /^####\s+.+?\((.+?):(\d+)\)\s*$/u

/** `**path** — N lines, ...` heading from `node <file>`. */
const FILE_MODE_HEADING = /^\*\*([^*`\n]+?)\*\* — \d+ lines(?:, \d+ symbols)?/u

/** One line-numbered source line (`1	<source>`). */
const NUMBERED_LINE = /^(\d+)\t(.*)$/u

/**
 * Extract source evidence from one CodeGraph answer.
 * @param {string} text - the tool result text.
 * @returns {Array<{ path: string, snippets: Array<{ text: string, startLine?: number, endLine?: number }> }>}
 *   one entry per file that had a complete source block.
 */
export function parseCodegraphEvidence(text) {
  if (typeof text !== 'string' || text === '') return []
  const lines = text.split(/\r?\n/u)
  const byPath = new Map()
  let i = 0
  while (i < lines.length) {
    const fileHeading = FILE_MODE_HEADING.exec(lines[i])
    const bodyStart = fileHeading === null ? -1 : nextNonBlank(lines, i + 1)
    if (fileHeading !== null && bodyStart !== -1 && NUMBERED_LINE.test(lines[bodyStart])) {
      const body = readNumberedBody(lines, bodyStart)
      if (body !== undefined) {
        addEvidence(byPath, fileHeading[1].trim(), body.snippet)
        i = body.next
        continue
      }
    }
    if (lines[i].startsWith('```')) {
      const heading = headingAbove(lines, i)
      const close = closingFence(lines, i + 1)
      if (heading !== undefined && close !== -1) {
        const snippet = snippetFromBody(lines.slice(i + 1, close), heading.line)
        if (snippet !== undefined) addEvidence(byPath, heading.path, snippet)
        i = close + 1
        continue
      }
      // A missing closing fence means truncated output: skip the rest.
      if (close === -1) break
      i = close + 1
      continue
    }
    i++
  }
  return [...byPath.values()]
}

/**
 * Read the `-p` / `--path` value from a CodeGraph argv.
 * @param {unknown} tokens - tokens after the program name.
 * @returns {string | undefined} the declared project path.
 */
export function codegraphProjectPath(tokens) {
  if (!Array.isArray(tokens)) return undefined
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-p' || token === '--path') {
      const value = tokens[i + 1]
      return typeof value === 'string' && value !== '' && !value.startsWith('-') ? value : undefined
    }
    if (typeof token === 'string' && token.startsWith('--path=')) {
      const value = token.slice('--path='.length)
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/**
 * Find the heading that introduces the fenced block opening at `index`.
 * @param {string[]} lines - output lines.
 * @param {number} index - opening fence index.
 * @returns {{ path: string, line?: number } | undefined} the heading.
 */
function headingAbove(lines, index) {
  const floor = Math.max(0, index - 8)
  for (let i = index - 1; i >= floor; i--) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (line.startsWith('```')) return undefined
    const source = SOURCE_HEADING.exec(line)
    if (source !== null) return { path: source[1].trim() }
    const location = LOCATION_HEADING.exec(line)
    if (location !== null) {
      return { path: location[1].trim(), ...(location[2] === undefined ? {} : { line: Number(location[2]) }) }
    }
    const context = CONTEXT_HEADING.exec(line)
    if (context !== null) return { path: context[1].trim(), line: Number(context[2]) }
  }
  return undefined
}

/**
 * Index of the closing fence at or after `from`, or -1.
 * @param {string[]} lines - output lines.
 * @param {number} from - first body line.
 * @returns {number} the closing fence index.
 */
function closingFence(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].startsWith('```')) return i
  }
  return -1
}

/**
 * Build one snippet from a fenced body. Line-numbered bodies keep their exact
 * line range; unnumbered bodies fall back to the heading's line as the start.
 * @param {string[]} body - lines between the fences.
 * @param {number | undefined} headingLine - line named by the heading.
 * @returns {{ text: string, startLine?: number, endLine?: number } | undefined} the snippet.
 */
function snippetFromBody(body, headingLine) {
  const trimmed = trimTrailingBlank(body)
  if (trimmed.length === 0) return undefined
  const parts = []
  let numbered = true
  let start
  let end
  for (const line of trimmed) {
    if (line === '') {
      parts.push('')
      continue
    }
    const match = NUMBERED_LINE.exec(line)
    if (match === null) {
      numbered = false
      break
    }
    const lineNumber = Number(match[1])
    if (start === undefined) start = lineNumber
    end = lineNumber
    parts.push(match[2])
  }
  if (numbered && start !== undefined && end !== undefined) {
    return { text: parts.join('\n'), startLine: start, endLine: end }
  }
  const text = trimmed.join('\n')
  if (text.trim() === '') return undefined
  return {
    text,
    ...(headingLine === undefined ? {} : { startLine: headingLine, endLine: headingLine + trimmed.length - 1 }),
  }
}

/**
 * Read a file-mode numbered body.
 * @param {string[]} lines - output lines.
 * @param {number} from - first body line.
 * @returns {{ snippet: { text: string, startLine: number, endLine: number }, next: number } | undefined}
 *   the snippet and the index after it.
 */
function readNumberedBody(lines, from) {
  const parts = []
  let start
  let end
  let i = from
  for (; i < lines.length; i++) {
    const match = NUMBERED_LINE.exec(lines[i])
    if (match === null) break
    const lineNumber = Number(match[1])
    if (start === undefined) start = lineNumber
    end = lineNumber
    parts.push(match[2])
  }
  if (parts.length === 0 || start === undefined || end === undefined) return undefined
  return { snippet: { text: parts.join('\n'), startLine: start, endLine: end }, next: i }
}

/**
 * Index of the first non-blank line at or after `from`, or -1.
 * @param {string[]} lines - output lines.
 * @param {number} from - first candidate index.
 * @returns {number} the index, or -1 when only blanks remain.
 */
function nextNonBlank(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== '') return i
  }
  return -1
}

/**
 * Remove trailing empty lines without touching interior ones.
 * @param {string[]} lines - body lines.
 * @returns {string[]} the trimmed body.
 */
function trimTrailingBlank(lines) {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  return lines.slice(0, end)
}

/**
 * Add one snippet to its file entry.
 * @param {Map<string, object>} byPath - evidence by path.
 * @param {string} path - the file path.
 * @param {{ text: string, startLine?: number, endLine?: number }} snippet - source evidence.
 * @returns {void}
 */
function addEvidence(byPath, path, snippet) {
  if (path === '' || snippet === undefined) return
  let entry = byPath.get(path)
  if (entry === undefined) {
    entry = { path, snippets: [] }
    byPath.set(path, entry)
  }
  entry.snippets.push(snippet)
}
