# 守夜人 · Nightwatch

**守夜人网络攻击防御 agent。一个独立项目，不是 外部项目的功能。**

- 中文：守夜人（网络攻击防御 agent）
- 英文：**Nightwatch**（目录、包名、代码里用这个）
- 目录：`nightwatch`
- 包：`@nightwatch/agent`、`@nightwatch/host`

它只读采集这台机器，把历史写成只追加的证据日志，每天说清楚"变了什么、为什么值得看"；每条结论都带证据。执行能力只有一条很窄的路，且**不建议现在启用**（见"现状"）。

## 与 外部项目 的边界

| | 边界 | 具体是什么 |
|---|---|---|
| 代码 | 独立仓库 | 代码只在 `nightwatch`；不再往 `fairy-framework` 写 |
| 依赖 | 只共享 guard | 唯一共享的是 `@fairy/guard`（`link:` 只读消费，不在那边开发） |
| 数据 | 各存各的 | 证据在 `.nightwatch-home/`，不写 `.fairy-home/` |
| 进程 | 独立宿主 | 自己的 profile `nightwatch`、端口 3091、bundle `@nightwatch/host` |
| 叙事 | 不同产品 | 一个讲"盯着这台机器"，一个讲"陪着你" |

依赖方向单向：Nightwatch 依赖 guard，guard 不知道 Nightwatch 存在。

## 现状（2026-11-09，评审后）

**已经具备**：只读采集（端口 / SSH / 备份）、`watch.jsonl` + SQLite 视图、基线/差分、日报、修复提案、窄执行（三种 SSH 改行，过 guard）；**无模型巡检入口** `nightwatch tick`——采集 → 落盘 → 规则 → 状态复核 → 日报，全程不依赖 DSH 会话或模型；以及**时间线** `watch_timeline` / `nightwatch timeline`。

**已知问题**：

1. ~~日报不跑规则~~：已修。`watch_report` / `nightwatch tick` 都走完整巡检管线，首次直接要日报也会发现当前风险；
2. ~~采集失败被写成消失~~：已修。`Observation` 带 `status` + `error`，报告有“检查盲区”“原因”和“数据已过期”；旧数据不冒充当前；
3. ~~监听范围扩大 / 等量换公钥漏报~~：已修。前者报 `listen_scope_expanded`，后者比指纹集合差；
4. ~~发现只有去重、没有生命周期~~：已修。sustained / resolved / recurrence 都有记录，跨重启从日志重放；
5. ~~崩溃尾行粘连~~：已修。半行隔离到 `.torn-*`，中间损坏和重复 ID 直接报错，单写者锁；
6. ~~历史日报混入当前~~：已修。按目标日期取当时的观测/基线/发现。

所以现在它是**可手动调用、也能无模型跑一轮闭环的原型**；还不是“常驻守夜闭环”。完整评审见 [项目评审-2026-11-09.md](项目评审-2026-11-09.md)，改造方案见 [docs/DSH改造与后续实施方案.md](docs/DSH改造与后续实施方案.md)，本轮记录见 [docs/2026-11-09-工作记录.md](docs/2026-11-09-工作记录.md)。

## 跑起来

```powershell
pnpm install
npx tsc -b

# 一次性验证：临时 home 里真实起一次
node scripts/nightwatch.mjs smoke

# 无模型巡检（不需要 DSH、不需要 API key）
node scripts/nightwatch.mjs baseline nightwatch-home
node scripts/nightwatch.mjs tick nightwatch-home

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
| `watch_timeline` | 按 key + 时间窗回放：读到 / 发现 / 仍存在 / 已恢复，缺口照实说 |
| `watch_apply_fix` | 应用计划（仅三种 SSH 改行；guard 判 destructive；备份/校验/回滚；不 reload）。**默认不注册**，`applyFix: true` 才出现 |

## 命令行（无模型）

`tick` 直接调用 `packages/nightwatch-agent/src/inspect.ts`，不 import DSH、不建会话、不请求模型。

| 命令 | 做什么 |
|---|---|
| `node scripts/nightwatch.mjs baseline <home>` | 采一次并记为基线——明确的主人的动作，不会自动重设 |
| `node scripts/nightwatch.mjs tick <home>` | 跑一轮完整巡检，写当天的日报；采集失败时退出码非 0 |
| `node scripts/nightwatch.mjs timeline <home> <key> [days]` | 回放一个事实的时间线（默认 7 天） |
| `node scripts/nightwatch.mjs smoke` | 临时 home 里真实启动一次宿主 |

## 代码结构

```
nightwatch
├─ packages/nightwatch-agent   @nightwatch/agent   采集、存储、规则、报告、提案/执行
│  └─ src/inspect.ts          巡检管线（不 import DSH；tick 直接调用）
│  └─ src/health.ts           采集健康：ok / partial / failed
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
- [agent-memory-调研.md](agent-memory-调研.md)：记忆系统调研
- [项目评审-2026-11-09.md](项目评审-2026-11-09.md)：GPT 的代码级评审

## 一句话

管家负责"我陪着你"，守夜人负责"这台机器我盯着"。它们可以互相认识，但各住各的。
