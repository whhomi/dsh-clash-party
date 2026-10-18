window.__ModuleLoader__.load({
  id: 'dsh-proxy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'dsh-proxy'
    const NS = 'dsh-proxy'

    // The desktop shell bridges relative fetches to its host; a browser page shares its
    // own origin; a static page may expose the host through __DSH_TRANSPORT__. The
    // standalone loopback carrier always answers on the last candidate.
    function baseCandidates() {
      const list = []
      const transport = window.__DSH_TRANSPORT__
      if (transport && transport.streamBaseUrl) list.push(String(transport.streamBaseUrl).replace(/\/$/, ''))
      if (location.protocol === 'http:' || location.protocol === 'https:') list.push(location.origin)
      list.push('')
      list.push('http://127.0.0.1:17891')
      return [...new Set(list)]
    }

    let resolvedBase = null

    async function attempt(base, path, body) {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await res.json().catch(() => ({}))
      if (payload && typeof payload.ok === 'boolean') return payload
      throw new Error(`HTTP ${res.status} from ${base || location.origin}`)
    }

    async function call(path, body) {
      const bases = resolvedBase === null ? baseCandidates() : [resolvedBase]
      let lastError
      for (const base of bases) {
        try {
          const payload = await attempt(base, path, body)
          resolvedBase = base
          if (!payload.ok) throw new Error(payload.error || 'request failed')
          return payload.data
        } catch (e) {
          lastError = e
        }
      }
      throw new Error(String(lastError && lastError.message ? lastError.message : lastError))
    }

    const S = {
      page: { display: 'flex', height: '100%', boxSizing: 'border-box', overflow: 'hidden', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      rail: { width: 232, flex: 'none', padding: 12, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', borderRight: '1px solid var(--dsw-alias-border-l3)' },
      card: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: 12 },
      seg: { display: 'flex', background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 12, padding: 3, gap: 2 },
      segItem: (active) => ({ flex: 1, padding: '7px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400, color: active ? '#fff' : 'inherit', background: active ? '#2f6fed' : 'transparent' }),
      rowTitle: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, marginBottom: 8 },
      bigNum: { fontSize: 20, fontWeight: 600, lineHeight: 1.2 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      bar: { height: 6, borderRadius: 3, background: 'var(--dsw-alias-interactive-bg-hover)', overflow: 'hidden', margin: '10px 0 6px' },
      barFill: (pct) => ({ height: '100%', width: Math.max(1, Math.min(100, pct)) + '%', background: '#2f6fed' }),
      grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
      tile: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer', background: 'transparent', color: 'inherit', textAlign: 'left' },
      main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      mainHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--dsw-alias-border-l3)' },
      h1: { fontSize: 16, fontWeight: 600, margin: 0 },
      groupCard: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 14, margin: '12px 18px 0', overflow: 'hidden' },
      groupHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer' },
      groupName: { fontWeight: 600, fontSize: 14 },
      badge: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' },
      count: { minWidth: 26, textAlign: 'center', fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'var(--dsw-alias-interactive-bg-hover)' },
      iconBtn: { border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'inherit', borderRadius: 8, width: 28, height: 28, cursor: 'pointer', lineHeight: 1 },
      nodeGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10, padding: '0 14px 14px' },
      node: (sel) => ({
        border: '1px solid ' + (sel ? '#2f6fed' : 'var(--dsw-alias-border-l3)'),
        background: sel ? 'rgba(47,111,237,.12)' : 'transparent',
        borderRadius: 12, padding: '10px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
      }),
      nodeBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 },
      nodeName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      chips: { display: 'flex', gap: 4, flexWrap: 'wrap' },
      chip: { fontSize: 10, padding: '1px 6px', borderRadius: 5, background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' },
      delay: (ms) => ({ fontSize: 13, fontWeight: 600, color: ms == null ? 'var(--dsw-alias-label-secondary)' : ms < 150 ? '#2ecc71' : ms < 300 ? '#e6b800' : '#e74c3c' }),
      banner: { margin: '12px 18px 0', padding: 12, borderRadius: 10, fontSize: 12, lineHeight: 1.6, border: '1px solid #e74c3c55', background: '#e74c3c18' },
      empty: { padding: 28, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      btn: (primary) => ({ border: '1px solid var(--dsw-alias-border-l3)', background: primary ? 'var(--dsw-alias-button-elevated-fill)' : 'transparent', color: 'inherit', borderRadius: 10, padding: '7px 12px', fontSize: 12, cursor: 'pointer' }),
    }

    function PanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18' }))
    }

    const gb = (n) => (n == null ? '—' : n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : (n / 1048576).toFixed(0) + ' MB')
    const dateOf = (sec) => (sec ? new Date(sec * 1000).toLocaleDateString() : '—')

    function ProxyPanel() {
      const [status, setStatus] = React.useState(null)
      const [nodes, setNodes] = React.useState(null)
      const [open, setOpen] = React.useState('')
      const [delays, setDelays] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('/dsh-proxy/status')
          setStatus(next)
          setError('')
          if (!next.running) { setNodes(null); return }
          const data = await call('/dsh-proxy/nodes', {})
          setNodes(data)
          setOpen((prev) => {
            const groups = data.groups || []
            if (prev && groups.some((g) => g.name === prev)) return prev
            return groups.find((g) => g.name.startsWith('[sub]'))?.name || groups[0]?.name || ''
          })
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const id = setInterval(() => { void refresh() }, 5000)
        return () => clearInterval(id)
      }, [refresh])

      const act = async (label, path, body) => {
        setBusy(label)
        try {
          await call(path, body || {})
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally { setBusy('') }
      }

      const testGroup = async (name) => {
        if (!name) return
        setBusy('test:' + name)
        try {
          const out = await call('/dsh-proxy/test', { group: name })
          const map = {}
          for (const r of out.nodes || []) map[r.name] = r.delay == null ? null : r.delay
          setDelays((prev) => Object.assign({}, prev, map))
        } catch (e) {
          setError(String(e.message || e))
        } finally { setBusy('') }
      }

      const sub = (status?.subscriptions || [])[0]
      const traffic = sub && sub.traffic ? sub.traffic : null
      const used = traffic ? (traffic.upload || 0) + (traffic.download || 0) : null
      const pct = traffic && traffic.total ? (used / traffic.total) * 100 : 0
      const groups = nodes?.groups || []
      const active = groups.filter((g) => g.name === open)[0]

      const rail = h('div', { style: S.rail },
        h('div', { style: S.seg }, [['rule', '规则'], ['global', '全局'], ['direct', '直连']].map(([value, label]) =>
          h('button', { key: value, style: S.segItem(status && status.mode === value), onClick: () => act('mode', '/dsh-proxy/mode', { mode: value }) }, label))),

        h('div', { style: S.card },
          h('div', { style: S.rowTitle },
            h('span', null, (sub && sub.id) || '订阅'),
            h('div', { style: { flex: 1 } }),
            h('button', { style: S.iconBtn, title: '刷新订阅', onClick: () => act('refresh', '/dsh-proxy/refresh') }, '⟳')),
          traffic
            ? h('div', null,
                h('div', { style: S.muted }, gb(used) + ' / ' + (traffic.total ? gb(traffic.total) : '—')),
                h('div', { style: S.bar }, h('div', { style: S.barFill(pct) })),
                h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                  h('span', { style: S.muted }, pct.toFixed(1) + '%'),
                  h('span', { style: S.muted }, dateOf(traffic.expire))))
            : h('div', { style: S.muted }, sub ? (sub.bytes ? Math.round(sub.bytes / 1024) + ' KB · 无流量信息' : '未拉取') : '未配置订阅')),

        h('div', { style: S.grid2 },
          h('div', { style: S.tile },
            h('span', { style: S.bigNum }, String(groups.length || 0)),
            h('span', { style: S.muted }, '代理组')),
          h('div', { style: S.tile },
            h('span', { style: S.bigNum }, String((status && status.nodeCount) || 0)),
            h('span', { style: S.muted }, '节点'))),

        h('div', { style: S.card },
          h('div', { style: S.rowTitle }, h('span', null, (status && status.version) || '内核未启动')),
          h('div', { style: { ...S.muted, wordBreak: 'break-all' } }, (status && status.httpProxy) || '—'),
          h('div', { style: { marginTop: 8, display: 'flex', gap: 8 } },
            status && status.running
              ? h('button', { style: S.btn(false), onClick: () => act('stop', '/dsh-proxy/stop') }, busy === 'stop' ? '停止中…' : '停止内核')
              : h('button', { style: S.btn(true), onClick: () => act('start', '/dsh-proxy/start'), disabled: Boolean(status && status.coreMissing) }, busy === 'start' ? '启动中…' : '启动内核'))))

      const groupCard = (g) => {
        const isOpen = g.name === open
        return h('div', { key: g.name, style: S.groupCard },
          h('div', { style: S.groupHead, onClick: () => setOpen(isOpen ? '' : g.name) },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: S.groupName }, g.name),
                h('span', { style: S.badge }, g.type)),
              h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                '● ' + (g.now || '未选择'))),
            h('span', { style: S.count }, String(g.memberCount)),
            h('button', {
              style: S.iconBtn,
              title: '测速',
              onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); void testGroup(g.name) },
            }, busy === 'test:' + g.name ? '…' : '⚡'),
            h('span', { style: S.muted }, isOpen ? '⌃' : '⌄')),
          isOpen
            ? h('div', { style: S.nodeGrid },
                (g.members || []).map((m) => {
                  const shown = delays[m.name] !== undefined ? delays[m.name] : m.delay
                  return h('div', {
                    key: m.name,
                    style: S.node(m.name === g.now),
                    onClick: () => act('select', '/dsh-proxy/select', { group: g.name, node: m.name }),
                    title: m.name + ' · ' + m.type + (m.udp ? ' · udp' : '') + (m.xudp ? ' · xudp' : ''),
                  },
                    h('div', { style: S.nodeBody },
                      h('span', { style: S.nodeName }, m.name),
                      h('div', { style: S.chips },
                        h('span', { style: S.chip }, m.type),
                        m.udp ? h('span', { style: S.chip }, 'udp') : null,
                        m.xudp ? h('span', { style: S.chip }, 'xudp') : null)),
                    h('span', { style: S.delay(shown) }, shown == null ? '—' : String(shown)))
                }))
            : null)
      }

      const main = h('div', { style: S.main },
        h('div', { style: S.mainHead },
          h('h1', { style: S.h1 }, '代理组与节点'),
          h('div', { style: { flex: 1 } }),
          h('span', { style: S.muted }, status && status.running ? (status.nodeCount || 0) + ' 个节点' : '未运行'),
          h('button', { style: S.iconBtn, title: '刷新', onClick: () => void refresh() }, '⟳')),
        error ? h('div', { style: S.banner }, error) : null,
        status && status.coreMissing ? h('div', { style: S.banner }, h('b', null, '未找到 mihomo 内核'), h('div', null, status.coreHint)) : null,
        groups.length
          ? h('div', { style: { overflowY: 'auto', paddingBottom: 16 } }, groups.map(groupCard))
          : h('div', { style: S.empty }, status && status.running ? '正在加载节点…' : '内核未运行，启动后可查看分组与节点。'),
        active && active.now
          ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, padding: '10px 18px', borderTop: '1px solid var(--dsw-alias-border-l3)' } },
              '当前：' + active.name + ' → ' + active.now)
          : null)

      return h('div', { style: S.page }, rail, main)
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 90,
        label: () => '代理',
        locale: NS,
      }, PanelIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, ProxyPanel))
    }

    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
