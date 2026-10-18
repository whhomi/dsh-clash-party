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

    const M = {
      page: {
        display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)', fontSize: 13, overflow: 'hidden',
      },
      toolbar: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px',
        borderBottom: '1px solid var(--dsw-alias-border-l3)', flex: 'none', flexWrap: 'wrap',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      dot: (on) => ({ width: 8, height: 8, borderRadius: 4, background: on ? '#2ecc71' : '#9aa0a6', flex: 'none' }),
      spacer: { flex: 1 },
      seg: { display: 'flex', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, overflow: 'hidden' },
      segItem: (active) => ({
        padding: '4px 12px', fontSize: 12, cursor: 'pointer', border: 'none',
        background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'inherit', fontWeight: active ? 600 : 400,
      }),
      btn: (primary) => ({
        border: '1px solid var(--dsw-alias-border-l3)',
        background: primary ? 'var(--dsw-alias-button-elevated-fill)' : 'transparent',
        color: 'inherit', borderRadius: 8, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
      }),
      banner: {
        margin: '12px 18px 0', padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.6,
        border: '1px solid #e74c3c55', background: '#e74c3c18', color: 'var(--dsw-alias-label-primary)',
      },
      metaBar: {
        display: 'flex', gap: 16, flexWrap: 'wrap', padding: '10px 18px', fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l3)',
      },
      chip: { background: 'var(--dsw-alias-interactive-bg-hover)', borderRadius: 6, padding: '2px 8px' },
      body: { display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' },
      groups: {
        width: 190, flex: 'none', borderRight: '1px solid var(--dsw-alias-border-l3)',
        overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 2,
      },
      groupRow: (active) => ({
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', borderRadius: 8,
        cursor: 'pointer', fontSize: 12, background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        fontWeight: active ? 600 : 400,
      }),
      groupName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupBadge: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
      nodesPane: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      searchRow: { padding: '10px 14px 0', display: 'flex', gap: 8, alignItems: 'center' },
      search: {
        flex: 1, padding: '6px 10px', fontSize: 12, borderRadius: 8, color: 'inherit',
        border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', outline: 'none',
      },
      grid: {
        flex: 1, overflowY: 'auto', padding: 14,
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10,
      },
      card: (sel) => ({
        border: `1px solid ${sel ? 'var(--dsw-alias-state-business-primary, #4c8bf5)' : 'var(--dsw-alias-border-l3)'}`,
        background: sel ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        borderRadius: 10, padding: '10px 12px', cursor: 'pointer', display: 'flex',
        alignItems: 'center', gap: 10, minWidth: 0,
      }),
      cardName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: (ms) => ({
        flex: 'none', fontSize: 11, padding: '2px 7px', borderRadius: 6, minWidth: 46, textAlign: 'center',
        color: ms == null ? 'var(--dsw-alias-label-secondary)' : '#fff',
        background: ms == null ? 'var(--dsw-alias-interactive-bg-hover)' : ms < 150 ? '#2ecc71' : ms < 300 ? '#f1c40f' : '#e74c3c',
      }),
      empty: { padding: 24, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    }

    function PanelIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18' }))
    }

    function fmtInterval(seconds) {
      if (!seconds) return '—'
      if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
      return `${Math.round(seconds / 60)} 分钟`
    }

    function ProxyPanel() {
      const [status, setStatus] = React.useState(null)
      const [nodes, setNodes] = React.useState(null)
      const [group, setGroup] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [delays, setDelays] = React.useState({})
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          const next = await call('/dsh-proxy/status')
          setStatus(next)
          setError('')
          if (!next.running) { setNodes(null); return }
          const n = await call('/dsh-proxy/nodes', { limit: 500 })
          setNodes(n)
          setGroup((prev) => {
            const groups = n.groups || []
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
        } finally {
          setBusy('')
        }
      }

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

      const activeGroup = (nodes?.groups || []).find((g) => g.name === group)
      const members = (activeGroup?.members || []).filter((n) => !filter || n.toLowerCase().includes(filter.toLowerCase()))
      const subscription = (status?.subscriptions || [])[0]

      const modeControl = h('div', { style: M.seg },
        [['rule', '规则'], ['global', '全局'], ['direct', '直连']].map(([value, label]) =>
          h('button', {
            key: value,
            style: M.segItem(status?.mode === value),
            onClick: () => act('mode', '/dsh-proxy/mode', { mode: value }),
          }, label)))

      const toolbar = h('div', { style: M.toolbar },
        h('div', { style: M.dot(status?.running) }),
        h('h2', { style: M.title }, '代理'),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          status ? (status.running ? `运行中 · ${status.version || ''}` : '未运行') : '加载中…'),
        h('div', { style: M.spacer }),
        status?.running ? modeControl : null,
        status?.running
          ? h('button', { style: M.btn(false), onClick: testGroup, disabled: busy === 'test' }, busy === 'test' ? '测速中…' : '测速')
          : null,
        status?.running
          ? h('button', { style: M.btn(false), onClick: () => act('refresh', '/dsh-proxy/refresh'), disabled: busy === 'refresh' }, busy === 'refresh' ? '刷新中…' : '刷新订阅')
          : null,
        status?.running
          ? h('button', { style: M.btn(false), onClick: () => act('stop', '/dsh-proxy/stop'), disabled: busy === 'stop' }, busy === 'stop' ? '停止中…' : '停止')
          : h('button', {
              style: M.btn(true),
              onClick: () => act('start', '/dsh-proxy/start'),
              disabled: busy === 'start' || status?.coreMissing,
            }, busy === 'start' ? '启动中…' : '启动'))

      const coreBanner = status?.coreMissing
        ? h('div', { style: M.banner },
            h('b', null, '未找到 mihomo 内核'),
            h('div', null, status.coreHint))
        : null

      const errorBanner = error ? h('div', { style: M.banner }, error) : null

      const metaBar = h('div', { style: M.metaBar },
        h('span', null, '代理地址 ', h('span', { style: M.chip }, status?.httpProxy || '—')),
        h('span', null, '节点 ', h('span', { style: M.chip }, String(status?.nodeCount ?? 0))),
        subscription
          ? h('span', null, '订阅 ',
              h('span', { style: M.chip }, subscription.id),
              subscription.bytes ? ` · ${Math.round(subscription.bytes / 1024)} KB` : ' · 未拉取',
              status?.refreshIntervalSeconds ? ` · 每 ${fmtInterval(status.refreshIntervalSeconds)} 自动刷新` : '')
          : h('span', null, '订阅 ', h('span', { style: M.chip }, '未配置')),
        status?.nextRefreshAt ? h('span', null, '下次刷新 ', h('span', { style: M.chip }, new Date(status.nextRefreshAt).toLocaleTimeString())) : null)

      const groupList = h('div', { style: M.groups },
        (nodes?.groups || []).map((g) => h('div', {
          key: g.name,
          style: M.groupRow(g.name === group),
          onClick: () => setGroup(g.name),
          title: `${g.type} · ${g.memberCount}`,
        },
          h('span', { style: M.groupName }, g.name),
          h('span', { style: M.groupBadge }, String(g.memberCount)))))

      const searchRow = h('div', { style: M.searchRow },
        h('input', {
          style: M.search,
          placeholder: '搜索节点…',
          value: filter,
          onChange: (e) => setFilter(e.target.value),
        }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          `${members.length} / ${activeGroup?.memberCount ?? 0}`))

      const nodeGrid = h('div', { style: M.grid },
        members.map((name) => h('div', {
          key: name,
          style: M.card(name === activeGroup?.now),
          onClick: () => act('select', '/dsh-proxy/select', { group, node: name }),
          title: name,
        },
          h('span', { style: M.cardName }, name),
          h('span', { style: M.badge(delays[name]) }, delays[name] == null ? '—' : `${delays[name]}ms`))))

      const body = nodes?.groups?.length
        ? h('div', { style: M.body }, groupList, h('div', { style: M.nodesPane }, searchRow, nodeGrid))
        : h('div', { style: M.empty },
            status?.running ? '正在加载节点…' : '内核未运行。启动后这里会显示分组与节点列表。')

      return h('div', { style: M.page }, toolbar, coreBanner, errorBanner, metaBar, body)
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
