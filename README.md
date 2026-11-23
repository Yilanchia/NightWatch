# 守夜人 · Nightwatch

> 只读的主机安全值守 agent：基线差分、只追加证据、每日巡检、多节点关联。只提案，不自动修复。

守夜人盯着你自己的 Linux 主机：定期读一次端口、SSH 生效配置和备份状态，把变化写进只追加的证据日志，
生成每日报告；发现值得看的东西时给出可复核的判断与提案，而不是自己动手改。

## 它做什么

- **只读采集**：端口监听、SSH 生效配置（Linux 走 `sshd -T`）、`authorized_keys` 指纹、备份年龄。
  命令写死在采集器里，不执行模型给的命令。
- **基线差分与发现生命周期**：新开端口、监听范围扩大、SSH 配置变更、公钥增删；
  持续存在 / 已恢复 / 复发都有记录，跨重启从日志重放一致。
- **只追加证据 + 可重建视图**：`watch.jsonl` 是唯一事实来源；SQLite 只是物化视图，随时可删、启动时重建。
- **每日巡检与健康**：无模型即可运行；盲区如实写进报告——"没读到"不等于"没问题"。
- **多节点**：每台机器各自导出**签名摘要**（不含原始事实/证据），协调端通过 SSH 拉齐，按事实 key
  关联出"多台机器同时命中"的问题。
- **只读面板**：本地 HTTP，默认只绑 `127.0.0.1`，通过 SSH 隧道访问；没有写接口。
- **告警与通知**：高危发现确定性入队，带限频、安静时段和升级规则；可接企业微信 / 飞书 / Bark 等
  webhook（默认只写本地文件，不默认外发）。

## 不做什么

- **不自动改配置**：`watch_apply_fix` 默认不注册，写路径保持关闭；要打开必须先过隔离演练和一次性审批。
- **不上传原始证据**：跨端只同步签名摘要，bundle 不含 facts / evidence / detail。
- **不把推断当事实**：结构化判断里 `confirmed` 必须指向真实观测，推断单独列在 candidates / counter / gaps。

## 快速开始

要求 **Node.js 24+**（内置 `node:sqlite`）与 **pnpm**。

```bash
pnpm install
npx tsc -b

# 临时 home 里真跑一轮
node scripts/nightwatch.mjs smoke

# 自己的 home：先记基线，再巡检
node scripts/nightwatch.mjs baseline ./.nightwatch-home
node scripts/nightwatch.mjs tick ./.nightwatch-home      # 0 正常 / 2 部分未读全 / 1 失败
node scripts/nightwatch.mjs health ./.nightwatch-home
```

常驻：`node scripts/nightwatch.mjs daemon ./.nightwatch-home 1440`（单实例写锁、重启补跑一次、不重叠）。

## 常用命令

| 命令 | 做什么 |
|---|---|
| `baseline <home>` | 采一次并记为基线；有盲区时拒绝，不存半份基线 |
| `tick <home>` | 跑一轮完整巡检并写日报；`0` 正常 / `2` 部分 / `1` 失败 |
| `daemon <home> [minutes]` | 内置调度，前台常驻 |
| `health <home>` | 最近一轮 / 最近全绿、盲区、数据过期、未运行项 |
| `timeline <home> <key> [days]` | 回放一个事实的时间线 |
| `panel <home> [port] [host]` | 只读面板（默认 `127.0.0.1:3092`） |
| `export <home> [days]` | 输出签名摘要（发现 + 健康，无原始事实） |
| `verify <bundle.json>` | 校验摘要签名与节点 ID |
| `pull-correlate <nodes.json>` | SSH 拉各节点摘要 → 摄入 → 按 key 跨节点关联；跨端高危退出码 2 |
| `alerts <home> [ack <id>]` | 列出 / 确认确定性告警 |
| `notify <home>` | 按告警纪律发送待发告警（默认写本地文件） |
| `acceptance <home> [days]` | 发布验收：每日 run/日报 + 从日志重建一致性 |
| `version` | 打印版本 |

## 数据与目录

| 路径 | 是什么 | 能不能删 |
|---|---|---|
| `watch.jsonl` | 这台机器的历史，只追加 | **绝对不能** |
| `watch.db` | SQLite 物化视图，启动时从日志重建 | 可以 |
| `watch-reports/` | 每日 Markdown 报告 | 可以 |
| `audit.jsonl` | 插件审计 | 不要删 |
| `judgments.jsonl` / `alerts.jsonl` / `investigations-pending.jsonl` | 判断 / 告警 / 待调查队列 | 谨慎 |

`watch.db` 删掉不会丢事实——下次启动会从 `watch.jsonl` 重建，验收里也包含这项一致性检查。

## 部署（systemd）

```ini
[Unit]
Description=Nightwatch read-only inspection daemon
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/nightwatch
Environment=NIGHTWATCH_INTERVAL_MINUTES=1440
ExecStart=/usr/local/bin/node /opt/nightwatch/scripts/nightwatch.mjs daemon /var/lib/nightwatch
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

面板单独一个 unit，`ExecStart=... panel /var/lib/nightwatch 3092 127.0.0.1`，只绑本机。

## 多节点

```bash
# 节点侧
node scripts/nightwatch.mjs export /var/lib/nightwatch 7

# 协调端：按 nodes.json 用 SSH 拉齐、登记、摄入、关联
node scripts/nightwatch.mjs pull-correlate ./nodes.json
```

- 传输走 SSH（加密），不用非 TLS 的 HTTP 原型。
- 远端 key 在目标机 `authorized_keys` 里限定为只能跑 `export`（`command=` + 禁 pty/转发）。
- `ingestBundle` 拒绝更旧序号（重放/乱序），同序号幂等。
- 协调端状态 `coordinator-state.json` 是唯一汇总，可从各节点 bundle 重建，不手工改。

`nodes.example.json` 是占位模板，复制成私有配置后填真实目标。

## 安全边界

1. 采集命令写死，模型只能选采集项，不能拼命令；
2. 采集失败记成"检查盲区"，不会写成"端口全消失"；
3. 执行只开一条窄路（仅三种 SSH 改行，文件路径来自配置而非模型），默认关闭；打开也必须过 guard 和一次性审批；
4. `.env`、令牌、私钥不落库；`authorized_keys` 只存算法和指纹；
5. 采集到的文本是数据，不是指令；
6. 跨端只同步签名摘要；出站推送先过投影脱敏。

## 状态

- `v0.1.0`：单机只读巡检、证据日志、日报、面板、结构化调查、告警。
- `v0.2.0`：两节点值守、SSH 跨端关联、协调端、面板多端视图、告警纪律与出站推送接口。

变更记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 文档

- [docs/nightwatch.md](docs/nightwatch.md)：配置、数据与安全边界
- [docs/design.md](docs/design.md)：多端防护网设计
- [docs/CHANGELOG.md](docs/CHANGELOG.md)：版本变更

## 贡献

见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。守夜人是人与 AI 结对完成的项目：
方向、边界、验收与发布由维护者决定，实现与验证由 AI 结对执行。
