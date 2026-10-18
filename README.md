# dsh-proxy

English | [中文](README.zh.md)

A **self-hosted proxy plugin** for DeepSeek Harness (DSH). The plugin runs a
[mihomo](https://github.com/MetaCubeX/mihomo) core inside the host process, so no
external proxy client has to be running.

- **Subscriptions**: the plugin pulls the subscription through its own core (which reaches a
  censored endpoint the host cannot), writes a node file, and lets the core consume it as a
  `type: file` provider — no core-side writes outside the sandbox, no dependency on the core's
  own egress for a refresh.
- **Single nodes**: `ss / trojan / vmess / vless / hysteria2 / tuic` URIs, parsed and merged.
- **Panel**: a **Proxy** page in the sidebar — state, node switching, latency tests, start/stop.
- **Tools**: the same surface for the agent (`proxy_status`, `proxy_select`, …).
- **Scope**: only traffic explicitly pointed at `http://127.0.0.1:17890`. It never touches the
  system proxy and never installs TUN.

## Layout

```
dsh-proxy/
├── lib/
│   ├── index.js      plugin entry: config, runtime, lifecycle, diagnostics markers
│   ├── core.js       core ownership: spawn / readiness / stop / geo seeding / REST client
│   ├── compose.js    config composition: bootstrap rewrite + providers + node injection
│   ├── node-uri.js   node URI → mihomo proxy object
│   ├── http.js       panel HTTP surface (host routes + standalone loopback server)
│   └── client.js     browser half: sidebar entry + Proxy page
├── test/smoke.mjs    smoke test (everything from environment variables)
├── cordis.patch.yml  bundle patch (plugin row + config template)
└── package.json
```

## Install

```bash
dsh plugin --profile <profile> add link:<path-to-this-directory>
```

Then override the row in the profile's `cordis.patch.yml` (template in this package's own file):

```yaml
- id: dsh-proxy
  name: 'dsh-proxy'
  config:
    enabled: true
    autoStart: true
    httpPort: 17890
    controllerPort: 19090
    panelPort: 17891
    corePath: '/path/to/mihomo'            # empty = <dataDir>/bin/mihomo or PATH
    bootstrapConfig: '/path/to/base.yaml'  # any Clash config; ports/controller rewritten
    subscriptions:
      - id: airport
        url: 'https://example.com/api/v1/sub?token=...'
        interval: 3600
        userAgent: 'clash-verge/v2.0.0'
        prefix: '[sub] '
    nodes: []
```

Restart DSH to load it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When false the plugin registers nothing |
| `autoStart` | `false` | Start the core together with DSH |
| `corePath` | `''` | mihomo executable; empty → `<dataDir>/bin/mihomo(.exe)` → `PATH` |
| `dataDir` | `$DSH_HOME/proxy` | Config, node files, logs, geo assets |
| `httpPort` | `17890` | Core mixed port (HTTP/SOCKS) — the proxy endpoint |
| `controllerPort` | `19090` | mihomo REST API |
| `panelPort` | `17891` | Standalone loopback carrier for the panel |
| `bootstrapConfig` | `''` | Base Clash config; supplies the first usable nodes |
| `subscriptions[]` | `[]` | `id / url / interval / userAgent / prefix / mode` |
| `nodes[]` | `[]` | Node URIs |
| `healthCheckUrl` | gstatic 204 | Latency test target |

## Input paths

```
subscription URL ──(plugin pulls via core)──→ providers/<id>.yaml ─┐
single node URI ──(parse + dedupe)─────────────────────────────────┤→ config.yaml → mihomo
bootstrapConfig ──(ports rewritten, tun forced off)───────────────┘
```

- Subscriptions default to `mode: file`: the plugin fetches and writes, the core only reads.
  Set `mode: http` to let the core fetch it itself where that works.
- The first pull needs a working egress: either a node group inside `bootstrapConfig`
  (a url-test group is best) or a single node imported with `proxy_import`.

## Tools

| Tool | Purpose |
|---|---|
| `proxy_status` | state, ports, node/group counts, providers, subscription files |
| `proxy_start` / `proxy_stop` | compose the config and (stop) the core |
| `proxy_nodes` | groups, members, current selection |
| `proxy_select` | switch a group's active node |
| `proxy_test` | delay-test nodes / a group / a provider (refreshes a missing file first) |
| `proxy_import` | import node URIs, persist, hot-reload |
| `proxy_refresh` | pull every subscription again and hot-reload |

## Panel

The browser half registers two slots — `sidebar.panellist` (icon) and `main` (page) — and talks
to the host over the plugin's own HTTP surface:

- exact `/dsh-proxy/*` routes on the host `webServer` (when the composition has one)
- a standalone loopback server on `127.0.0.1:<panelPort>`, always started, so a renderer loaded
  from `file://` still works

Routes: `status` (GET), `nodes` / `start` / `stop` / `select` / `test` / `import` / `refresh` (POST).

## Pointing other programs at it

The plugin only offers an endpoint; it never takes over the network:

- **Chrome (including chrome-devtools MCP)**: launch with `--proxyServer=http://127.0.0.1:17890`
- **Shell**: `HTTPS_PROXY=http://127.0.0.1:17890 curl https://example.com`
- **DSH's own requests**: point `HTTPS_PROXY` at the same port (`dsh-http-proxy` reads it)
- Do not enable TUN or write the system proxy — that affects every program on the machine.

## Runtime artifacts

```
<dataDir>/
├── config.yaml            core config (rewritten on start / import / refresh)
├── providers/<id>.yaml    subscription node files (plugin writes, core reads)
├── nodes.json             manually imported nodes
├── logs/core.log          core stdout/stderr
├── diagnostics.json       services visible at load time
├── ready.json / routes.json / panel-server.json   load and registration markers
└── load-error.json        load failure stack (absent when healthy)
```

Geo assets (`Country.mmdb` / `geosite.dat` / `geoip.dat`) are copied at start from
`DSH_PROXY_GEO_DIR` or a known clash / mihomo install; when none is found the plugin fails fast
with a clear error instead of letting the core hang on a download.

## Test

```bash
DSH_PROXY_CORE=/path/to/mihomo \
DSH_PROXY_BOOTSTRAP=/path/to/base.yaml \
DSH_PROXY_SUB='https://example.com/sub' \
node test/smoke.mjs
```

## Limits

- No `ssr://`, `juicity://`, `anytls://` — they are rejected with an explicit error.
- No TUN, no system-proxy writes, no autostart: all of those need elevation and are system-level
  installation, not a plugin.
- No core downloader: bring your own `mihomo` binary.
- The panel is a read-only list plus node switching; no subscription or rule editors.

## License

MIT
