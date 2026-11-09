# Nightwatch · 接手须知

给下一个工作区里的自己读。读完这份就能直接开工，不用重新摸。

## 一句话

**守夜人 / Nightwatch**：守夜人网络攻击防御 agent。独立项目，只读采集、证据日志、基线差分、日报；
修复只提案，执行只开一条窄路。目录 `nightwatch`。

## 铁律（先记住，别破）

1. **这是独立项目，不是 外部项目。** 不写 `fairy-framework`、不混管家 bundle、不改管家的数据。
2. **唯一跨项目依赖是 `@fairy/guard`**，通过 `packages/nightwatch-host/package.json` 的
   `link:../../../fairy-framework/packages/guard/fairy-guard` 只读消费。看它的源码可以，改它不行。
3. **中文名用于文档和对话，英文名用于目录/包/代码**：Nightwatch、`@nightwatch/agent`、`@nightwatch/host`。
4. **只读优先。** 执行入口（`watch_apply_fix`）存在，但按评审建议应尽快改成**配置开关、默认关闭**；
   在 P0 修完前不要扩大执行范围。
5. **工具名保留 `watch_*`**（`watch_baseline` / `watch_diff` / `watch_report` / `watch_propose_fix` / `watch_apply_fix`），
   它们描述的是“观察”，不是旧项目名。

## 现在在哪

| 东西 | 位置 |
|---|---|
| agent | `packages/nightwatch-agent`（`@nightwatch/agent`） |
| 宿主 bundle | `packages/nightwatch-host`（`@nightwatch/host`，只装 guard + agent） |
| 启动器 | `scripts/nightwatch.mjs`（profile `nightwatch`，home `.nightwatch-home/`，端口 3091） |
| 文档 | `README.md`、`docs/nightwatch.md` |
| 设计/调研/评审 | `外部项目-Watch-构思-v2.md`、`agent-memory-调研.md`、`项目评审-2026-11-09.md` |

最近验证（2026-11-09）：`pnpm test` 27 通过；`node scripts/nightwatch.mjs smoke` 通过；
`dump` 里是 `nightwatch-guard` + `nightwatch-agent`。

## 代码地图

| 文件 | 负责 |
|---|---|
| `src/index.ts` | 插件入口、Config、路径校验、注册工具 |
| `src/collect.ts` `src/parse.ts` | 只读采集（端口/SSH/备份）与纯解析；命令写死 |
| `src/store.ts` | `watch.jsonl` 只追加 + `watch.db`（`node:sqlite`）物化视图 |
| `src/rules.ts` | 基线差分与规则，finding 带 `observationId` |
| `src/report.ts` | 日报 Markdown 渲染 |
| `src/tools.ts` | 五个工具与共享的采集/报告流程 |
| `src/propose.ts` | 修复计划（改哪行、风险、回滚、验证） |
| `src/apply.ts` | 应用计划（仅三种 SSH 改行；备份/校验/回滚） |
| `*.test.ts` | 解析、存储重建、规则、工具端到端、提案、执行 |

## 评审 P0（未修，按这个顺序）

以 `项目评审-2026-11-09.md` 为准，行号可能有偏移（代码已迁到本仓库）：

1. **日报不跑规则**：`writeReport` 只读已有 finding。改成统一巡检管线：
   采集 → 持久化 → 规则 → 状态复核 → 日报；日报直接复用这条管线。
2. **采集失败被写成消失**：给 `Observation` 加 `status: ok | partial | failed | disabled`、错误原因、
   成功时间与有效期；失败采集不参与 diff，不证明“风险消失”。
3. **漏报**：端口要比对监听地址/暴露范围（`127.0.0.1` → `0.0.0.0` 必须报），
   authorized_keys 要比**指纹集合差**（等量替换也要报）；PID 变化只作上下文。
4. **发现生命周期**：`firstSeen / lastSeen / lastChecked / resolvedAt`，状态 candidate → verified →
   fixed/invalid，加“持续 / 恢复 / 复发”事件；复发不能被同 key 去重吞掉。
5. **日志恢复**：半行尾巴不能直接续写。定一个尾部协议（隔离损坏段/换新段），补单写者锁、
   事件 ID 唯一性、重建一致性校验。
6. 顺手修：历史日报按目标日期取当时的基线/观测/发现；无基线时不要报“新端口”却又说“判不出来”；
   `apply` 要检查提案的 `executable`，回滚失败不能标 `rolled-back`。

## 下一步顺序（评审第一阶段）

1. 写一页**现行规格**（建议 `docs/spec.md`）：只读、无模型巡检、执行默认关、第一台 Linux 验收机。
2. 修上面 5 个 P0，每个都补边界测试（缺命令、无权限、解析失败、持续/恢复/复发、跨日、重启）。
3. 加 `nightwatch tick`：无对话、无模型、可被 cron/systemd 调用的完整巡检（复用同一管线）。
4. 加 `watch_timeline`：按资产 key + 时间窗查变化、证据、缺口。
5. 之后才考虑 osquery / Sigma / 多机；eBPF 和社区同步继续后置。

阶段完成条件：同一台机器连续跑 7 天，每天有成功或明确失败记录；中断、跨日、重复运行、
风险恢复与复发都能解释；删 SQLite 后结果一致；巡检不需要云模型或系统写权限。

## 约定与坑

- `dump` 会先 `setup`（已修）；新 home 第一次跑没问题。
- `node:sqlite` 的 ExperimentalWarning 是正常的。
- `watch.db` 可以删，启动时从 `watch.jsonl` 重建；`watch.jsonl` 不能删。
- 报告标题是 `# 守夜人日报 · YYYY-MM-DD`；测试断言同步。
- 旧目录 `fairy-watch` 因被 DSH 占用没改名，内容已完整复制到 `nightwatch`；
  确认后可以删。`fairy-framework\packages\watch\` 是历史副本，未动，不要再去开发。
- 别把 `@fairy/guard` 复制进来——那会变成两份维护；用 link。

## 常用命令

```powershell
pnpm install
npx tsc -b
pnpm test
node scripts/nightwatch.mjs smoke
node scripts/nightwatch.mjs web
node scripts/nightwatch.mjs dump
```

## 交接时的状态

- 代码、测试、smoke 都是好的；问题是**产品契约**（日报/采集健康/生命周期/日志恢复），不是编译。
- 下一步就从 P0-1 开始，别先加功能、别先接 osquery。

---

管家负责“我陪着你”，守夜人负责“这台机器我盯着”。各住各的。
