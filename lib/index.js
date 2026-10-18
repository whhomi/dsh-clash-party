import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CoreManager } from './core.js'
import { composeConfig } from './compose.js'
import { parseNodeInput } from './node-uri.js'
import { registerTools } from './tools.js'
import { registerProxyRoutes, startStandaloneServer } from './http.js'

export const name = 'dsh-proxy'
export const inject = ['tools']

/** Decode an HTTP/1.1 chunked body: a subscription served chunked otherwise lands on disk with size prefixes. */
function dechunk(buf) {
  const parts = []
  let i = 0
  while (i < buf.length) {
    const lineEnd = buf.indexOf('\r\n', i)
    if (lineEnd < 0) break
    const size = parseInt(buf.subarray(i, lineEnd).toString().trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size))
    i = lineEnd + 2 + size + 2
  }
  return parts.length ? Buffer.concat(parts) : buf
}

const DEFAULTS = {
  enabled: true,
  autoStart: false,
  corePath: '',
  dataDir: '',
  httpPort: 17890,
  controllerPort: 19090,
  panelPort: 17891,
  secret: '',
  bootstrapConfig: '',
  subscriptions: [],
  nodes: [],
  healthCheckUrl: 'https://www.gstatic.com/generate_204',
  delayTimeoutMs: 4000,
  delayConcurrency: 8,
}

class ProxyRuntime {
  constructor(rawConfig, ctx) {
    const c = { ...DEFAULTS, ...(rawConfig ?? {}) }
    this.config = c
    this.ctx = ctx
    this.dataDir = c.dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'proxy')
    this.manager = new CoreManager({
      corePath: c.corePath,
      dataDir: this.dataDir,
      httpPort: c.httpPort,
      controllerPort: c.controllerPort,
      secret: c.secret,
      logger: safeLogger(ctx),
    })
    this.manager.ensureDirs()
    this.manualNodes = this.loadNodes()
    this.subscriptionStats = this.loadStats()
    this.refreshTimer = null
    this.nextRefreshAt = null
    this.refreshIntervalSeconds = null
    if (Array.isArray(c.nodes) && c.nodes.length) {
      const parsed = parseNodeInput(c.nodes)
      this.manualNodes = mergeNodes(this.manualNodes, parsed.nodes)
      this.saveNodes()
    }
  }

  nodesFile() {
    return path.join(this.dataDir, 'nodes.json')
  }

  loadNodes() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.nodesFile(), 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  saveNodes() {
    fs.writeFileSync(this.nodesFile(), JSON.stringify(this.manualNodes, null, 2), { mode: 0o600 })
  }

  statsFile() {
    return path.join(this.dataDir, 'subscriptions.json')
  }

  loadStats() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statsFile(), 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  saveStats() {
    try {
      fs.writeFileSync(this.statsFile(), JSON.stringify(this.subscriptionStats, null, 2), { mode: 0o600 })
    } catch {}
  }

  /** `subscription-userinfo: upload=1; download=2; total=3; expire=1700000000` */
  static parseUserinfo(header) {
    const line = (String(header ?? '').match(/subscription-userinfo:[^\r\n]*/i) ?? [''])[0]
    if (!line) return null
    const out = {}
    for (const part of line.replace(/^subscription-userinfo:\s*/i, '').split(';')) {
      const [k, v] = part.split('=').map((s) => s && s.trim())
      if (!k || !v) continue
      const n = Number(v)
      if (Number.isFinite(n)) out[k] = n
    }
    return Object.keys(out).length ? out : null
  }

  subscriptions() {
    return (this.config.subscriptions ?? []).filter((s) => s && s.url)
  }

  subscriptionSpecs() {
    return this.subscriptions().map((s, i) => ({
      id: s.id ?? `sub${i + 1}`,
      url: s.url,
      interval: s.interval ?? 3600,
      userAgent: s.userAgent ?? 'clash-verge/v2.0.0',
      prefix: s.prefix ?? '[sub] ',
      groupName: s.groupName ?? `[sub] ${s.id ?? `sub${i + 1}`}`,
      mode: s.mode ?? 'file',
      proxy: s.proxy,
    }))
  }

  providerPath(id) {
    return path.join(this.dataDir, 'providers', `${id}.yaml`)
  }

  compose() {
    // A file-backed provider is emitted only once its file exists, so the core never
    // starts against a provider path that is not there yet.
    const specs = this.subscriptionSpecs().filter((s) => s.mode === 'http' || fs.existsSync(this.providerPath(s.id)))
    return composeConfig({
      bootstrapConfig: this.config.bootstrapConfig,
      httpPort: this.config.httpPort,
      controllerPort: this.config.controllerPort,
      secret: this.config.secret,
      nodes: this.manualNodes,
      subscriptions: specs,
      healthCheckUrl: this.config.healthCheckUrl,
    })
  }

  /** HTTPS GET, optionally tunneled through the running core (needed to reach a censored endpoint). */
  async fetchText(urlString, userAgent, timeoutMs = 40000) {
    const viaCore = this.manager.isRunning() ? this.config.httpPort : undefined
    const u = new URL(urlString)
    if (!viaCore) {
      const res = await fetch(urlString, { headers: { 'user-agent': userAgent, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) })
      return { status: res.status, body: await res.text() }
    }
    const net = await import('node:net')
    const tls = await import('node:tls')
    return await new Promise((resolve, reject) => {
      const sock = net.connect(viaCore, '127.0.0.1')
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')) }, timeoutMs)
      sock.on('error', (e) => { clearTimeout(timer); reject(e) })
      sock.on('connect', () => sock.write(`CONNECT ${u.hostname}:443 HTTP/1.1\r\nHost: ${u.hostname}:443\r\n\r\n`))
      let buf = Buffer.alloc(0)
      const onData = (d) => {
        buf = Buffer.concat([buf, d])
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) return
        sock.removeListener('data', onData)
        const head = buf.subarray(0, i).toString()
        if (!/^HTTP\/1\.[01] 200/.test(head)) { clearTimeout(timer); sock.destroy(); reject(new Error('CONNECT failed: ' + head.split('\r\n')[0])); return }
        const t = tls.connect({ socket: sock, servername: u.hostname }, () => {
          t.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: ${userAgent}\r\nAccept: */*\r\nConnection: close\r\n\r\n`)
        })
        const chunks = []
        t.on('data', (c) => chunks.push(c))
        t.on('end', () => {
          clearTimeout(timer)
          const raw = Buffer.concat(chunks)
          const sep = raw.indexOf('\r\n\r\n')
          const header = raw.subarray(0, sep).toString()
          let body = raw.subarray(sep + 4)
          if (/transfer-encoding:\s*chunked/i.test(header)) body = dechunk(body)
          const status = Number((header.split('\r\n')[0].match(/\s(\d{3})\s?/) ?? [])[1] ?? 0)
          resolve({ status, body: body.toString('utf8'), header })
        })
        t.on('error', (e) => { clearTimeout(timer); reject(e) })
      }
      sock.on('data', onData)
    })
  }

  async refreshSubscriptions({ onlyMissing = false } = {}) {
    const results = []
    for (const spec of this.subscriptionSpecs()) {
      const file = this.providerPath(spec.id)
      if (onlyMissing && fs.existsSync(file) && fs.statSync(file).size > 1024) { results.push({ id: spec.id, skipped: true }); continue }
      try {
        const { status, body, header } = await this.fetchText(spec.url, spec.userAgent)
        if (status !== 200) throw new Error(`HTTP ${status}`)
        if (!/^\s*proxies:/m.test(body)) throw new Error('response is not a Clash config (no proxies:)')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body, { mode: 0o600 })
        const userinfo = (String(header ?? '').match(/subscription-userinfo:[^\r\n]*/i) ?? [''])[0]
        const traffic = ProxyRuntime.parseUserinfo(header)
        this.subscriptionStats[spec.id] = {
          bytes: body.length,
          updatedAt: new Date().toISOString(),
          traffic,
        }
        this.saveStats()
        results.push({ id: spec.id, status, bytes: body.length, proxied: this.manager.isRunning(), userinfo: userinfo || undefined, traffic })
      } catch (e) {
        results.push({ id: spec.id, error: String(e?.message ?? e) })
      }
    }
    this.lastRefresh = Date.now()
    return results
  }

  writeConfig() {
    const { yaml, bootstrapSelector, providers } = this.compose()
    const file = this.manager.writeConfig(yaml)
    return { file, bootstrapSelector, providers }
  }

  async start() {
    this.writeConfig()
    const started = await this.manager.start()
    // Bootstrap nodes are enough to reach the subscription; pull it through the core we
    // just started, then restart so the provider file and its group are in the config.
    let refresh = []
    try {
      refresh = await this.refreshSubscriptions({ onlyMissing: true })
    } catch (e) {
      refresh = [{ error: String(e?.message ?? e) }]
    }
    const pulled = refresh.filter((r) => r.bytes)
    if (pulled.length) await this.applyConfigRestart()
    this.scheduleRefresh()
    const written = this.writeConfig()
    return {
      ...started,
      pid: this.manager.child?.pid ?? started.pid,
      config: written.file,
      httpProxy: `http://127.0.0.1:${this.config.httpPort}`,
      controller: this.manager.apiBase,
      providers: written.providers,
      bootstrapSelector: written.bootstrapSelector,
      importedNodes: this.manualNodes.length,
      subscriptions: refresh,
    }
  }

  /** Rewrite the config and restart the core: mihomo's hot reload does not always pick up a new provider. */
  async applyConfigRestart() {
    this.writeConfig()
    if (!this.manager.isRunning()) return false
    await this.manager.stop()
    await this.manager.start()
    return true
  }

  async stop() {
    this.clearRefreshTimer()
    return this.manager.stop()
  }

  /** Subscriptions refresh on their own interval (default 60 minutes), through the core. */
  scheduleRefresh() {
    this.clearRefreshTimer()
    const specs = this.subscriptionSpecs()
    if (!specs.length) return
    const seconds = Math.max(60, Math.min(...specs.map((s) => s.interval)))
    this.refreshTimer = setInterval(() => {
      if (!this.manager.isRunning()) return
      void this.refresh().catch(() => {})
    }, seconds * 1000)
    this.refreshTimer.unref?.()
    this.nextRefreshAt = new Date(Date.now() + seconds * 1000).toISOString()
    this.refreshIntervalSeconds = seconds
  }

  clearRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
    this.nextRefreshAt = null
  }

  async setMode(mode) {
    if (!['rule', 'global', 'direct'].includes(mode)) throw new Error(`unknown mode: ${mode}`)
    await this.manager.api('/configs', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    return { mode }
  }

  /** Pull every subscription file, then apply the config (restarting the core when it runs). */
  async refresh() {
    const results = await this.refreshSubscriptions()
    const pulled = results.filter((r) => r.bytes)
    let reloaded = false
    if (pulled.length) reloaded = await this.applyConfigRestart()
    return { results, reloaded }
  }

  async status() {
    const core = this.manager.resolveCore() ?? null
    const dirs = this.manager.dirs()
    const base = {
      running: this.manager.isRunning() || this.manager.child !== null,
      httpProxy: `http://127.0.0.1:${this.config.httpPort}`,
      controller: this.manager.apiBase,
      dataDir: this.dataDir,
      config: dirs.config,
      core,
      // The plugin ships no core binary: tell the operator exactly where to put one.
      coreMissing: core === null,
      coreHint: core === null
        ? `未找到 mihomo 内核。请把 mihomo(.exe) 放到 ${path.join(dirs.bin, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo')}，或把 mihomo 加进 PATH，或在配置里设置 corePath。下载：https://github.com/MetaCubeX/mihomo/releases`
        : null,
      refreshIntervalSeconds: this.refreshIntervalSeconds ?? null,
      nextRefreshAt: this.nextRefreshAt ?? null,
      bootstrapConfig: this.config.bootstrapConfig || null,
      subscriptions: this.subscriptionSpecs().map((s) => {
        const file = this.providerPath(s.id)
        let bytes = 0
        let updatedAt = null
        try { const st = fs.statSync(file); bytes = st.size; updatedAt = st.mtime.toISOString() } catch {}
        const stats = this.subscriptionStats[s.id] ?? {}
        return {
          id: s.id,
          url: redact(s.url),
          interval: s.interval,
          mode: s.mode,
          file,
          bytes,
          updatedAt,
          // upload/download/total/expire from subscription-userinfo, when the provider sent it
          traffic: stats.traffic ?? null,
        }
      }),
      importedNodes: this.manualNodes.length,
      lastExit: this.manager.lastExit,
    }
    if (!base.running) return base
    try {
      const [version, configs, proxies, providers] = await Promise.all([
        this.manager.version(),
        this.manager.configs().catch(() => undefined),
        this.manager.proxies(),
        this.manager.providers(),
      ])
      const entries = Object.entries(proxies?.proxies ?? {})
      const groups = entries.filter(([, p]) => ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].includes(p.type))
      return {
        ...base,
        version: version?.version,
        mode: configs?.mode ?? 'rule',
        nodeCount: entries.length - groups.length,
        groups: groups.map(([n, p]) => ({ name: n, type: p.type, now: p.now ?? null, size: (p.all ?? []).length })),
        providers: Object.entries(providers?.providers ?? {}).map(([n, p]) => ({
          name: n,
          type: p.vehicleType,
          nodes: (p.proxies ?? []).length,
          updatedAt: p.updatedAt,
        })),
      }
    } catch (e) {
      return { ...base, error: String(e.message ?? e) }
    }
  }

  async nodes({ group, limit = 500 } = {}) {
    const [proxies, providers] = await Promise.all([
      this.manager.proxies(),
      this.manager.providers().catch(() => undefined),
    ])
    const entries = Object.entries(proxies?.proxies ?? {})
    const isGroup = ([, p]) => ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].includes(p.type)
    const groups = entries.filter(isGroup)

    // Per-node metadata for the panel cards: protocol, udp/xudp support, last delay.
    const meta = new Map()
    for (const [name, p] of entries) {
      if (isGroup([name, p])) continue
      meta.set(name, { name, type: p.type, udp: Boolean(p.udp), xudp: Boolean(p.xudp), delay: null })
    }
    for (const provider of Object.values(providers?.providers ?? {})) {
      for (const p of provider?.proxies ?? []) {
        const delay = p.history?.at(-1)?.delay
        meta.set(p.name, {
          name: p.name,
          type: p.type,
          udp: Boolean(p.udp),
          xudp: Boolean(p.xudp),
          delay: typeof delay === 'number' && delay > 0 ? delay : null,
        })
      }
    }

    const pick = group ? groups.filter(([n]) => n === group) : groups
    if (group && !pick.length) throw new Error(`unknown group: ${group}`)
    return {
      groups: pick.map(([n, p]) => {
        const names = (p.all ?? []).slice(0, limit)
        return {
          name: n,
          type: p.type,
          now: p.now ?? null,
          memberNames: names,
          memberCount: (p.all ?? []).length,
          members: names.map((name) => meta.get(name) ?? { name, type: 'unknown', udp: false, xudp: false, delay: null }),
        }
      }),
      selected: groups.map(([n, p]) => ({ group: n, node: p.now ?? null })),
    }
  }

  async select(group, node) {
    await this.manager.select(group, node)
    const proxies = await this.manager.proxies()
    const g = proxies?.proxies?.[group]
    return { group, now: g?.now ?? node }
  }

  async test({ nodes, provider, group, url } = {}) {
    const testUrl = url ?? 'http://www.gstatic.com/generate_204'
    let targets = nodes ?? []
    if (group) {
      const proxies = await this.manager.proxies()
      targets = proxies?.proxies?.[group]?.all ?? targets
    }
    if (provider || (!targets.length && this.subscriptions().length)) {
      const ids = provider ? [provider] : this.subscriptionSpecs().map((s) => s.id)
      // Pull any missing subscription file first: a stale or absent file is the usual
      // reason a provider reports zero nodes.
      const specs = this.subscriptionSpecs().filter((s) => ids.includes(s.id))
      const missing = specs.filter((s) => !fs.existsSync(this.providerPath(s.id)))
      if (missing.length) {
        await this.refreshSubscriptions().catch(() => [])
        await this.applyConfigRestart()
        await new Promise((r) => setTimeout(r, 1500))
      }
      for (const id of ids) {
        const current = (await this.manager.providers())?.providers?.[id]
        if (!current || (current.proxies ?? []).length === 0) await this.manager.updateProvider(id).catch(() => {})
        await this.manager.providerHealthcheck(id).catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 8000))
      const providers = await this.manager.providers()
      const out = {}
      for (const id of ids) {
        const list = providers?.providers?.[id]?.proxies ?? []
        out[id] = list.map((p) => ({
          name: p.name,
          delay: p.history?.at(-1)?.delay ?? null,
        })).sort((a, b) => (a.delay ?? 1e9) - (b.delay ?? 1e9))
      }
      return { provider: out }
    }
    // Provider-owned nodes have no per-node /proxies delay endpoint: health-check the whole
    // provider and read each node's latest history entry. Plain nodes are tested directly,
    // in a small pool so an 80-node group finishes in seconds.
    const owners = await this.manager.providerOwners().catch(() => new Map())
    const providerIds = [...new Set(targets.map((n) => owners.get(n)).filter(Boolean))]
    const providerDelay = new Map()
    if (providerIds.length) {
      await Promise.all(providerIds.map((id) => this.manager.providerHealthcheck(id).catch(() => {})))
      await new Promise((r) => setTimeout(r, 6000))
      const all = await this.manager.providers().catch(() => undefined)
      for (const id of providerIds) {
        for (const proxy of all?.providers?.[id]?.proxies ?? []) {
          const delay = proxy.history?.at(-1)?.delay
          providerDelay.set(proxy.name, typeof delay === 'number' && delay > 0 ? delay : null)
        }
      }
    }

    const results = new Array(targets.length)
    const timeoutMs = Number(this.config.delayTimeoutMs ?? 4000)
    const concurrency = Math.max(1, Number(this.config.delayConcurrency ?? 8))
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const index = cursor++
        const name = targets[index]
        if (owners.has(name)) {
          results[index] = { name, delay: providerDelay.get(name) ?? null }
          continue
        }
        try {
          const r = await this.manager.delay(name, timeoutMs, testUrl)
          const delay = r?.delay
          results[index] = { name, delay: typeof delay === 'number' && delay > 0 ? delay : null }
        } catch (e) {
          results[index] = { name, delay: null, error: String(e?.message ?? e).slice(0, 120) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
    const sorted = results.filter(Boolean).sort((a, b) => (a.delay ?? 1e9) - (b.delay ?? 1e9))
    return { nodes: sorted }
  }

  async importNodes({ uris, replace = false }) {
    const parsed = parseNodeInput(uris)
    if (!parsed.nodes.length) return { imported: 0, errors: parsed.errors }
    this.manualNodes = replace ? parsed.nodes : mergeNodes(this.manualNodes, parsed.nodes)
    this.saveNodes()
    const written = this.writeConfig()
    let reloaded = false
    if (this.manager.isRunning()) {
      try {
        reloaded = await this.applyConfigRestart()
      } catch (e) {
        return { imported: parsed.nodes.length, errors: parsed.errors, reloaded, reloadError: String(e.message ?? e) }
      }
    }
    return {
      imported: parsed.nodes.length,
      total: this.manualNodes.length,
      names: parsed.nodes.map((n) => n.name).slice(0, 50),
      errors: parsed.errors,
      config: written.file,
      reloaded,
    }
  }
}

function mergeNodes(existing, incoming) {
  const key = (n) => `${n.type}|${n.server}|${n.port}|${n.uuid ?? n.password ?? ''}`
  const seen = new Set(existing.map(key))
  const used = new Set(existing.map((n) => n.name))
  const out = [...existing]
  for (const n of incoming) {
    if (seen.has(key(n))) continue
    let name = n.name
    if (used.has(name)) {
      let i = 2
      while (used.has(`${name} ${i}`)) i++
      name = `${name} ${i}`
    }
    seen.add(key(n))
    used.add(name)
    out.push({ ...n, name })
  }
  return out
}

function redact(url) {
  return String(url ?? '').replace(/(\/[^/]{6,})$/, (m) => '/' + 'x'.repeat(Math.max(6, m.length - 1)))
}

/** Records which optional services this composition gave the plugin; read by the panel and by hand. */
function writeDiagnostics(runtime, ctx) {
  const info = { at: new Date().toISOString(), services: {}, inject: typeof ctx.inject }
  for (const name of ['webServer', 'tools', 'systemPrompt', 'connection', 'server', 'harness']) {
    try {
      info.services[name] = typeof ctx[name] === 'undefined' ? 'absent' : typeof ctx[name]
    } catch (e) {
      info.services[name] = 'throws: ' + String(e?.message ?? e)
    }
  }
  try {
    fs.writeFileSync(path.join(runtime.dataDir, 'diagnostics.json'), JSON.stringify(info, null, 2), { mode: 0o600 })
  } catch {}
}

/** Cordis throws when reading an undeclared service; optional chaining does not protect a getter. */
function optional(ctx, name) {
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

function safeLogger(ctx) {
  const logger = optional(ctx, 'logger')
  if (logger && typeof logger.warn === 'function') return logger
  return { warn() {}, info() {}, error() {} }
}

export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  if (!resolved.enabled) return

  const runtime = new ProxyRuntime(resolved, ctx)
  const marker = (name, payload) => {
    try { fs.writeFileSync(path.join(runtime.dataDir, name), JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2)) } catch {}
  }

  try {
    const disposeTools = registerTools(ctx, runtime)
    writeDiagnostics(runtime, ctx)

    // Routes need `webServer`, which this composition may or may not provide. A deferred
    // injection registers them once the service exists and stays inert when it never does.
    let disposeRoutes = () => {}
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (child) => {
        disposeRoutes = registerProxyRoutes(child, runtime)
        marker('routes.json', { registered: true, carrier: 'webServer' })
      })
    } else {
      const server = optional(ctx, 'webServer')
      if (server) disposeRoutes = registerProxyRoutes(ctx, runtime)
      marker('routes.json', { registered: Boolean(server), carrier: 'webServer' })
    }

    // The Electron renderer may load from file:// with no host web server composed, so a
    // loopback-only server is always started as the panel's fallback carrier.
    let disposeStandalone = () => {}
    startStandaloneServer(runtime, resolved.panelPort)
      .then((started) => {
        disposeStandalone = started.dispose
        marker('panel-server.json', { listening: true, port: started.port })
      })
      .catch((e) => marker('panel-server.json', { listening: false, error: String(e?.message ?? e) }))

    const teardown = () => {
      disposeTools()
      disposeRoutes()
      disposeStandalone()
      void runtime.stop()
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => teardown)
    else process.once('exit', teardown)

    if (resolved.autoStart && runtime.manager.resolveCore()) {
      runtime.start().catch((e) => optional(ctx, 'logger')?.warn?.(`dsh-proxy: autoStart failed: ${e.message}`))
    }

    const systemPrompt = optional(ctx, 'systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        systemPrompt.section({
          name: 'tool:dsh-proxy',
          order: systemPrompt.getSectionOrder?.('TOOL_WEB_SEARCH') ?? undefined,
          text: ({ scope }) => (ctx.tools.get('proxy_status', scope) === undefined
            ? ''
            : 'proxy_status / proxy_nodes / proxy_select / proxy_test manage a local mihomo core owned by this host; they change the egress used by later requests, not the host-wide proxy settings.'),
        })
      } catch {}
    }

    marker('ready.json', { loaded: true, tools: true })
    return runtime
  } catch (e) {
    marker('load-error.json', { message: String(e?.message ?? e), stack: String(e?.stack ?? '') })
    throw e
  }
}

export { ProxyRuntime, mergeNodes }
