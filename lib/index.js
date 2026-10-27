/**
 * Filesystem observation bridge for DeepSeek Harness.
 *
 * Keeps the stock `@deepseek-ai/dsh-fs-observation-policy` gate and feeds it
 * one additional observation source: source a code-reading tool actually
 * returned, validated against the current file, is recorded through
 * `fs/observed` exactly like `read`.
 *
 * The plugin is composed from two independent registries: transports (MCP, CLI,
 * shell-read, native) normalize a tool call, and sources decide whether they
 * accept that call and how to extract source evidence (CodeGraph, Bash shell
 * reads, PowerShell shell reads). Adding a new code-reading tool is a source
 * change; adding a new calling convention is a transport change.
 * @module dsh-fs-observation-bridge
 */

import { registerBridge } from './bridge.js'
import { resolveConfig, selectSources } from './config.js'
import { codegraphSource } from './sources/codegraph.js'
import { powershellReadSource } from './sources/powershell-read.js'
import { createSourceRegistry } from './sources/registry.js'
import { shellReadSource } from './sources/shell-read.js'
import { cliTransport } from './transports/cli.js'
import { mcpTransport } from './transports/mcp.js'
import { nativeTransport } from './transports/native.js'
import { createTransportRegistry } from './transports/registry.js'
import { shellReadTransport } from './transports/shell-read.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-observation-bridge'

/** Filesystem service required to resolve targets and read their versions. */
export const inject = ['fs']

/**
 * Register the bridge with the built-in transports and sources.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} [config] - loader config (`maxSourceBytes`, `maxEvidenceFiles`, `disabledSources`).
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const transports = createTransportRegistry([
    mcpTransport(),
    cliTransport(),
    shellReadTransport(),
    nativeTransport(),
  ])
  const sources = createSourceRegistry(selectSources(
    [codegraphSource, shellReadSource, powershellReadSource],
    resolved.disabledSources,
  ))
  registerBridge(ctx, transports, sources, resolved)
}
