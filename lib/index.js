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
        results.push({ id: spec.id, status, bytes: body.length, proxied: this.manager.isRunning(), userinfo: userinfo || undefined })
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
    const written = this.writeConfig()
    const started = await this.manager.start()
    // Pull the subscriptions through the core we just started, then reload so the
    // fresh provider files join the running config.
    let refresh = []
    try {
      refresh = await this.refreshSubscriptions({ onlyMissing: true })
    } catch (e) {
      refresh = [{ error: String(e?.message ?? e) }]
    }
    const pulled = refresh.filter((r) => r.bytes)
    if (pulled.length) {
      this.writeConfig()
      await this.manager.reload().catch(() => {})
    }
    return {
      ...started,
      config: written.file,
      httpProxy: `http://127.0.0.1:${this.config.httpPort}`,
      controller: this.manager.apiBase,
      providers: written.providers,
      bootstrapSelector: written.bootstrapSelector,
      importedNodes: this.manualNodes.length,
      subscriptions: refresh,
    }
  }

  async stop() {
    return this.manager.stop()
  }

  /** Pull every subscription file, then reload the core so the fresh nodes join. */
  async refresh() {
    const results = await this.refreshSubscriptions()
    const pulled = results.filter((r) => r.bytes)
    let reloaded = false
    if (pulled.length) {
      this.writeConfig()
      if (this.manager.isRunning()) {
        await this.manager.reload().catch(() => {})
        reloaded = true
      }
    }
    return { results, reloaded }
  }

  async status() {
    const base = {
      running: this.manager.isRunning() || this.manager.child !== null,
      httpProxy: `http://127.0.0.1:${this.config.httpPort}`,
      controller: this.manager.apiBase,
      dataDir: this.dataDir,
      config: this.manager.dirs().config,
      core: this.manager.resolveCore() ?? null,
      bootstrapConfig: this.config.bootstrapConfig || null,
      subscriptions: this.subscriptionSpecs().map((s) => {
        const file = this.providerPath(s.id)
        let bytes = 0
        let updatedAt = null
        try { const st = fs.statSync(file); bytes = st.size; updatedAt = st.mtime.toISOString() } catch {}
        return { id: s.id, url: redact(s.url), interval: s.interval, mode: s.mode, file, bytes, updatedAt }
      }),
      importedNodes: this.manualNodes.length,
      lastExit: this.manager.lastExit,
    }
    if (!base.running) return base
    try {
      const [version, proxies, providers] = await Promise.all([
        this.manager.version(),
        this.manager.proxies(),
        this.manager.providers(),
      ])
      const entries = Object.entries(proxies?.proxies ?? {})
      const groups = entries.filter(([, p]) => ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].includes(p.type))
      return {
        ...base,
        version: version?.version,
        mode: version?.mode,
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

  async nodes({ group, limit = 30 } = {}) {
    const proxies = await this.manager.proxies()
    const entries = Object.entries(proxies?.proxies ?? {})
    const isGroup = ([, p]) => ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].includes(p.type)
    const groups = entries.filter(isGroup)
    const pick = group ? groups.filter(([n]) => n === group) : groups
    if (group && !pick.length) throw new Error(`unknown group: ${group}`)
    return {
      groups: pick.map(([n, p]) => ({
        name: n,
        type: p.type,
        now: p.now ?? null,
        members: (p.all ?? []).slice(0, limit),
        memberCount: (p.all ?? []).length,
      })),
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
        this.writeConfig()
        await this.manager.reload().catch(() => {})
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
    const results = []
    for (const n of targets) {
      try {
        const r = await this.manager.delay(n, 5000, testUrl)
        results.push({ name: n, delay: r?.delay ?? null })
      } catch (e) {
        results.push({ name: n, delay: null, error: String(e.message ?? e).slice(0, 120) })
      }
    }
    results.sort((a, b) => (a.delay ?? 1e9) - (b.delay ?? 1e9))
    return { nodes: results }
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
        await this.manager.reload()
        reloaded = true
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
