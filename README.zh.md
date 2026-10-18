# dsh-proxy

[English](README.md) | 中文

给 DeepSeek Harness（DSH）用的**自托管代理插件**：插件自己在宿主进程里托管一个
[mihomo](https://github.com/MetaCubeX/mihomo) 内核，不依赖任何外部代理客户端。

- 订阅：插件通过内核隧道把订阅拉下来写成节点文件，内核只读消费 —— 既绕开被墙的订阅端点，
  也避开子进程的沙箱写限制。
- 单节点：`ss / trojan / vmess / vless / hysteria2 / tuic` 链接直接导入。
- 面板：侧栏 **Proxy** 页，看状态、切节点、测延迟、启停内核。
- 工具：把同一套能力暴露给 agent（`proxy_status` 等）。
- 作用域：只影响**主动指向它**的流量（`http://127.0.0.1:17890`），从不改系统代理，不装 TUN。

## 目录结构

```
dsh-proxy/
├── lib/
│   ├── index.js      插件入口：配置、运行时、生命周期、诊断标记
│   ├── core.js       内核托管：spawn / 探活 / 停止 / geo 资产自举 / REST 客户端
│   ├── compose.js    配置编译：bootstrap 改写 + provider + 单节点注入
│   ├── node-uri.js   节点 URI → mihomo proxy 对象
│   ├── http.js       面板 HTTP 面（宿主路由 + 独立回环服务）
│   └── client.js     浏览器半：侧栏入口 + Proxy 页面
├── test/smoke.mjs    冒烟测试（全部从环境变量取参数）
├── cordis.patch.yml  bundle patch（插件行 + 配置模板）
└── package.json
```

## 安装

### 先准备内核（插件不自带）

本插件**不包含也不分发 mihomo 二进制**，需要你自己装一份：

1. 到 https://github.com/MetaCubeX/mihomo/releases 下载对应平台的压缩包
   （Windows 一般用 `mihomo-windows-amd64-compatible-*.zip`）；
2. 解压后把可执行文件放到插件的数据目录 `bin/` 下，文件名保持 `mihomo.exe`（Windows）/ `mihomo`：

   ```
   <dataDir>/bin/mihomo.exe        # dataDir 默认 $DSH_HOME/proxy
   ```

   或者把它加进 `PATH`，或者在配置里直接写 `corePath: '/绝对路径/mihomo'`；
3. 如果内核启动时找不到 geo 数据，把它从任意 clash/mihomo 安装目录复制到 `<dataDir>/`，
   或设置 `DSH_PROXY_GEO_DIR` 指向有 `Country.mmdb` / `geosite.dat` / `geoip.dat` 的目录。

内核缺失时面板会显示红色提示，把上面三条路径直接写在提示里，`proxy_start` 也会报同样的错。

### 装插件

```bash
dsh plugin --profile <profile> add link:<本目录路径>
```

安装后在 profile 的 `cordis.patch.yml` 里覆盖配置（示例见插件自带的 `cordis.patch.yml`）：

```yaml
- id: dsh-proxy
  name: 'dsh-proxy'
  config:
    enabled: true
    autoStart: true
    httpPort: 17890
    controllerPort: 19090
    panelPort: 17891
    corePath: '/path/to/mihomo'            # 留空则找 <dataDir>/bin/mihomo 或 PATH
    bootstrapConfig: '/path/to/base.yaml'  # 任意 Clash 格式配置，端口/控制器会被改写
    subscriptions:
      - id: airport
        url: 'https://example.com/api/v1/sub?token=...'
        interval: 3600
        userAgent: 'clash-verge/v2.0.0'
        prefix: '[sub] '
    nodes: []
```

重启 DSH 生效。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件不加载任何东西 |
| `autoStart` | `false` | 随 DSH 启动内核 |
| `corePath` | `''` | mihomo 可执行文件；空则 `<dataDir>/bin/mihomo(.exe)` → `PATH` |
| `dataDir` | `$DSH_HOME/proxy` | 配置、节点文件、日志、geo 资产 |
| `httpPort` | `17890` | 内核混合端口（HTTP/SOCKS），也是给外部用的代理地址 |
| `controllerPort` | `19090` | mihomo REST API |
| `panelPort` | `17891` | 面板独立回环服务（不依赖宿主 webserver） |
| `bootstrapConfig` | `''` | 基础 Clash 配置；用于提供初始可用节点 |
| `subscriptions[]` | `[]` | `id / url / interval / userAgent / prefix / mode`；`interval` 单位秒，**默认 3600（60 分钟）** |
| `nodes[]` | `[]` | 节点 URI 列表 |
| `healthCheckUrl` | gstatic 204 | 测速目标 |

## 订阅自动刷新

- 每条订阅默认 **每 60 分钟**自动拉取一次（`interval: 3600`），到点由插件经运行中的内核拉取、
  写文件、再热重载内核；面板顶部显示「每 60 分钟自动刷新」和「下次刷新」时间。
- 想改成别的周期，改 `interval` 即可（单位秒）：

  ```yaml
  subscriptions:
    - id: airport
      url: 'https://example.com/sub?token=...'
      interval: 1800      # 30 分钟
  ```

- 多条订阅同时存在时，按其中**最短**的 `interval` 触发一次统一刷新。
- 也可以随时手动刷新：面板「刷新订阅」按钮，或工具 `proxy_refresh`。

## 三条输入路径

```
订阅 URL ──(插件经内核拉取)──→ providers/<id>.yaml ─┐
单节点 URI ──(解析 + 去重)────────────────────────┤→ 内核 config.yaml → mihomo
bootstrapConfig ──(端口改写/tun 关闭)─────────────┘
```

- 订阅默认 `mode: file`：插件负责拉取与落盘，内核 `type: file` 只读。
  想完全交给内核（联网不受限时）可设 `mode: http`。
- 首次拉取需要一条可用出口：`bootstrapConfig` 里的节点（`♻️自动选择` 这类 url-test 组最好），
  或先用 `proxy_import` 导入一条单节点。

## 工具

| 工具 | 用途 |
|---|---|
| `proxy_status` | 运行状态、端口、节点/分组数、provider 与订阅文件状态 |
| `proxy_start` / `proxy_stop` | 编译配置并启停内核 |
| `proxy_nodes` | 分组与成员、当前选中 |
| `proxy_select` | 切换某组的活动节点 |
| `proxy_test` | 节点 / 分组 / provider 测速（provider 会先补拉订阅文件） |
| `proxy_import` | 导入节点 URI，持久化并热重载 |
| `proxy_refresh` | 重新拉取全部订阅并热重载 |

## 面板

布局参考 clash-party 的代理页：

- **顶部工具栏**：状态点、运行版本、**规则 / 全局 / 直连** 模式切换、测速、刷新订阅、启停
- **信息条**：代理地址、节点数、订阅大小 + 自动刷新周期 + 下次刷新时间
- **左侧分组栏**：分组名 + 成员数，选中项高亮
- **右侧节点区**：搜索框过滤、两列节点卡片、右侧延迟色块（<150ms 绿 / <300ms 黄 / 其它红）、
  当前选中卡片加边框高亮，点击即切换
- 内核缺失时顶部显示红色提示，写清内核应该放到哪里

浏览器半向宿主注册两个槽位：`sidebar.panellist`（图标）与 `main`（页面），
数据走插件自己的 HTTP 面：

- 宿主 `webServer` 上的 `/dsh-proxy/*` 精确路由（存在时）
- 独立回环服务 `127.0.0.1:<panelPort>`（始终启动，Electron 从 `file://` 加载时也能用）

路由：`status`(GET)、`nodes` / `start` / `stop` / `select` / `test` / `import` / `refresh` / `mode`(POST)。

## 让浏览器 / 其他程序走这个代理

插件只提供一个代理端点，不接管系统网络：

- **Chrome（含 chrome-devtools MCP）**：启动参数加 `--proxyServer=http://127.0.0.1:17890`
- **命令行**：`HTTPS_PROXY=http://127.0.0.1:17890 curl https://example.com`
- **DSH 自身请求**：把 `HTTPS_PROXY` 指到该端口（DSH 的 `dsh-http-proxy` 会读环境变量）
- 不要开 TUN、不要写系统代理 —— 那会影响主机上所有程序。

## 运行时产物

```
<dataDir>/
├── config.yaml            内核配置（每次 start / import / refresh 重写）
├── providers/<id>.yaml    订阅节点文件（插件写，内核读）
├── nodes.json             手工导入的节点
├── logs/core.log          内核 stdout/stderr
├── diagnostics.json       本次加载时可见的服务
├── ready.json / routes.json / panel-server.json   加载与注册标记
└── load-error.json        加载失败时的堆栈（正常不存在）
```

geo 资产（`Country.mmdb` / `geosite.dat` / `geoip.dat`）会在启动时从 `DSH_PROXY_GEO_DIR`
或常见的 clash / mihomo 安装目录复制进来；一个都找不到时插件会**快速失败并报错**，
而不是让内核卡在下载上。

## 测试

```bash
DSH_PROXY_CORE=/path/to/mihomo \
DSH_PROXY_BOOTSTRAP=/path/to/base.yaml \
DSH_PROXY_SUB='https://example.com/sub' \
node test/smoke.mjs
```

## 已知边界

- 不支持 `ssr://`、`juicity://`、`anytls://`（会明确报错并跳过）。
- 不做 TUN、不写系统代理、不做开机自启 —— 这些都需要提权，属于系统级安装而非插件。
- 没有内核下载器：需要自备 `mihomo` 可执行文件。
- 面板 UI 目前是只读列表 + 切节点，没有订阅编辑器和规则编辑器。

## 许可

MIT
