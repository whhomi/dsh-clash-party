// End-to-end smoke test. Everything machine-specific comes from the environment:
//
//   DSH_PROXY_CORE      path to a mihomo executable (required)
//   DSH_PROXY_BOOTSTRAP optional Clash config used as the base config
//   DSH_PROXY_SUB       optional subscription URL (fetched through the core)
//   DSH_PROXY_DATA      optional data dir (default: a temp dir)
//
// Example:
//   DSH_PROXY_CORE=/path/to/mihomo node test/smoke.mjs
//
// The test only exercises the public surface: apply() -> tools -> core API.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const core = process.env.DSH_PROXY_CORE
if (!core) {
  console.log('skip: DSH_PROXY_CORE is not set')
  process.exit(0)
}

const dataDir = process.env.DSH_PROXY_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proxy-'))
const tools = new Map()
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name) }, get: (n) => tools.get(n) },
  effect: () => {},
}

apply(ctx, {
  corePath: core,
  dataDir,
  httpPort: Number(process.env.DSH_PROXY_HTTP_PORT ?? 17890),
  controllerPort: Number(process.env.DSH_PROXY_CONTROLLER_PORT ?? 19090),
  panelPort: Number(process.env.DSH_PROXY_PANEL_PORT ?? 17891),
  bootstrapConfig: process.env.DSH_PROXY_BOOTSTRAP ?? '',
  subscriptions: process.env.DSH_PROXY_SUB ? [{ id: 'test', url: process.env.DSH_PROXY_SUB }] : [],
  nodes: process.env.DSH_PROXY_NODE ? [process.env.DSH_PROXY_NODE] : [],
})

const call = (name, args = {}) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  return tool.execute(args, {})
}

console.log('tools:', [...tools.keys()].join(', '))

const started = await call('proxy_start')
console.log('started:', started.running !== false, '| config:', started.config)

await new Promise((r) => setTimeout(r, 4000))
const status = await call('proxy_status')
console.log('running:', status.running, '| version:', status.version, '| nodes:', status.nodeCount)
console.log('providers:', (status.providers ?? []).map((p) => `${p.name}:${p.nodes}`).join(', '))

const nodes = await call('proxy_nodes', { limit: 3 })
const group = nodes.groups?.[0]?.name
console.log('first group:', group, '| members:', nodes.groups?.[0]?.memberCount)

if (group) {
  const tested = await call('proxy_test', { group })
  const alive = (tested.nodes ?? []).filter((n) => typeof n.delay === 'number')
  console.log('alive in group:', alive.length, '| fastest:', alive[0]?.delay, 'ms')
}

await call('proxy_stop')
console.log('stopped')
process.exit(0)
