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

最近验证（2026-11-09）：`pnpm test` **32 通过**；`node scripts/nightwatch.mjs smoke` 通过；
`node scripts/nightwatch.mjs tick <home>` 在临时 home 里跑通完整巡检（无 DSH、无模型），
`dist/inspect.js` 的依赖闭包里没有任何 `@deepseek-ai` 引用。

## 代码地图

| 文件 | 负责 |
|---|---|
| `src/index.ts` | 插件入口、Config、路径校验、注册工具 |
| `src/inspect.ts` | **巡检管线**：采集 → 落盘 → 规则 → 状态复核 → 日报；不 import DSH，tick 直接调用 |
| `src/health.ts` | 采集健康：`ok / partial / failed / disabled`，由 evidence 退出码推导 |
| `src/collect.ts` `src/parse.ts` | 只读采集（端口/SSH/备份）与纯解析；命令写死 |
| `src/store.ts` | `watch.jsonl` 只追加 + `watch.db`（`node:sqlite`）物化视图 |
| `src/rules.ts` | 基线差分与规则，finding 带 `observationId` |
| `src/report.ts` | 日报 Markdown 渲染（未关闭风险 / 采集健康 / 盲区） |
| `src/tools.ts` | **薄适配层**：五个 `watch_*` 工具，只转调 `inspect.ts`，不含业务规则 |
| `src/propose.ts` | 修复计划（改哪行、风险、回滚、验证） |
| `src/apply.ts` | 应用计划（仅三种 SSH 改行；备份/校验/回滚） |
| `*.test.ts` | 解析、存储重建、规则、工具端到端、巡检管线、提案、执行 |

## 评审 P0 状态（按这个顺序）

以 `项目评审-2026-11-09.md` 为准，行号可能有偏移（代码已迁到本仓库）：

1. ✅ **日报不跑规则**：已修。`writeReport` / `tick` 都走 `inspect.ts` 的统一管线，首次直接要日报也会跑规则。
2. 🟡 **采集失败被写成消失**：`Observation` 已有 `status`，报告有“检查盲区”，`takeDiff` 不再把没读到的说成“消失”；还缺错误原因、有效期和规则侧的生命周期复核。
3. ⬜ **漏报**：端口要比对监听地址/暴露范围（`127.0.0.1` → `0.0.0.0` 必须报），
   authorized_keys 要比**指纹集合差**（等量替换也要报）；PID 变化只作上下文。
4. ⬜ **发现生命周期**：`firstSeen / lastSeen / lastChecked / resolvedAt`，状态 candidate → verified →
   fixed/invalid，加“持续 / 恢复 / 复发”事件；复发不能被同 key 去重吞掉。
5. ⬜ **日志恢复**：半行尾巴不能直接续写。定一个尾部协议（隔离损坏段/换新段），补单写者锁、
   事件 ID 唯一性、重建一致性校验。
6. 🟡 顺手修：无基线时已不再把当前端口报成“新端口”；历史日报和 `apply` 的 `executable` 检查仍待修。

## 下一步顺序（以 `docs/DSH改造与后续实施方案.md` 为准）

1. **M0 剩余**：验证 Watch 专用宿主——最小组合、真实工具清单可枚举、危险工具不在列表里；
   本轮已完成 M0 的“无模型巡检入口”（`nightwatch tick`）。
2. **M1**：修上面 3/4/5/6 的 P0（监听范围、指纹集合、生命周期、日志恢复、历史日报、apply 契约），每个补边界测试。
3. **M2**：持久化巡检任务 + 健康信息（最近成功 / 下次巡检 / 盲区）+ `watch_timeline`。
4. 之后才考虑 osquery / Sigma / 多机；eBPF 和社区同步继续后置。

阶段完成条件：同一台机器连续跑 7 天，每天有成功或明确失败记录；中断、跨日、重复运行、
风险恢复与复发都能解释；删 SQLite 后结果一致；巡检不需要云模型或系统写权限。

## 约定与坑

- `dump` 会先 `setup`（已修）；新 home 第一次跑没问题。
- `node:sqlite` 的 ExperimentalWarning 是正常的。
- `watch.db` 可以删，启动时从 `watch.jsonl` 重建；`watch.jsonl` 不能删。
- 报告标题是 `# 守夜人日报 · YYYY-MM-DD`；测试断言同步。
- 旧目录 `fairy-watch` 已在 2026-11-09 清理删除，方案文档已移入 `docs/`；
  `fairy-framework\packages\watch\` 是历史副本，未动，不要再去开发。
- 别把 `@fairy/guard` 复制进来——那会变成两份维护；用 link。

## 常用命令

```powershell
pnpm install
npx tsc -b
pnpm test
node scripts/nightwatch.mjs smoke
node scripts/nightwatch.mjs baseline <home>   # 无模型：记录基线
node scripts/nightwatch.mjs tick <home>       # 无模型：跑一轮完整巡检
node scripts/nightwatch.mjs web
node scripts/nightwatch.mjs dump
```

## 交接时的状态

- 代码、测试、smoke 都是好的；M0 的无模型巡检入口已完成，`inspect.ts` 不依赖 DSH。
- 剩下的是**产品契约**：监听范围/指纹集合、发现生命周期、日志恢复、历史日报、apply 契约，以及 M0 的宿主验证。
- 下一步先做 M0 宿主验证，再按 M1 修 P0；别先接 osquery。

---

管家负责“我陪着你”，守夜人负责“这台机器我盯着”。各住各的。
