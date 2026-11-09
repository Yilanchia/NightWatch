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

**已经具备**：只读采集（端口 / SSH / 备份）、`watch.jsonl` + SQLite 视图、基线/差分、日报、修复提案、窄执行（三种 SSH 改行，过 guard）。

**已知问题（评审 P0，尚未修）**：

1. 日报不跑规则——首次直接要日报会漏掉当前风险；
2. 采集失败被写成"端口消失"；
3. 监听范围扩大（`127.0.0.1` → `0.0.0.0`）和等量换公钥漏报；
4. 发现只有去重，没有生命周期（关闭 / 复发）；
5. 崩溃后的半行日志会和下一条事件粘连，重建时丢失；
6. 历史日报会混入当前观测。

所以现在它是**可手动调用的原型**，不是"常驻守夜闭环"。完整评审见 [项目评审-2026-11-09.md](项目评审-2026-11-09.md)。

## 跑起来

```powershell
pnpm install
npx tsc -b

# 一次性验证：临时 home 里真实起一次
node scripts/nightwatch.mjs smoke

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
| `watch_apply_fix` | 应用计划（仅三种 SSH 改行；guard 判 destructive；备份/校验/回滚；不 reload） |

## 代码结构

```
nightwatch
├─ packages/nightwatch-agent   @nightwatch/agent   采集、存储、规则、报告、提案/执行
├─ packages/nightwatch-host    @nightwatch/host    宿主 bundle：guard + agent
├─ scripts/nightwatch.mjs     启动器：自己的 home / profile / 端口
├─ docs/nightwatch.md         配置、数据与安全边界
└─ ...                        构思稿、调研、评审（历史材料）
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
