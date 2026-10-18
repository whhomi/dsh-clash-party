// Node-URI → mihomo proxy object converter.
// ss (SIP002 + legacy + obfs/v2ray-plugin), trojan, vmess, vless, hysteria2, tuic.

const b64 = (s) => {
  let t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  return Buffer.from(t, 'base64').toString('utf8')
}

const q = (u) => Object.fromEntries(u.searchParams.entries())
const flag = (v) => v === '1' || v === 'true'
const frag = (u) => (u.hash ? decodeURIComponent(u.hash.slice(1)) : '')
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '')

function transportOpts(u, net) {
  const p = q(u)
  const out = {}
  if (net === 'ws') {
    out['ws-opts'] = {
      path: p.path ? decodeURIComponent(p.path) : '/',
      headers: p.host ? { Host: decodeURIComponent(p.host) } : undefined,
    }
    if (p.ed) out['ws-opts']['max-early-data'] = Number(p.ed)
  } else if (net === 'grpc') {
    out['grpc-opts'] = { 'grpc-service-name': p.serviceName || p.path || '' }
  } else if (net === 'h2') {
    out['h2-opts'] = {
      host: p.host ? [decodeURIComponent(p.host)] : undefined,
      path: p.path ? decodeURIComponent(p.path) : '/',
    }
  }
  return out
}

function parseSs(raw) {
  const body = raw.slice('ss://'.length)
  const hashIdx = body.indexOf('#')
  const name = hashIdx >= 0 ? decodeURIComponent(body.slice(hashIdx + 1)) : ''
  let rest = hashIdx >= 0 ? body.slice(0, hashIdx) : body

  let method, password, hostpart
  const at = rest.lastIndexOf('@')
  if (at > 0 && rest.includes(':')) {
    const cred = rest.slice(0, at)
    hostpart = rest.slice(at + 1)
    const decoded = cred.includes(':') ? cred : b64(cred)
    const i = decoded.indexOf(':')
    method = decoded.slice(0, i)
    password = decoded.slice(i + 1)
  } else {
    const decoded = b64(rest)
    const at2 = decoded.lastIndexOf('@')
    const cred = decoded.slice(0, at2)
    hostpart = decoded.slice(at2 + 1)
    const i = cred.indexOf(':')
    method = cred.slice(0, i)
    password = cred.slice(i + 1)
  }

  const qIdx = hostpart.indexOf('?')
  const search = qIdx >= 0 ? hostpart.slice(qIdx + 1) : ''
  if (qIdx >= 0) hostpart = hostpart.slice(0, qIdx)
  const slash = hostpart.indexOf('/')
  if (slash >= 0) hostpart = hostpart.slice(0, slash)

  const m = hostpart.match(/^(.+):(\d+)$/)
  if (!m) throw new Error('ss: bad host:port')
  const params = new URLSearchParams(search)
  const pluginStr = params.get('plugin')

  const proxy = { name, type: 'ss', server: m[1], port: Number(m[2]), cipher: method, password, udp: true }
  if (pluginStr) {
    const [pluginName, ...restParts] = pluginStr.split(';')
    const opts = {}
    for (const kv of restParts) {
      const [k, v = 'true'] = kv.split('=')
      opts[k] = /^\d+$/.test(v) ? Number(v) : v
    }
    if (/obfs/.test(pluginName)) {
      proxy.plugin = 'obfs'
      proxy['plugin-opts'] = { mode: opts.obfs || opts.mode || 'http', host: opts['obfs-host'] || opts.host }
    } else if (/v2ray/.test(pluginName)) {
      proxy.plugin = 'v2ray-plugin'
      proxy['plugin-opts'] = { mode: 'websocket', host: opts.host, path: opts.path, tls: opts.tls === 'true' }
    }
  }
  return proxy
}

function parseTrojan(u) {
  const p = q(u)
  const proxy = {
    name: frag(u) || p.remarks || '',
    type: 'trojan',
    server: hostOf(u),
    port: Number(u.port || 443),
    password: decodeURIComponent(u.username || ''),
    udp: true,
  }
  if (p.sni || p.peer) proxy.sni = p.sni || p.peer
  if (flag(p.allowInsecure) || flag(p.insecure) || flag(p.skipCertVerify)) proxy['skip-cert-verify'] = true
  if (p.type && p.type !== 'none') Object.assign(proxy, { network: p.type === 'original' ? undefined : p.type }, transportOpts(u, p.type))
  if (p.alpn) proxy.alpn = p.alpn.split(',').map((s) => s.trim())
  return proxy
}

function parseVmess(raw) {
  const json = JSON.parse(b64(raw.slice('vmess://'.length)))
  const net = json.net || 'tcp'
  const proxy = {
    name: json.ps || '',
    type: 'vmess',
    server: json.add,
    port: Number(json.port),
    uuid: json.id,
    alterId: Number(json.aid || 0),
    cipher: json.scy || 'auto',
    udp: true,
  }
  if (json.tls && json.tls !== 'none') {
    proxy.tls = true
    if (json.sni || json.host) proxy.servername = json.sni || json.host
    if (String(json.allowInsecure) === '1') proxy['skip-cert-verify'] = true
  }
  if (net !== 'tcp') {
    proxy.network = net
    if (net === 'ws') proxy['ws-opts'] = { path: json.path || '/', headers: json.host ? { Host: json.host } : undefined }
    else if (net === 'grpc') proxy['grpc-opts'] = { 'grpc-service-name': json.path || '' }
    else if (net === 'h2') proxy['h2-opts'] = { host: json.host ? [json.host] : undefined, path: json.path || '/' }
  }
  return proxy
}

function parseVless(u) {
  const p = q(u)
  const sec = p.security || 'none'
  const net = p.type || 'tcp'
  const proxy = {
    name: frag(u) || p.remarks || '',
    type: 'vless',
    server: hostOf(u),
    port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username || ''),
    udp: true,
  }
  if (p.flow) proxy.flow = p.flow
  if (sec === 'tls' || sec === 'reality') {
    proxy.tls = true
    if (p.sni) proxy.servername = p.sni
    if (flag(p.allowInsecure) || flag(p.insecure)) proxy['skip-cert-verify'] = true
    if (p.fp) proxy['client-fingerprint'] = p.fp
    if (sec === 'reality') proxy['reality-opts'] = { 'public-key': p.pbk, 'short-id': p.sid }
  }
  if (net !== 'tcp') Object.assign(proxy, { network: net }, transportOpts(u, net))
  return proxy
}

function parseHysteria2(u) {
  const p = q(u)
  const proxy = {
    name: frag(u) || p.remarks || '',
    type: 'hysteria2',
    server: hostOf(u),
    port: Number(u.port || 443),
    password: decodeURIComponent(u.username || ''),
    udp: true,
  }
  if (p.sni) proxy.sni = p.sni
  if (flag(p.insecure) || flag(p.allowInsecure)) proxy['skip-cert-verify'] = true
  if (p.obfs) proxy.obfs = p.obfs
  if (p['obfs-password']) proxy['obfs-password'] = p['obfs-password']
  if (p.mport || p.ports) proxy.ports = p.mport || p.ports
  return proxy
}

function parseTuic(u) {
  const p = q(u)
  const proxy = {
    name: frag(u) || p.remarks || '',
    type: 'tuic',
    server: hostOf(u),
    port: Number(u.port || 443),
    uuid: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  }
  if (p.sni) proxy.sni = p.sni
  if (p.alpn) proxy.alpn = p.alpn.split(',')
  if (flag(p.allow_insecure) || flag(p.insecure)) proxy['skip-cert-verify'] = true
  if (p.udp_relay_mode) proxy['udp-relay-mode'] = p.udp_relay_mode
  if (p.congestion_control) proxy['congestion-controller'] = p.congestion_control
  return proxy
}

export function parseNodeUri(raw) {
  const s = String(raw).trim()
  if (!/^[a-z0-9]+:\/\//i.test(s)) throw new Error('not a node URI')
  const scheme = s.slice(0, s.indexOf('://')).toLowerCase()
  switch (scheme) {
    case 'ss': return parseSs(s)
    case 'trojan': return parseTrojan(new URL(s))
    case 'vmess': return parseVmess(s)
    case 'vless': return parseVless(new URL(s))
    case 'hysteria2':
    case 'hy2': return parseHysteria2(new URL(s))
    case 'tuic': return parseTuic(new URL(s))
    default: throw new Error('unsupported scheme: ' + scheme)
  }
}

export function parseNodeInput(text) {
  if (Array.isArray(text)) text = text.join('\n')
  let body = String(text ?? '').trim()
  for (let i = 0; i < 2 && !/^[a-z0-9]+:\/\//im.test(body); i++) {
    const decoded = b64(body)
    if (decoded === body || /[^\x20-\x7e\s]/.test(decoded)) break
    body = decoded
  }
  const nodes = []
  const errors = []
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    try {
      nodes.push(parseNodeUri(t))
    } catch (e) {
      errors.push({ line: t.slice(0, 24) + '…', error: e.message })
    }
  }
  return { nodes: dedupe(nodes), errors }
}

function dedupe(nodes) {
  const seen = new Set()
  const usedNames = new Set()
  const out = []
  for (const n of nodes) {
    const key = `${n.type}|${n.server}|${n.port}|${n.uuid || n.password || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    let name = (n.name || '').trim() || `${n.type}-${n.server}:${n.port}`
    if (usedNames.has(name)) {
      let i = 2
      while (usedNames.has(`${name} ${i}`)) i++
      name = `${name} ${i}`
    }
    usedNames.add(name)
    out.push({ ...n, name })
  }
  return out
}

function scalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return '[' + v.map(scalar).join(', ') + ']'
  const s = String(v)
  return /^[A-Za-z0-9_.\-/]+$/.test(s) ? s : JSON.stringify(s)
}

function inlineYaml(obj) {
  const parts = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === '') continue
    parts.push(v && typeof v === 'object' && !Array.isArray(v) ? `${k}: ${inlineYaml(v)}` : `${k}: ${scalar(v)}`)
  }
  return '{ ' + parts.join(', ') + ' }'
}

/** One `  - { ... }` line per node, ready to splice under a `proxies:` key. */
export function nodeLines(nodes) {
  return nodes.map((n) => '  - ' + inlineYaml(n))
}

export function toClashYaml(nodes) {
  return ['proxies:', ...nodeLines(nodes)].join('\n') + '\n'
}
