# 守夜人 · Nightwatch

**守夜人网络攻击防御 agent。一个独立项目，不是 外部项目的功能。**

- 中文：守夜人（网络攻击防御 agent）
- 英文：**Nightwatch**（目录、包名、代码里用这个）
- 目录：`nightwatch`
- 包：`@nightwatch/agent`、`@nightwatch/host`
- 仓库：<https://github.com/Yilanchia/NightWatch>

它只读采集这台机器，把历史写成只追加的证据日志，每天说清楚"变了什么、为什么值得看"；每条结论都带证据。执行能力只有一条很窄的路，且**不建议现在启用**（见"现状"）。

## Contributors

守夜人是人与 AI 结对完成的：

- **Yilanchia** — 项目主人：目标、边界、验收与发布决定
- **DeepSeek Harness**（AI 结对）— 实现、测试、部署与文档，按主人确认的方案执行

详细分工见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

## 与 外部项目 的边界

| | 边界 | 具体是什么 |
|---|---|---|
| 代码 | 独立仓库 | 代码只在 `nightwatch`；不再往 `fairy-framework` 写 |
| 依赖 | 只共享 guard | 唯一共享的是 `@fairy/guard`（`link:` 只读消费，不在那边开发） |
| 数据 | 各存各的 | 证据在 `.nightwatch-home/`，不写 `.fairy-home/` |
| 进程 | 独立宿主 | 自己的 profile `nightwatch`、端口 3091、bundle `@nightwatch/host` |
| 叙事 | 不同产品 | 一个讲"盯着这台机器"，一个讲"陪着你" |

依赖方向单向：Nightwatch 依赖 guard，guard 不知道 Nightwatch 存在。

## 现状（2026-11-18，v0.2.0 候选）

**已经具备**：只读采集（端口 / SSH / 备份）、`watch.jsonl` + SQLite 视图、基线/差分、日报、修复提案、窄执行（三种 SSH 改行，过 guard）；**无模型巡检入口** `nightwatch tick`——采集 → 落盘 → 规则 → 状态复核 → 日报，全程不依赖 DSH 会话或模型；**内置调度** `nightwatch daemon`（单实例写锁、重启补跑一次、不重叠、SIGTERM 立即停）；**run 记录与健康查询**（`watch_health` / `nightwatch health`）；**时间线** `watch_timeline` / `nightwatch timeline`；**只读面板** `nightwatch panel`（本地 HTTP + 单页，SSH 隧道访问，无写接口，可开多端防护网视图）；**跨端摘要与协调端**（节点身份 + `export` / `verify` / `register` / `ingest` / `correlate` / `pull-correlate`，证据不出节点）；**确定性告警队列 + 告警纪律**（`alerts.ts` / `notify.ts`：分级、限频、安静时段、升级、投影脱敏、可插拔 sink）；**出站推送 stage 1**（`httpsSink`，纯内置 `node:https`，json / wecom / feishu / text）；**最小宿主** `@nightwatch/standalone` + 强制力探针 + 插件级 PDP；**有界调查** `@nightwatch/analyst` + investigator（预算、UNTRUSTED 前缀、推断注释）；**一次性审批**（owner key 绑定提案/变更/文件状态，防重放）。

**两台 Linux 验收机**已上线（2026-11-17）：
`NODE_A_IP`（node A，协调端 + 节点）与 `NODE_B_IP`（node B，节点；同机博客/外部项目 只读不碰），
各自内置 `daemon` 每 24h 巡检。v0.2.0 的发布门槛是 node B 连续 5 个干净每日记录（详见
[docs/发布-v0.2.0.md](docs/发布-v0.2.0.md)）。v0.1.0 的 7 天验收见 [docs/发布-2026-11-17.md](docs/发布-2026-11-17.md)。

**已知问题**：

1. ~~日报不跑规则~~：已修。`watch_report` / `nightwatch tick` 都走完整巡检管线，首次直接要日报也会发现当前风险；
2. ~~采集失败被写成消失~~：已修。`Observation` 带 `status` + `error`，报告有“检查盲区”“原因”和“数据已过期”；旧数据不冒充当前；
3. ~~监听范围扩大 / 等量换公钥漏报~~：已修。前者报 `listen_scope_expanded`，后者比指纹集合差；
4. ~~发现只有去重、没有生命周期~~：已修。sustained / resolved / recurrence 都有记录，跨重启从日志重放；
5. ~~崩溃尾行粘连~~：已修。半行隔离到 `.torn-*`，中间损坏和重复 ID 直接报错，单写者锁；
6. ~~历史日报混入当前~~：已修。按目标日期取当时的观测/基线/发现。

所以现在它是**可无模型跑一轮、有健康记录与时间线的闭环原型**；还不是“常驻守夜闭环”（内置调度与恢复语义仍在做）。完整评审见 [项目评审-2026-11-09.md](项目评审-2026-11-09.md)，改造方案见 [docs/DSH改造与后续实施方案.md](docs/DSH改造与后续实施方案.md)，本轮记录见 [docs/2026-11-09-工作记录.md](docs/2026-11-09-工作记录.md)。

## 多端值守（两台真机）

跨端**只走 SSH + 签名摘要**，不走那个非 TLS 的 HTTP 传输原型；bundle 不含 facts / evidence / detail。

```bash
# 节点侧：导出签名摘要（无原始证据）
node scripts/nightwatch.mjs export /var/lib/nightwatch 7

# 协调端：按 nodes.json 用 SSH 拉各节点摘要 → 登记 → 摄入 → 关联
node scripts/nightwatch.mjs pull-correlate /var/lib/nightwatch-coord/nodes.json
# 跨端高危时退出码 2；systemd 用 SuccessExitStatus=2 当信号而不是失败
```

`nodes.json` 形如（自己复制一份私有配置，别提交真 IP / key）：

```json
{
  "stateFile": "/var/lib/nightwatch-coord/coordinator-state.json",
  "bundleDir": "/var/lib/nightwatch-coord/bundles",
  "nodes": [
    { "id": "acceptance", "local": true, "home": "/var/lib/nightwatch", "days": 7 },
    { "id": "blog", "ssh": "root@NODE_B_IP", "home": "/var/lib/nightwatch",
      "codeDir": "/opt/nightwatch", "key": "/root/.ssh/nightwatch_coord", "days": 7 }
  ]
}
```

安全约定：

- node A → node B 的 key 在 node B 的 `authorized_keys` 里锁成
  `command="… export …",no-pty,no-agent-forwarding,no-port-forwarding`——只能读摘要。
- 协调端状态 `coordinator-state.json` 是唯一汇总，可从 bundle 重建，不手工改；
  `ingestBundle` 拒绝更旧序号，重放/乱序进不来。
- 面板多端视图：`NIGHTWATCH_COORD_STATE=<coordinator-state.json> node scripts/nightwatch.mjs panel …`，
  单页里多出"多端防护网"区（节点清单 + 跨节点关联 + 跨端高危高亮）。
- 推送默认不外发：没配 `NIGHTWATCH_PUSH_URL` 时 sink 只写本地文件；接了 webhook 才出网。

## 跑起来

```powershell
pnpm install
npx tsc -b

# 一次性验证：临时 home 里真实起一次
node scripts/nightwatch.mjs smoke

# 无模型巡检（不需要 DSH、不需要 API key）
node scripts/nightwatch.mjs baseline nightwatch-home
node scripts/nightwatch.mjs tick nightwatch-home      # 0 正常 / 2 部分 / 1 失败
node scripts/nightwatch.mjs health nightwatch-home
node scripts/nightwatch.mjs timeline nightwatch-home tcp:22

# 常驻：自己的 home、自己的端口
node scripts/nightwatch.mjs web
```

home 默认 `.nightwatch-home/`（已 gitignore）：

| 路径 | 是什么 | 能不能删 |
|---|---|---|
| `watch.jsonl` | 这台机器的历史，只追加 | 绝对不能 |
| `watch.db` | SQLite 视图，启动时从日志重建 | 可以 |
| `watch-reports/` | 每日 Markdown 日报 | 可以 |
| `audit.jsonl` | guard 的审计 | 不要删 |

备份检查默认没有路径，在 `profiles/nightwatch/cordis.patch.yml` 里补：

```yaml
- id: nightwatch-agent
  config:
    backupPaths: ['backups', '/var/backups']
    backupStaleHours: 36
```

## 工具

| 工具 | 做什么 |
|---|---|
| `watch_baseline` | 采一次，记为"以后都跟它比" |
| `watch_diff` | 再采一次，和基线比，记新发现 |
| `watch_report` | 写某天的 Markdown 日报 |
| `watch_propose_fix` | 对一条发现产出修复计划（改哪行、风险、回滚、验证） |
| `watch_health` | 最近一轮 / 最近全绿、盲区、数据过期、未运行项 |
| `watch_timeline` | 按 key + 时间窗回放：读到 / 发现 / 仍存在 / 已恢复，缺口照实说 |
| `watch_apply_fix` | 应用计划（仅三种 SSH 改行；guard 判 destructive；备份/校验/回滚；不 reload）。**默认不注册**，`applyFix: true` 才出现 |

## 命令行（无模型）

`tick` 直接调用 `packages/nightwatch-agent/src/inspect.ts`，不 import DSH、不建会话、不请求模型。

| 命令 | 做什么 |
|---|---|
| `node scripts/nightwatch.mjs baseline <home>` | 采一次并记为基线——明确的主人的动作；有盲区时拒绝，不存半份基线 |
| `node scripts/nightwatch.mjs tick <home>` | 跑一轮完整巡检，写当天的日报；`0` 正常 / `2` 部分未读全 / `1` 失败 |
| `node scripts/nightwatch.mjs health <home>` | 最近一轮 / 最近全绿、盲区、数据过期、未运行项 |
| `node scripts/nightwatch.mjs timeline <home> <key> [days]` | 回放一个事实的时间线（默认 7 天） |
| `node scripts/nightwatch.mjs daemon <home> [minutes]` | 内置调度：前台常驻，单实例写锁，重启补跑一次 |
| `node scripts/nightwatch.mjs export <home> [days]` | 输出签名摘要（发现 + 健康，不含原始事实） |
| `node scripts/nightwatch.mjs verify <bundle.json>` | 校验摘要签名与节点 ID |
| `node scripts/nightwatch.mjs ingest <state.json> <bundle.json>` | 协调端：验签并幂等摄入（节点须先登记） |
| `node scripts/nightwatch.mjs register <state.json> <bundle.json>` | 显式登记节点公钥与能力 |
| `node scripts/nightwatch.mjs serve <state.json> [port] [host]` | 协调端本地 HTTP（原型，非 TLS） |
| `node scripts/nightwatch.mjs push <url> <bundle.json>` | 把 bundle 推给协调端 |
| `node scripts/nightwatch.mjs correlate <state.json>` | 按事实 key 跨节点关联 |
| `node scripts/nightwatch.mjs analyst <home> "<任务>"` | 有界只读调查（analyst bundle：预算 + 推断注释） |
| `node scripts/nightwatch.mjs approve <home> <proposalId> [minutes]` | 生成一次性审批（绑定提案与文件状态） |
| `node scripts/nightwatch.mjs acceptance <home> [days]` | 发布验收：每日 run/日报 + 从日志重建一致性 |
| `node scripts/nightwatch.mjs panel <home> [port] [host]` | 只读面板（默认 127.0.0.1:3092，SSH 隧道访问） |
| `node scripts/nightwatch.mjs investigate <home> [limit]` | 消费 pending 队列（analyst 只读调查；失败保留） |
| `node scripts/nightwatch.mjs alerts <home> [ack <id>]` | 列出/确认确定性告警 |
| `node scripts/nightwatch.mjs notify <home>` | 按告警纪律（分级/限频/安静时段/升级）发送待发高危告警；默认只写本地文件 |
| `node scripts/nightwatch.mjs pull-correlate <nodes.json>` | 本地：SSH 拉各节点签名摘要 → 登记/摄入 → 跨节点关联；跨端高危退出码 2 |
| `node scripts/nightwatch.mjs version` | 打印版本 |
| `node scripts/nightwatch.mjs selfcheck` | 启动最小宿主：强制力探针（工具面 / 拒绝门 / 名称盲区）+ PDP |
| `node scripts/egress-probe.mjs` | 出口投影探针：假模型端点 + canary，正反两组 |
| `node scripts/nightwatch.mjs smoke` | 临时 home 里真实启动一次宿主 |

## 代码结构

```
nightwatch
├─ packages/nightwatch-agent   @nightwatch/agent   采集、存储、规则、报告、提案/执行、告警、协调端
│  └─ src/inspect.ts          巡检管线（不 import DSH；tick 直接调用）
│  └─ src/health.ts           采集健康：ok / partial / failed
│  └─ src/notify.ts           告警纪律 + 投影脱敏 + sink（console/file/https）
│  └─ src/coordinator.ts      跨端：验签、登记、幂等摄入、按 key 关联
│  └─ src/panel.ts            只读面板（含多端防护网视图）
├─ packages/nightwatch-host    @nightwatch/host    宿主 bundle：guard + agent
├─ scripts/nightwatch.mjs     启动器：自己的 home / profile / 端口；含 tick / baseline
├─ docs/nightwatch.md         配置、数据与安全边界
└─ ...                        构思稿、调研、评审、DSH 方案（历史与设计材料）
```

## 路线图（按评审第一阶段）

1. **现行规格**：只读、无模型巡检、执行默认关闭、第一台 Linux 验收机；
2. **修 P0**：日报跑规则 + 持续风险、采集健康状态、两种漏报、发现生命周期、日志恢复协议；
3. **`nightwatch tick`**：无对话、无模型、可被 cron/systemd 调用的完整巡检；
4. **`watch_timeline`**：按资产和时间窗查历史变化与证据缺口；
5. 之后才考虑 osquery / Sigma / 多机；eBPF 和社区同步继续后置。

## 设计材料

- [外部项目-Watch-构思-v2.md](外部项目-Watch-构思-v2.md)：最初的设计与外部调研（项目当时叫 Nightwatch）
- [docs/发布-2026-11-17.md](docs/发布-2026-11-17.md)：v0.1.0 发布记录、7 天验收证据与已知限制
- [agent-memory-调研.md](agent-memory-调研.md)：记忆系统调研
- [项目评审-2026-11-09.md](项目评审-2026-11-09.md)：GPT 的代码级评审

## 一句话

管家负责"我陪着你"，守夜人负责"这台机器我盯着"。它们可以互相认识，但各住各的。
