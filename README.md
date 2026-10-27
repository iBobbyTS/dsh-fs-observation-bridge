# DSH FS Observation Bridge

English | [简体中文](README.zh.md)

Bridges external code-reading tools into [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)'s native file observation system, allowing agents to edit files without redundant `read` calls after inspecting source code.

## Table of Contents

- [Features](#features)
- [Design Philosophy](#design-philosophy)
- [Supported Shell Reads](#supported-shell-reads)
- [Configuration](#configuration)
- [Installation](#installation)
- [Adding a Source](#adding-a-source)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Multiple Sources**: Built-in support for [CodeGraph CLI](https://github.com/colbymchenry/codegraph), [CodeGraph MCP](https://github.com/CC19990113/dsh-plugin-codegraph), a conservative Bash shell-read grammar, and a conservative PowerShell shell-read grammar for Windows `pwsh`.
- **Extensible Architecture**: Integrate additional code-reading tools and transports through adapters.
- **Read Verification**: Register file observations only from verified, model-visible source-reading evidence.
- **Native Safety**: Preserve DSH's existing file version checks, concurrency safeguards, and editing behavior.

## Design Philosophy

**Bridge code readers to DSH's native file observation system rather than replacing its editing mechanisms.**

The plugin consists of three independent layers:

- **Transport**: Normalizes input from MCP, CLI, shell-read, native DSH tools, and other transports.
- **Source**: Identifies tool-specific invocations and extracts or replays source-code evidence.
- **Observation Core**: Validates reading evidence and registers observations through `fs/observed`.

Each layer is independently extensible. New code-reading tools can be integrated without modifying the core, and unverifiable reads do not grant editing authorization.

Concurrent tool calls are observed in completion order. If an older observation for the same file arrives last, a later edit fails closed with `FS_STALE_VERSION` rather than editing unseen content.

`fs/observed` is a **whole-file, versioned observation**, exactly like DSH's native `read offset/limit`: a trusted partial view authorizes a later full-file edit while the version is unchanged. This bridge does not add a coverage policy; it only feeds the stock policy trusted observations.

## Supported Shell Reads

The `shell-read` transport claims two small, deterministic grammars: Bash on POSIX hosts and PowerShell on Windows hosts (`pwsh`). It is mutually exclusive with the CodeGraph `cli` transport: a command is normalized by exactly one of them.

### Default (P0)

| Form | Example | Replay rule |
| --- | --- | --- |
| `cat file` / `cat -- file` | `cat src/app.ts` | Exact full-file comparison |
| `head file` / `head -n N file` / `head -N file` | `head -n 80 src/app.ts` | First N lines (default 10) |
| `tail file` / `tail -n N file` | `tail -n 50 src/app.ts` | Last N lines (default 10) |
| `tail -n +N file` | `tail -n +522 README.md` | From line N to EOF |
| `sed -n 'Np' file` | `sed -n '42p' src/app.ts` | One line |
| `sed -n 'N,Mp' file` | `sed -n '40,120p' src/app.ts` | Inclusive range |
| `sed -n 'N,$p' file` | `sed -n '40,$p' src/app.ts` | From line N to EOF |

### Line numbers and pipelines (P1)

A pipeline is one reader (`cat` without numbering, `nl -ba`, or `sed`) followed by **up to two** stages chosen from `head`, `tail`, `sed`, and `nl`. `nl` may appear at most once, and four or more stages are rejected.

| Form | Example |
| --- | --- |
| `cat -n file` / `cat -b file` | Number all lines / non-blank lines |
| `nl -ba file` | Number all lines |
| `cat file \| head -n N` | `cat app.ts \| head -n 80` |
| `cat file \| tail -n N` | `cat app.ts \| tail -n 80` |
| `cat file \| sed -n 'N,Mp'` | `cat app.ts \| sed -n '20,80p'` |
| `cat file \| nl -ba` | Number the whole file |
| `cat file \| head -n N \| tail -n M` | Select a window from a prefix |
| `cat file \| sed -n 'N,Mp' \| nl -ba` | Select first, then number from 1 |
| `cat file \| nl -ba \| sed -n 'N,Mp'` | Number first, then select |
| `nl -ba file \| sed -n 'N,Mp'` | Number first, then select |
| `sed -n 'N,Mp' file \| nl -ba` | Select first, then number from 1 |

### PowerShell reads (Windows, W0/W1)

Only a normal foreground `pwsh` call with a session owner is observed. Persistent PowerShell, background jobs, promoted/timeout calls, and PTC-nested calls are never observed.

| Form | Example | Replay rule |
| --- | --- | --- |
| `Get-Content file`, `gc`/`cat`/`type` alias | `Get-Content .\src\app.ts` | every line object, exactly |
| `Get-Content file -Raw` | `Get-Content .\app.ts -Raw` | the whole file string plus the host's final newline |
| `Get-Content file -TotalCount N` / `-Head N` | `Get-Content .\app.ts -TotalCount 120` | first N line objects |
| `Get-Content file -Tail N` | `Get-Content .\app.ts -Tail 50` | last N line objects |
| `Get-Content file \| Select-Object -First N` | `... \| Select-Object -First 100` | first N line objects |
| `Get-Content file \| Select-Object -Last N` | `... \| Select-Object -Last 50` | last N line objects |
| `Get-Content file \| Select-Object -Skip N -First M` | `... \| Select-Object -Skip 200 -First 100` | line objects N+1 through N+M |
| `Get-Content file \| Select-Object -Index I` | `... \| Select-Object -Index 42` | one line object, 0-based |

PowerShell is not Bash and is parsed by its own strict grammar:

- Only `Get-Content` (or its stock aliases `gc`, `cat`, `type`) with one literal file, plus at most one `Select-Object` stage, is accepted.
- `-LiteralPath` keeps `[id]` and similar characters literal. Positional binding and `-Path` keep PowerShell wildcard semantics, so `*`, `?`, `[`, and `]` are rejected there even when quoted.
- Rejected: provider paths (`Env:`, `HKLM:`), drive-relative paths (`C:file`), NTFS alternate data streams (`file:stream`), device namespaces (`\\?\`, `\\.\`), `~`, variables and subexpressions, arrays and commas, splatting, script blocks, redirection, `;`/`&&`, comments, backtick escapes, newlines, and parameter abbreviations.
- Rejected options: `-Encoding`, `-Stream`, `-Wait`, `-AsByteStream`, `-Delimiter`, `-ReadCount`, `-Filter`, `-Include`, `-Exclude`, `-Force`, and any unknown parameter. `-Raw` cannot be combined with `-TotalCount`/`-Tail` or a pipeline; `Select-Object` accepts only `-First`, `-Last`, `-Skip` (with `-First`), and `-Index`, and rejects `-Property`, `-ExpandProperty`, and `-Unique`.

### Why PowerShell stdout is replayed, not compared as bytes

`Get-Content` emits one string object per line (terminators consumed) and the console host writes each formatted object followed by its own newline; `-Raw` emits one string and the host appends one more newline. The bridge therefore rebuilds the expected stdout from DSH's own `ctx.fs.readText` and compares it with the structured `stdout.text`, normalizing only CRLF/LF. Line bodies, blank lines, tabs, trailing spaces, and a missing final newline are compared exactly. A Windows PowerShell 5.1 read that decodes a UTF-8 file through the legacy ANSI code page produces different text and therefore fails closed; an empty file is observable only for a complete `Get-Content`/`-Raw` read.

### Authorization conditions

A shell-read observation is emitted only when **all** of these hold:

1. The call is a normal **foreground** `bash` or `pwsh` call with a session owner. Persistent-shell, background, promoted, `job_output`, and PTC-nested calls are not supported.
2. `exitCode === 0`, no signal/timeout/abort/stop, no sandbox denial or runner failure, stderr is empty, and neither stdout nor stderr is truncated; a spill file is not accepted as model-visible content.
3. The command is exactly one of the forms above: one literal target file, no shell operators other than the listed `|`, no redirection, variable/command substitution, glob, brace expansion, or unquoted tilde. Quoted glob characters such as `'[id]/+page.svelte'` are literal filenames and are allowed for Bash; PowerShell follows the dialect rules above.
4. For Bash, the effective working directory comes from the call's `workdir` (or the session directory) and matches the Bash result's `cwd`. For PowerShell it is the result's own `cwd`, because that is the directory the process actually ran in. The path always resolves through `ctx.fs`.
5. The target is a regular text file within `maxSourceBytes`; `before = stat`, `readText`, `after = stat` must report the same opaque version.
6. Replaying the parsed plan over the current file must equal the structured stdout **exactly**, after CRLF→LF normalization only. No trimming, whitespace compression, or free-form snippet inclusion.
7. The result is visible in the final frozen tool result: the complete expected stdout must still be present. A later listener that rewrites or truncates it prevents the observation.
8. Empty output is accepted only for a complete `cat` or complete `Get-Content`/`-Raw` read of an empty file.

Rejected examples include `cat f1 f2`, `cat -`, `cat -A`, `head -c`, `tail -f`, complex or `-i` sed, `npx cat`, `ssh host cat f`, `docker exec ... cat f`, `git show HEAD:f`, `rg --files`, arbitrary Python/Node/awk scripts, redirections, command lists, and more than two pipeline selectors for Bash; and `Get-Content -Wait`, `Get-Content -AsByteStream`, `Get-Content -Raw | Select-Object ...`, `Select-String`, `rg`, `cmd /c type`, path arrays, provider paths, and dynamic paths for PowerShell. These are deliberately outside the low-complexity trusted whitelist.

## Configuration

Set fields under the plugin row's `config` in the profile patch:

```yaml
- id: fs-observation-bridge
  name: 'dsh-fs-observation-bridge'
  config:
    maxSourceBytes: 8388608
    maxEvidenceFiles: 200
    disabledSources: []
```

| Field | Default | Meaning |
| --- | --- | --- |
| `maxSourceBytes` | `8388608` (8 MiB) | Largest file read to verify evidence; larger files are skipped (no authorization). |
| `maxEvidenceFiles` | `200` | Largest number of files validated from one tool result. |
| `disabledSources` | `[]` | Built-in source ids to disable, for example `[codegraph]`, `[shell-read]`, or `[powershell-read]`. An unknown id fails activation. |

## Installation

Install this package as a DSH bundle from the Plugin Manager (`plugin_manager`, action `install_bundle`, target: the absolute path of this package). The bundle declares `dsh.bundle.patch`, inserts one `fs-observation-bridge` row, and leaves the stock `fs-observation-policy` enabled.

## Adding a Source

Sources are built into the project rather than registered at runtime. Adding one
is a focused contribution:

1. Add `lib/sources/<tool>.js` exporting `{ id, accepts, extract, resolveRoot? }`.
2. `extract(invocation)` returns an evidence array. Snippet-based items are `{ path, root?, snippets: [{ text, startLine?, endLine? }] }`; exact-output items are `{ path, expectedStdout, verify(content), stable, permitEmpty }`. `verify` must replay the source's visible output from current file content.
3. Register the source in `createSourceRegistry([...])` in `lib/index.js`.
4. Add parser and evidence tests; the bridge core and transports need no change for a new source of an existing transport.

A source that cannot provide verifiable output simply never authorizes an edit.

## Contributing

Issues and pull requests are welcome, especially contributions that add support for additional code-reading tools.

- **Source Adapters**: Integrate new code-reading tools such as Graphify or Serena.
- **Transport Adapters**: Support input mechanisms beyond MCP, CLI, shell-read, and native DSH tools.
- **Testing & Improvements**: Improve compatibility, concurrency safety, and read verification.

All contributions should preserve DSH's native file observation and editing safety semantics.

## License

MIT.
