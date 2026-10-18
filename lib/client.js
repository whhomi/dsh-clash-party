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

    // Candidate origins, most likely first: the desktop shell bridges relative
    // fetches to its host, a browser page shares its own origin, and a static
    // page may expose the host origin through __DSH_TRANSPORT__.
    function baseCandidates() {
      const list = []
      const transport = window.__DSH_TRANSPORT__
      if (transport && transport.streamBaseUrl) list.push(String(transport.streamBaseUrl).replace(/\/$/, ''))
      if (location.protocol === 'http:' || location.protocol === 'https:') list.push(location.origin)
      list.push('')
      // Standalone loopback carrier the host always starts (works from file:// too).
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

    const css = {
      root: { padding: '20px 24px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      dot: (on) => ({ width: 8, height: 8, borderRadius: 4, background: on ? '#2ecc71' : '#888', flex: 'none' }),
      card: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: 12, marginBottom: 12 },
      kv: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 10px', fontSize: 12 },
      key: { color: 'var(--dsw-alias-label-secondary)' },
      mono: { fontFamily: 'var(--ds-font-family-code)', wordBreak: 'break-all' },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6 },
      node: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      delay: (ms) => ({ fontSize: 11, color: ms == null ? 'var(--dsw-alias-label-secondary)' : ms < 150 ? '#2ecc71' : ms < 300 ? '#f1c40f' : '#e74c3c' }),
      h3: { fontSize: 12, fontWeight: 600, margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase', letterSpacing: '.04em' },
      err: { color: '#e74c3c', fontSize: 12, marginBottom: 10 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
    }

    function Btn(props) {
      const style = {
        border: '1px solid var(--dsw-alias-border-l3)',
        background: props.primary ? 'var(--dsw-alias-button-elevated-fill)' : 'transparent',
        color: 'inherit',
        borderRadius: 6,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
        opacity: props.disabled ? 0.5 : 1,
      }
      return h('button', { style, onClick: props.onClick, disabled: props.disabled }, props.children)
    }

    function PanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18' }))
    }

    function ProxyPanel() {
      const [status, setStatus] = React.useState(null)
      const [nodes, setNodes] = React.useState(null)
      const [group, setGroup] = React.useState('')
      const [delays, setDelays] = React.useState({})
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('/dsh-proxy/status')
          setStatus(next)
          setError('')
          if (!next.running) { setNodes(null); return }
          const n = await call('/dsh-proxy/nodes', { limit: 200 })
          setNodes(n)
          setGroup((prev) => prev || (n.groups || []).find((g) => g.name.startsWith('[sub]'))?.name || n.groups?.[0]?.name || '')
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const id = setInterval(() => { void refresh() }, 6000)
        return () => clearInterval(id)
      }, [refresh])

      const act = async (label, path, body) => {
        setBusy(label)
        try {
          await call(path, body || {})
          await refresh()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const activeGroup = (nodes?.groups || []).find((g) => g.name === group)

      const testGroup = async () => {
        if (!group) return
        setBusy('test')
        try {
          const out = await call('/dsh-proxy/test', { group })
          const map = {}
          for (const r of out.nodes || []) map[r.name] = r.delay == null ? null : r.delay
          setDelays((prev) => Object.assign({}, prev, map))
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const header = h('div', { style: css.header },
        h('div', { style: css.dot(status?.running) }),
        h('h2', { style: css.title }, 'Proxy'),
        h('div', { style: { flex: 1 } }),
        status?.running
          ? h(Btn, { onClick: () => act('stop', '/dsh-proxy/stop'), disabled: busy === 'stop' }, busy === 'stop' ? 'Stopping…' : 'Stop')
          : h(Btn, { primary: true, onClick: () => act('start', '/dsh-proxy/start'), disabled: busy === 'start' }, busy === 'start' ? 'Starting…' : 'Start'),
        h(Btn, { onClick: () => void refresh() }, 'Refresh'))

      const stateText = status ? (status.running ? 'running · ' + (status.version || '') + ' ' + (status.mode || '') : 'stopped') : 'loading…'

      const statusCard = h('div', { style: css.card },
        h('div', { style: css.kv },
          h('div', { style: css.key }, 'State'), h('div', null, stateText),
          h('div', { style: css.key }, 'HTTP proxy'), h('div', { style: css.mono }, status?.httpProxy || '-'),
          h('div', { style: css.key }, 'Controller'), h('div', { style: css.mono }, status?.controller || '-'),
          h('div', { style: css.key }, 'Data dir'), h('div', { style: css.mono }, status?.dataDir || '-'),
          status?.running ? h('div', { style: css.key }, 'Nodes') : null,
          status?.running ? h('div', null, (status.nodeCount || 0) + ' · ' + (status.groups?.length || 0) + ' groups') : null,
          status?.core ? h('div', { style: css.key }, 'Core') : null,
          status?.core ? h('div', { style: css.mono }, status.core) : null))

      const subs = status?.subscriptions || []
      const subsCard = subs.length
        ? h('div', { style: css.card },
            h('h3', { style: css.h3 }, 'Subscriptions'),
            subs.map((s) => h('div', { key: s.id, style: css.row },
              h('span', { style: css.node }, s.id),
              h('span', { style: css.muted }, 'every ' + Math.round((s.interval || 3600) / 60) + ' min'),
              h('span', { style: Object.assign({}, css.mono, css.muted) }, s.url))))
        : null

      const groups = nodes?.groups || []
      const nodeRow = (name) => h('div', {
        key: name,
        style: Object.assign({}, css.row, {
          cursor: 'pointer',
          background: activeGroup && name === activeGroup.now ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        }),
        onClick: () => act('select', '/dsh-proxy/select', { group, node: name }),
      },
        h('span', { style: css.node, title: name }, name),
        h('span', { style: css.delay(delays[name]) }, delays[name] == null ? '—' : delays[name] + ' ms'))

      const groupsCard = groups.length
        ? h('div', { style: css.card },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
              h('h3', { style: Object.assign({}, css.h3, { margin: 0, flex: 1 }) }, 'Groups'),
              h('select', {
                value: group,
                onChange: (e) => setGroup(e.target.value),
                style: { background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6, padding: '4px 6px', fontSize: 12, maxWidth: 260 },
              }, groups.map((g) => h('option', { key: g.name, value: g.name }, g.name + ' (' + g.memberCount + ')'))),
              h(Btn, { onClick: testGroup, disabled: busy === 'test' }, busy === 'test' ? 'Testing…' : 'Test')),
            activeGroup ? h('div', null, activeGroup.members.map(nodeRow)) : null)
        : h('div', { style: css.card },
            h('h3', { style: css.h3 }, 'Nodes'),
            h('div', { style: css.muted }, status?.running ? 'Loading nodes…' : 'Start the core to inspect nodes and switch the active one.'))

      return h('div', { style: css.root },
        header,
        error ? h('div', { style: css.err }, error) : null,
        statusCard,
        subsCard,
        groupsCard)
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 90,
        label: () => 'Proxy',
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
