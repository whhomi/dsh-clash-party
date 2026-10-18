// Host-side HTTP surface for the proxy panel. Two carriers, so the panel works in
// every shell: exact routes on the shell's own web server (Web composition), and a
// loopback-only standalone server the renderer can always reach (Electron, where
// the page may load from file:// and the host web server may not be composed).

import http from 'node:http'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
}

function send(res, status, body) {
  const payload = JSON.stringify(body ?? null)
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** path → [method, handler] shared by both carriers. */
export const ROUTES = {
  '/dsh-proxy/status': ['GET', (rt) => rt.status()],
  '/dsh-proxy/nodes': ['POST', (rt, b) => rt.nodes(b ?? {})],
  '/dsh-proxy/start': ['POST', (rt) => rt.start()],
  '/dsh-proxy/stop': ['POST', (rt) => rt.stop()],
  '/dsh-proxy/select': ['POST', (rt, b) => rt.select(b?.group, b?.node)],
  '/dsh-proxy/test': ['POST', (rt, b) => rt.test(b ?? {})],
  '/dsh-proxy/import': ['POST', (rt, b) => rt.importNodes(b ?? {})],
  '/dsh-proxy/refresh': ['POST', (rt) => rt.refresh()],
  '/dsh-proxy/mode': ['POST', (rt, b) => rt.setMode(b?.mode)],
}

async function dispatch(runtime, pathname, req, res) {
  const entry = ROUTES[pathname]
  if (!entry) { send(res, 404, { ok: false, error: 'not found' }); return }
  const [method, run] = entry
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return }
  if (req.method !== method) { send(res, 405, { ok: false, error: 'method not allowed' }); return }
  try {
    const body = method === 'POST' ? await readJson(req) : {}
    send(res, 200, { ok: true, data: await run(runtime, body) })
  } catch (e) {
    send(res, 500, { ok: false, error: String(e?.message ?? e) })
  }
}

/** @returns dispose function removing every registered route. */
export function registerProxyRoutes(ctx, runtime) {
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') return () => {}
  const disposers = Object.entries(ROUTES).map(([path, [method]]) => server.register({
    kind: 'exact',
    path,
    handler: (req, res) => dispatch(runtime, path, req, res),
  }))
  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}

/**
 * Loopback JSON server the panel can reach from any renderer origin.
 * @returns {{ port: number } | { error: string }} and a `dispose` function.
 */
export async function startStandaloneServer(runtime, port = 17891) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    void dispatch(runtime, pathname, req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(undefined) })
  })
  const dispose = () => { try { server.close() } catch {} }
  return { port, dispose }
}
