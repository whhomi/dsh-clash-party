const text = (s) => [{ type: 'text', text: s }]

/** Tool results cross the PTC channel as lossless JSON: undefined members and NaN are dropped here. */
const lossless = (value) => JSON.parse(JSON.stringify(value ?? null))

const T = (name, description, parameters, run, extra = {}) => ({
  name,
  description,
  parameters: { type: 'object', additionalProperties: false, ...parameters },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => text(JSON.stringify(value, null, 2)),
  },
  isConcurrencySafe: () => true,
  timeoutMs: 120000,
  async execute(args, exec) {
    return lossless(await run(args, exec))
  },
  ...extra,
})

export function registerTools(ctx, runtime) {
  const disposers = []

  disposers.push(ctx.tools.register(T(
    'proxy_status',
    'Report the self-hosted mihomo core state: whether it runs, its ports, config path, node/group counts, and the current selection.',
    {},
    async () => runtime.status(),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_start',
    'Start the self-hosted mihomo core (composes the config from the bootstrap file, subscriptions and imported nodes first).',
    {},
    async () => runtime.start(),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_stop',
    'Stop the self-hosted mihomo core.',
    {},
    async () => runtime.stop(),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_nodes',
    'List proxy groups and nodes of the running core, including subscription providers and their health.',
    {
      properties: {
        group: { type: 'string', description: 'Only return this group and its members.' },
        limit: { type: 'number', description: 'Max nodes to list per group (default 30).' },
      },
    },
    async (args) => runtime.nodes(args ?? {}),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_select',
    'Select the active node of a proxy group (for example the main selector or a subscription group).',
    {
      properties: {
        group: { type: 'string', required: true, description: 'Group name.' },
        node: { type: 'string', required: true, description: 'Member node name.' },
      },
      required: ['group', 'node'],
    },
    async ({ group, node }) => runtime.select(group, node),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_test',
    'Run delay tests: test named nodes, a whole provider, or the members of a group. Returns latency per node.',
    {
      properties: {
        nodes: { type: 'array', items: { type: 'string' }, description: 'Node names to test.' },
        provider: { type: 'string', description: 'Provider id to health-check (default: all configured subscriptions).' },
        group: { type: 'string', description: 'Test every member of this group.' },
        url: { type: 'string', description: 'Test URL (default http://www.gstatic.com/generate_204).' },
      },
    },
    async (args) => runtime.test(args ?? {}),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_import',
    'Import single nodes (ss/trojan/vmess/vless/hysteria2/tuic URIs, one per line or a base64 blob) into the proxy data directory; returns the parsed nodes and whether the core was reloaded.',
    {
      properties: {
        uris: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Node URIs; each entry may itself hold multiple newline-separated URIs.',
        },
        replace: { type: 'boolean', description: 'Replace the imported set instead of appending (default false).' },
      },
      required: ['uris'],
    },
    async (args) => runtime.importNodes(args ?? {}),
  )))

  disposers.push(ctx.tools.register(T(
    'proxy_refresh',
    'Pull every configured subscription again (through the running core) and hot-reload the core so the fresh nodes join.',
    {},
    async () => runtime.refresh(),
  )))

  return () => { for (const d of disposers) { try { d?.() } catch {} } }
}
