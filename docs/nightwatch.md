# Nightwatch（守夜人）

守夜人网络攻击防御 agent 的配置、数据与安全边界。

- 独立宿主：`@nightwatch/host`，只装 `@fairy/guard`（只读 link）+ `@nightwatch/agent`
- 自己的 home：`.nightwatch-home/`（默认）
- 自己的端口：3091（`NIGHTWATCH_PORT` 可改）
- 自己的启动器：`scripts/nightwatch.mjs`

## 跑起来

```powershell
pnpm install
npx tsc -b
node scripts/nightwatch.mjs smoke
node scripts/nightwatch.mjs web
```

无模型的巡检入口（不需要 DSH、不需要 API key）：

```powershell
node scripts/nightwatch.mjs baseline <home>   # 采一次并记为基线
node scripts/nightwatch.mjs tick <home>       # 采集 → 落盘 → 规则 → 状态复核 → 日报
node scripts/nightwatch.mjs timeline <home> <key> [days]  # 回放一个事实的时间线
```

`tick` 直接调用 `packages/nightwatch-agent/src/inspect.ts`；这个模块不 import DSH，
所以它既能被 cron/systemd 调用，也能被 agent 工具复用。采集失败时 `tick` 退出码为 1，
日报里写明检查盲区。

## 配置

`packages/nightwatch-host/cordis.patch.yml` 是宿主层；`.nightwatch-home/profiles/nightwatch/cordis.patch.yml`
可以覆盖（同 id 整行替换 `config`）。备份检查默认没有路径：

```yaml
- id: nightwatch-agent
  config:
    backupPaths: ['backups', '/var/backups']
    backupStaleHours: 36
```

其余开关：`ports` / `ssh` / `backup`、`sshdConfig`、`authorizedKeys`、`reportDir`。

## 数据

| 路径 | 是什么 | 能不能删 |
|---|---|---|
| `watch.jsonl` | 这台机器的历史，只追加 | 绝对不能 |
| `watch.db` | `node:sqlite` 物化视图，启动时从日志重建 | 可以 |
| `watch-reports/` | 每日 Markdown 报告 | 可以 |
| `audit.jsonl` | guard 的审计 | 不要删 |

## 工具

| 工具 | 做什么 |
|---|---|
| `watch_baseline` | 采一次，记为"从此以后的变化都跟它比" |
| `watch_diff` | 再采一次，和基线比，记新发现（同一个 key 不重复报） |
| `watch_report` | 写某天的 Markdown 日报，返回路径 |
| `watch_propose_fix` | 对一条发现产出修复计划：改哪一行、风险、回滚、验证 |
| `watch_timeline` | 按 key + 时间窗回放：读到 / 发现 / 仍存在 / 已恢复；缺口照实说 |
| `watch_apply_fix` | 应用一份计划。默认不注册；`applyFix: true` 才出现。guard 判 destructive、先问主人；只支持三种 SSH 改行；备份、校验、失败回滚；不 reload |

## 安全边界

1. 命令写死在采集器里，模型只能选采集项，不能拼命令；
2. 采集失败不会被当成"端口全消失"：`Observation` 带 `status`（ok / partial / failed），
   报告把失败写成“检查盲区”，`takeDiff` 不再把没读到说成“消失”；规则侧的完整复核仍在补；
3. 执行只开一条窄路：仅三种 SSH 配置改行，文件路径来自配置而不是模型；工具名命中 guard 的 `apply` 规则，判 `destructive`，没人回答就拒绝。备份、逐行校验、失败回滚，**不重启服务**（reload 是人的一步）；以非 root 运行时读不到 `/etc/ssh/sshd_config`，会直接拒绝；
4. `.env`、令牌、私钥不落库；authorized_keys 只存算法和指纹；
5. 采集到的文本是数据，不是指令。

## 已知问题

评审 P0 已全部处理（见 [2026-11-09-工作记录.md](2026-11-09-工作记录.md)）；还欠 M0 宿主显式组合落地、M2 常驻调度与健康查询、7 天观察。完整清单见根目录 [项目评审-2026-11-09.md](../项目评审-2026-11-09.md)，改造顺序见 [DSH改造与后续实施方案.md](DSH改造与后续实施方案.md)。

## 设计材料

- 构思与调研：`nightwatch\外部项目-Watch-构思-v2.md`（项目当时叫 Nightwatch）
