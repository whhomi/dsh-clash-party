import fs from 'node:fs'
import { nodeLines } from './node-uri.js'

const DEFAULT_RULES = [
  'DOMAIN-SUFFIX,localhost,DIRECT',
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'GEOIP,CN,DIRECT',
  'MATCH,PROXY',
]

const MINIMAL_BASE = `mixed-port: 0
allow-lan: false
bind-address: '127.0.0.1'
mode: rule
log-level: info
`

function rewriteBase(text, { httpPort, controllerPort, secret }) {
  let out = text
  const ensure = (re, line) => {
    out = re.test(out) ? out.replace(re, line) : out + '\n' + line
  }
  ensure(/^mixed-port:.*$/m, `mixed-port: ${httpPort}`)
  out = out.replace(/^socks-port:.*$/gm, 'socks-port: 0')
  out = out.replace(/^port:.*$/gm, 'port: 0')
  out = out.replace(/^redir-port:.*$/gm, 'redir-port: 0')
  out = out.replace(/^tproxy-port:.*$/gm, 'tproxy-port: 0')
  out = out.replace(/^allow-lan:.*$/gm, 'allow-lan: false')
  out = out.replace(/^bind-address:.*$/gm, "bind-address: '127.0.0.1'")
  ensure(/^external-controller:.*$/m, `external-controller: '127.0.0.1:${controllerPort}'`)
  out = out.replace(/^secret:.*$/gm, `secret: '${secret ?? ''}'`)
  out = disableTun(out)
  return out
}

/** Force `tun.enable: false` without disturbing the rest of the tun block. */
function disableTun(text) {
  const idx = text.search(/^tun:[ \t]*$/m)
  if (idx < 0) return text
  const head = text.slice(0, idx)
  const rest = text.slice(idx)
  const nextTop = rest.search(/\n(?=[A-Za-z][\w-]*:)/)
  const block = nextTop < 0 ? rest : rest.slice(0, nextTop)
  const tail = nextTop < 0 ? '' : rest.slice(nextTop)
  return head + block.replace(/^(\s+enable:\s*).*$/m, '$1false') + tail
}

/** First url-test group name, used as the provider fetch selector when none is given. */
export function detectBootstrapSelector(cfg) {
  const groups = cfg.split(/^proxy-groups:[ \t]*$/m)[1] ?? ''
  const m = groups.match(/^ {2}- name: ([^\r\n]+)\r?\n {4}type: url-test/m)
  if (m) return m[1].trim()
  const any = groups.match(/^ {2}- name: ([^\r\n]+)/m)
  return any ? any[1].trim() : undefined
}

function insertAfterKey(cfg, key, lines) {
  if (!lines.length) return cfg
  const re = new RegExp(`^${key}:[ \\t]*\\r?$`, 'm')
  const m = re.exec(cfg)
  if (!m) return cfg.trimEnd() + `\n${key}:\n` + lines.join('\n') + '\n'
  const at = cfg.indexOf('\n', m.index) + 1
  return cfg.slice(0, at) + lines.join('\n') + '\n' + cfg.slice(at)
}

function providerBlock(subscriptions, { bootstrapSelector, healthCheckUrl, secret }) {
  const lines = ['proxy-providers:']
  for (const s of subscriptions) {
    const id = s.id
    lines.push(`  ${id}:`)
    if (s.mode === 'http') {
      lines.push('    type: http')
      lines.push(`    url: ${JSON.stringify(s.url)}`)
      lines.push(`    interval: ${s.interval ?? 3600}`)
      lines.push(`    path: ./providers/${id}.yaml`)
      const proxy = s.proxy || bootstrapSelector
      if (proxy) lines.push(`    proxy: ${JSON.stringify(proxy)}`)
      lines.push('    header:')
      lines.push('      User-Agent:')
      lines.push(`        - ${JSON.stringify(s.userAgent ?? 'clash-verge/v2.0.0')}`)
    } else {
      // The plugin pulls the subscription itself (through the core, which reaches past
      // the censored endpoint) and hands the core a local file: the core never writes
      // outside the sandbox and never depends on its own egress for a refresh.
      lines.push('    type: file')
      lines.push(`    path: ./providers/${id}.yaml`)
    }
    lines.push('    health-check:')
    lines.push('      enable: true')
    lines.push(`      url: ${JSON.stringify(healthCheckUrl)}`)
    lines.push('      interval: 600')
    if (s.prefix) {
      lines.push('    override:')
      lines.push(`      additional-prefix: ${JSON.stringify(s.prefix)}`)
    }
  }
  return lines
}

function providerGroups(subscriptions) {
  const lines = []
  for (const s of subscriptions) {
    lines.push(`  - name: ${JSON.stringify(s.groupName)}`)
    lines.push('    type: select')
    lines.push('    use:')
    lines.push(`      - ${s.id}`)
  }
  return lines
}

/**
 * Compose the runtime config the core will be started with.
 * @returns {{ yaml: string, bootstrapSelector?: string, providers: string[] }}
 */
export function composeConfig(options) {
  const {
    bootstrapConfig,
    httpPort,
    controllerPort,
    secret = '',
    nodes = [],
    subscriptions = [],
    healthCheckUrl = 'https://www.gstatic.com/generate_204',
  } = options

  const subs = subscriptions
    .filter((s) => s && s.url)
    .map((s, i) => ({
      id: s.id ?? `sub${i + 1}`,
      url: s.url,
      interval: s.interval,
      userAgent: s.userAgent,
      prefix: s.prefix ?? '[sub] ',
      proxy: s.proxy,
      groupName: s.groupName ?? `[sub] ${s.id ?? `sub${i + 1}`}`,
    }))

  let base = MINIMAL_BASE
  if (bootstrapConfig && fs.existsSync(bootstrapConfig)) base = fs.readFileSync(bootstrapConfig, 'utf8')
  else if (bootstrapConfig) throw new Error(`bootstrapConfig not found: ${bootstrapConfig}`)

  let cfg = rewriteBase(base, { httpPort, controllerPort, secret })
  const bootstrapSelector = detectBootstrapSelector(cfg)

  cfg = insertAfterKey(cfg, 'proxies', nodeLines(nodes))

  if (subs.length) {
    if (!/^proxy-providers:/m.test(cfg)) cfg = cfg.trimEnd() + '\n' + providerBlock(subs, { bootstrapSelector, healthCheckUrl, secret }).join('\n') + '\n'
    cfg = insertAfterKey(cfg, 'proxy-groups', providerGroups(subs))
  }

  if (!/^proxy-groups:/m.test(cfg) && !/^$/.test(cfg.trim())) {
    const names = nodes.map((n) => JSON.stringify(n.name))
    cfg += '\nproxy-groups:\n  - name: PROXY\n    type: select\n    proxies:\n' + names.map((n) => `      - ${n}`).join('\n') + '\n'
  }
  if (!/^rules:/m.test(cfg)) cfg += '\nrules:\n' + DEFAULT_RULES.map((r) => `  - ${r}`).join('\n') + '\n'

  return { yaml: cfg, bootstrapSelector, providers: subs.map((s) => s.id) }
}
