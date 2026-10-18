import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const CORE_CANDIDATES = ['mihomo.exe', 'mihomo', 'clash-meta.exe', 'clash-meta']

export class CoreManager {
  constructor({ corePath, dataDir, httpPort, controllerPort, secret = '', logger }) {
    this.corePath = corePath
    this.dataDir = dataDir
    this.httpPort = httpPort
    this.controllerPort = controllerPort
    this.secret = secret
    this.logger = logger
    this.child = null
    this.lastExit = null
  }

  get apiBase() {
    return `http://127.0.0.1:${this.controllerPort}`
  }

  dirs() {
    return {
      root: this.dataDir,
      bin: path.join(this.dataDir, 'bin'),
      providers: path.join(this.dataDir, 'providers'),
      logs: path.join(this.dataDir, 'logs'),
      config: path.join(this.dataDir, 'config.yaml'),
    }
  }

  ensureDirs() {
    const d = this.dirs()
    for (const dir of [d.root, d.bin, d.providers, d.logs]) fs.mkdirSync(dir, { recursive: true })
    return d
  }

  /**
   * A fresh core blocks on missing geodata by downloading it (which a censored
   * network never finishes). Seed the data dir from any local copy instead.
   */
  ensureGeoAssets() {
    const d = this.dirs()
    const required = [
      { target: 'Country.mmdb', sources: ['Country.mmdb', 'country.mmdb'] },
      { target: 'geosite.dat', sources: ['geosite.dat', 'GeoSite.dat'] },
      { target: 'geoip.dat', sources: ['geoip.dat', 'GeoIP.dat'] },
      { target: 'ASN.mmdb', sources: ['ASN.mmdb'] },
    ]
    const searchDirs = [
      this.dataDir,
      process.env.DSH_PROXY_GEO_DIR,
      process.env.APPDATA && path.join(process.env.APPDATA, 'mihomo-party', 'work'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev'),
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.config', 'clash'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'mihomo-party'),
    ].filter(Boolean)

    const copied = []
    const missing = []
    for (const { target, sources } of required) {
      const dest = path.join(d.root, target)
      if (fs.existsSync(dest)) continue
      let done = false
      for (const dir of searchDirs) {
        for (const name of sources) {
          const from = path.join(dir, name)
          if (!fs.existsSync(from)) continue
          try {
            fs.copyFileSync(from, dest)
            copied.push({ file: target, from })
            done = true
          } catch {}
          if (done) break
        }
        if (done) break
      }
      if (!done) missing.push(target)
    }
    return { copied, missing }
  }

  resolveCore() {
    if (this.corePath) return fs.existsSync(this.corePath) ? this.corePath : undefined
    const d = this.dirs()
    for (const name of CORE_CANDIDATES) {
      const p = path.join(d.bin, name)
      if (fs.existsSync(p)) return p
    }
    const exe = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      const p = path.join(dir, exe)
      if (fs.existsSync(p)) return p
    }
    return undefined
  }

  writeConfig(yaml) {
    const d = this.ensureDirs()
    fs.writeFileSync(d.config, yaml, { mode: 0o600 })
    return d.config
  }

  isRunning() {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  async start() {
    if (this.isRunning()) return { started: false, reason: 'already-running', pid: this.child.pid }
    const core = this.resolveCore()
    if (!core) throw new Error('mihomo core binary not found: set corePath or place mihomo(.exe) in <dataDir>/bin')
    const d = this.ensureDirs()
    const geo = this.ensureGeoAssets()
    if (geo.missing.includes('Country.mmdb') && !fs.existsSync(path.join(d.root, 'geoip.dat'))) {
      throw new Error(
        `dsh-proxy: no geodata in ${d.root} and none found to copy (looked in ${geo.missing.join(', ')}); ` +
          'set DSH_PROXY_GEO_DIR or drop Country.mmdb there — otherwise the core blocks on downloading it',
      )
    }
    const out = fs.openSync(path.join(d.logs, 'core.log'), 'a')
    this.child = spawn(core, ['-d', d.root], { stdio: ['ignore', out, out], windowsHide: true })
    this.child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() }
      this.logger?.warn?.(`dsh-proxy: core exited code=${code} signal=${signal}`)
      this.child = null
    })
    try {
      await this.waitReady(20000)
    } catch (e) {
      this.stop()
      throw e
    }
    return { started: true, pid: this.child?.pid, core, dataDir: d.root }
  }

  async waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const v = await this.api('/version', undefined, 1500)
        if (v?.version) return v
      } catch {}
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error(`dsh-proxy: core did not answer on ${this.apiBase} within ${timeoutMs}ms`)
  }

  async stop() {
    const child = this.child
    if (!child) return { stopped: false, reason: 'not-running' }
    this.child = null
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      child.once('exit', finish)
      try { child.kill('SIGTERM') } catch { finish() }
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} finish() }, 4000)
    })
    return { stopped: true }
  }

  async api(pathname, init, timeoutMs = 10000) {
    const res = await fetch(this.apiBase + pathname, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${text.slice(0, 200)}`)
    if (!text) return undefined
    try { return JSON.parse(text) } catch { return text }
  }

  version() { return this.api('/version') }
  configs() { return this.api('/configs') }
  proxies() { return this.api('/proxies') }
  providers() { return this.api('/providers/proxies') }
  delay(name, timeout = 5000, url = 'http://www.gstatic.com/generate_204') {
    return this.api(`/proxies/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`, undefined, timeout + 3000)
  }
  /** Provider-owned nodes are addressed under their provider, not under /proxies. */
  providerDelay(providerId, name, timeout = 5000, url = 'http://www.gstatic.com/generate_204') {
    return this.api(
      `/providers/proxies/${encodeURIComponent(providerId)}/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`,
      undefined,
      timeout + 3000,
    )
  }
  /** name → provider id, for nodes that live inside a provider file. */
  async providerOwners() {
    const all = await this.providers()
    const owners = new Map()
    for (const [id, provider] of Object.entries(all?.providers ?? {})) {
      if (!provider?.proxies?.length) continue
      if (!['HTTP', 'File'].includes(provider.vehicleType)) continue
      for (const proxy of provider.proxies) owners.set(proxy.name, id)
    }
    return owners
  }
  select(group, name) {
    return this.api(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  }
  providerHealthcheck(id) { return this.api(`/providers/proxies/${encodeURIComponent(id)}/healthcheck`, undefined, 90000) }
  /** Force one provider pull (same operation as its refresh interval). */
  updateProvider(id) { return this.api(`/providers/proxies/${encodeURIComponent(id)}`, { method: 'PUT' }, 120000) }
  reload() {
    return this.api(`/configs?force=true`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: this.dirs().config }),
    })
  }
}
