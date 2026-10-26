# DSH FS Observation Bridge

English | [简体中文](README.zh.md)

Bridges external code-reading tools into [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)'s native file observation system, allowing agents to edit files without redundant `read` calls after inspecting source code.

## Table of Contents

- [Features](#features)
- [Design Philosophy](#design-philosophy)
- [Configuration](#configuration)
- [Installation](#installation)
- [Adding a Source](#adding-a-source)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Multiple Sources**: Built-in support for [CodeGraph CLI](https://github.com/colbymchenry/codegraph) and [CodeGraph MCP](https://github.com/CC19990113/dsh-plugin-codegraph).
- **Extensible Architecture**: Integrate additional code-reading tools and transports through adapters.
- **Read Verification**: Register file observations only from verified source-reading evidence.
- **Native Safety**: Preserve DSH's existing file version checks, concurrency safeguards, and editing behavior.

## Design Philosophy

**Bridge code readers to DSH's native file observation system rather than replacing its editing mechanisms.**

The plugin consists of three independent layers:

- **Transport**: Normalizes input from MCP, CLI, native DSH tools, and other transports.
- **Source**: Identifies tool-specific invocations and extracts source-code evidence.
- **Observation Core**: Validates reading evidence and registers observations through `fs/observed`.

Each layer is independently extensible. New code-reading tools can be integrated without modifying the core, and unverifiable reads do not grant editing authorization.

Concurrent tool calls are observed in completion order. If an older observation for the same file arrives last, a later edit fails closed with `FS_STALE_VERSION` rather than editing unseen content.

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
| `maxSourceBytes` | `8388608` (8 MiB) | Largest file read to verify a snippet; larger files are skipped (no authorization). |
| `maxEvidenceFiles` | `200` | Largest number of files validated from one tool result. |
| `disabledSources` | `[]` | Built-in source ids to disable, for example `[codegraph]`. An unknown id fails activation. |

## Installation

Install this package as a DSH bundle from the Plugin Manager (`plugin_manager`, action `install_bundle`, target: the absolute path of this package). The bundle declares `dsh.bundle.patch`, inserts one `fs-observation-bridge` row, and leaves the stock `fs-observation-policy` enabled.

## Adding a Source

Sources are built into the project rather than registered at runtime. Adding one
is a focused contribution:

1. Add `lib/sources/<tool>.js` exporting `{ id, accepts, extract, resolveRoot? }`.
2. `extract(invocation)` returns `[{ path, root?, snippets: [{ text, startLine?, endLine? }] }]`; snippets must be verbatim source that appeared in the tool output.
3. Register the source in `createSourceRegistry([...])` in `lib/index.js`.
4. Add parser and evidence tests; the bridge core and transports need no change.

A source that cannot provide verifiable snippets simply never authorizes an edit.

## Contributing

Issues and pull requests are welcome, especially contributions that add support for additional code-reading tools.

- **Source Adapters**: Integrate new code-reading tools such as Graphify or Serena.
- **Transport Adapters**: Support input mechanisms beyond MCP, CLI, and native DSH tools.
- **Testing & Improvements**: Improve compatibility, concurrency safety, and read verification.

All contributions should preserve DSH's native file observation and editing safety semantics.

## License

MIT.
