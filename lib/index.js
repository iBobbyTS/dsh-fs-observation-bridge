/**
 * Filesystem observation bridge for DeepSeek Harness.
 *
 * Keeps the stock `@deepseek-ai/dsh-fs-observation-policy` gate and feeds it
 * one additional observation source: source a code-reading tool actually
 * returned, validated against the current file, is recorded through
 * `fs/observed` exactly like `read`.
 *
 * The plugin is composed from two independent registries: transports (MCP, CLI,
 * native) normalize a tool call, and sources (CodeGraph for now) decide whether
 * they accept that call and how to extract source evidence. Adding a new
 * code-reading tool is a source change; adding a new calling convention is a
 * transport change.
 * @module dsh-fs-observation-bridge
 */

import { registerBridge } from './bridge.js'
import { codegraphSource } from './sources/codegraph.js'
import { createSourceRegistry } from './sources/registry.js'
import { cliTransport } from './transports/cli.js'
import { mcpTransport } from './transports/mcp.js'
import { nativeTransport } from './transports/native.js'
import { createTransportRegistry } from './transports/registry.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-observation-bridge'

/** Filesystem service required to resolve targets and read their versions. */
export const inject = ['fs']

/**
 * Register the bridge with the built-in transports and sources.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const transports = createTransportRegistry([
    mcpTransport(),
    cliTransport(),
    nativeTransport(),
  ])
  const sources = createSourceRegistry([
    codegraphSource,
  ])
  registerBridge(ctx, transports, sources)
}
