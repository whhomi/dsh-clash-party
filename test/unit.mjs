// Offline unit tests: node URI parsing and config composition. No core, no network.
// Run with: node test/unit.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseNodeInput, toClashYaml } from '../lib/node-uri.js'
import { composeConfig, detectBootstrapSelector } from '../lib/compose.js'

const B = (s) => Buffer.from(s, 'utf8').toString('base64')
let passed = 0
const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`)
    process.exitCode = 1
  }
}

/** One representative URI per supported scheme. */
const URIS = [
  `ss://${B('aes-256-gcm:pass123')}@1.2.3.4:8388#hk-sip002`,
  `ss://${B('aes-128-gcm:p@ss@5.6.7.8:8389')}#us-legacy`,
  'trojan://pass456@example.com:443?sni=example.com&allowInsecure=1#jp-trojan',
  `vmess://${B(JSON.stringify({ v: '2', ps: 'sg-ws', add: 'example.org', port: '443', id: '11111111-2222-3333-4444-555555555555', aid: '0', net: 'ws', host: 'example.org', path: '/ray', tls: 'tls' }))}`,
  'vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@example.net:443?encryption=none&security=tls&sni=example.net&type=ws&path=%2Fws#de-vless',
  'hysteria2://pw789@example.io:443?sni=example.io&insecure=1&obfs=salamander&obfs-password=xyz#tw-hy2',
  'tuic://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:pw000@example.dev:443?sni=example.dev&alpn=h3#kr-tuic',
]

test('parses every supported scheme', () => {
  const { nodes, errors } = parseNodeInput(URIS.join('\n'))
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.equal(nodes.length, URIS.length)
  assert.deepEqual(nodes.map((n) => n.type), ['ss', 'ss', 'trojan', 'vmess', 'vless', 'hysteria2', 'tuic'])
})

test('ss SIP002 keeps cipher, password and plugin-free shape', () => {
  const [node] = parseNodeInput(URIS[0]).nodes
  assert.equal(node.cipher, 'aes-256-gcm')
  assert.equal(node.password, 'pass123')
  assert.equal(node.server, '1.2.3.4')
  assert.equal(node.port, 8388)
})

test('ss legacy form with an @ inside the password', () => {
  const [node] = parseNodeInput(URIS[1]).nodes
  assert.equal(node.password, 'p@ss')
  assert.equal(node.server, '5.6.7.8')
})

test('vmess websocket + tls options', () => {
  const [node] = parseNodeInput(URIS[3]).nodes
  assert.equal(node.network, 'ws')
  assert.equal(node.tls, true)
  assert.equal(node['ws-opts'].path, '/ray')
  assert.equal(node['ws-opts'].headers.Host, 'example.org')
})

test('vless keeps request headers decoded', () => {
  const [node] = parseNodeInput(URIS[4]).nodes
  assert.equal(node.type, 'vless')
  assert.equal(node.servername, 'example.net')
  assert.equal(node['ws-opts'].path, '/ws')
})

test('hysteria2 obfs and insecure flags', () => {
  const [node] = parseNodeInput(URIS[5]).nodes
  assert.equal(node.obfs, 'salamander')
  assert.equal(node['obfs-password'], 'xyz')
  assert.equal(node['skip-cert-verify'], true)
})

test('deduplicates identical nodes and suffixes duplicate names', () => {
  const dup = `${URIS[0]}\n${URIS[0]}\nss://${B('aes-256-gcm:pass123')}@9.9.9.9:8388#hk-sip002`
  const { nodes } = parseNodeInput(dup)
  assert.equal(nodes.length, 2, 'same node must collapse to one')
  assert.equal(nodes[1].name, 'hk-sip002 2')
})

test('accepts a base64 blob of URIs', () => {
  const { nodes } = parseNodeInput(B(URIS.join('\n')))
  assert.equal(nodes.length, URIS.length)
})

test('rejects unknown schemes without throwing', () => {
  const { nodes, errors } = parseNodeInput('https://example.com/sub\n' + URIS[0])
  assert.equal(nodes.length, 1)
  assert.equal(errors.length, 1)
})

test('clash yaml exposes proxies and quoting', () => {
  const { nodes } = parseNodeInput(URIS.join('\n'))
  const yaml = toClashYaml(nodes)
  assert.match(yaml, /^proxies:\n {2}- \{/)
  assert.match(yaml, /type: trojan/)
  assert.match(yaml, /type: hysteria2/)
})

test('compose rewrites ports, disables tun, keeps rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proxy-unit-'))
  const base = path.join(dir, 'base.yaml')
  fs.writeFileSync(base, [
    'mixed-port: 7890',
    "external-controller: '127.0.0.1:9090'",
    'allow-lan: true',
    'tun:',
    '  enable: true',
    '  stack: mixed',
    'proxies:',
    '  - { name: base-node, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: x }',
    'proxy-groups:',
    '  - name: AUTO',
    '    type: url-test',
    '    proxies: [base-node]',
    'rules:',
    '  - MATCH,AUTO',
  ].join('\n'))

  const { yaml, bootstrapSelector } = composeConfig({
    bootstrapConfig: base,
    httpPort: 17890,
    controllerPort: 19090,
    secret: '',
    nodes: parseNodeInput(URIS[0]).nodes,
    subscriptions: [{ id: 'airport', url: 'https://example.com/sub', interval: 3600, prefix: '[sub] ' }],
  })

  assert.equal(bootstrapSelector, 'AUTO')
  assert.match(yaml, /^mixed-port: 17890$/m)
  assert.match(yaml, /^external-controller: '127\.0\.0\.1:19090'$/m)
  assert.match(yaml, /^allow-lan: false$/m)
  assert.match(yaml, /^ {2}enable: false$/m, 'tun must be disabled')
  assert.match(yaml, /type: file/, 'file-backed provider by default')
  assert.match(yaml, /path: \.\/providers\/airport\.yaml/)
  assert.match(yaml, /\[sub\] airport/)
  assert.match(yaml, /MATCH,AUTO/)
})

test('detectBootstrapSelector falls back to the first group', () => {
  assert.equal(detectBootstrapSelector('proxy-groups:\n  - name: G\n    type: select\n'), 'G')
  assert.equal(detectBootstrapSelector('rules: []\n'), undefined)
})

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`)
