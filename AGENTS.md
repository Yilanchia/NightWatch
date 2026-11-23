# 工程约定 · Nightwatch

给接手这个仓库的人（或 agent）读的短版约定。产品说明看 [README.md](README.md)。

## 一句话

守夜人是只读的主机安全值守 agent：只读采集 → 只追加证据 → 基线差分 → 发现生命周期 → 日报；
修复只提案，执行默认关闭。核心模块不依赖任何模型或宿主。

## 铁律

1. **只读优先。** `watch_apply_fix` 默认不注册（`applyFix: false`）。要扩大执行面，先过评审与观察窗。
2. **证据是事实来源。** `watch.jsonl` 只追加，绝不手工改；`watch.db` 可删可重建。
3. **没读到 ≠ 没问题。** 采集失败要写成"检查盲区"，不能写成"消失"。
4. **推断不是事实。** 结构化判断里 `confirmed` 必须指向真实观测；推断放 candidates / gaps。
5. **不泄露凭据。** `.env`、私钥、口令不进仓库、不进日志、不进模型上下文（出口有投影脱敏）。
6. **工具名保留 `watch_*`**：`watch_baseline` / `watch_diff` / `watch_report` / `watch_propose_fix` / `watch_apply_fix`。

## 目录

| 路径 | 负责 |
|---|---|
| `packages/nightwatch-agent` | 采集、存储、规则、报告、时间线、面板、协调端、告警、判断 |
| `packages/nightwatch-host` | 宿主 bundle（cordis patch，可选） |
| `packages/nightwatch-standalone` | 最小宿主组合 |
| `packages/nightwatch-analyst` | 有界只读调查（headless） |
| `packages/nightwatch-investigator` | 调查入口 re-export |
| `scripts/nightwatch.mjs` | CLI：tick / daemon / panel / export / pull-correlate 等 |
| `docs/` | 产品文档与设计 |

## 核心模块

| 文件 | 负责 |
|---|---|
| `src/inspect.ts` | 巡检管线：采集 → 落盘 → 规则 → 状态复核 → 日报；不 import DSH |
| `src/health.ts` | 采集健康：ok / partial / failed / disabled |
| `src/collect.ts` `src/parse.ts` | 只读采集与纯解析，命令写死 |
| `src/store.ts` | `watch.jsonl` 只追加 + `node:sqlite` 物化视图 |
| `src/rules.ts` | 基线差分与规则，finding 带 `observationId` |
| `src/report.ts` | 日报渲染（未关闭风险 / 已恢复 / 采集健康 / 盲区） |
| `src/timeline.ts` | 按 key + 时间窗回放 |
| `src/identity.ts` | 节点身份（Ed25519，ID = 公钥指纹） |
| `src/export.ts` | 跨端签名摘要，不含原始事实 |
| `src/pdp.ts` | 插件级策略决策点：只放行显式只读动作 |
| `src/approval.ts` | 一次性审批：owner key、绑定提案/文件状态、防重放 |
| `src/projection.ts` | 出口投影：模型可见副本脱敏 |
| `src/investigator.ts` | 有界调查：预算、UNTRUSTED 前缀、推断注释 |
| `src/judgment.ts` | 结构化判断 schema 与校验 |
| `src/investigation.ts` | 预算内 read → observe → decide 循环 |
| `src/trigger.ts` | 新发现/复发自动入队 pending |
| `src/alerts.ts` | 高危告警队列（去重、复发单列、ack） |
| `src/notify.ts` | 告警纪律 + 投影脱敏 + 可插拔 sink |
| `src/consumer.ts` | pending 消费者：真的落 judgment 才 done |
| `src/panel.ts` | 只读面板（含多端视图） |
| `src/coordinator.ts` | 验签、登记、幂等摄入、按 key 关联 |
| `src/tools.ts` | 薄适配层：`watch_*` 工具转调管线 |

## 常用命令

```bash
pnpm install
npx tsc -b
pnpm test

node scripts/nightwatch.mjs smoke
node scripts/nightwatch.mjs selfcheck       # 强制力探针 + PDP
node scripts/egress-probe.mjs               # 出口投影探针（假模型端点 + canary）

node scripts/nightwatch.mjs baseline ./.nightwatch-home
node scripts/nightwatch.mjs tick ./.nightwatch-home
node scripts/nightwatch.mjs daemon ./.nightwatch-home 1440
node scripts/nightwatch.mjs panel ./.nightwatch-home 3092
node scripts/nightwatch.mjs acceptance ./.nightwatch-home 7
node scripts/nightwatch.mjs pull-correlate ./nodes.json
```

## 测试

```bash
npx tsc -b
node --test "packages/*/dist/*.test.js"
```

覆盖解析、存储重建、规则、工具端到端、巡检管线、提案、审批、告警、协调端、面板等。
`node:sqlite` 的 ExperimentalWarning 是正常的。

## 约定与坑

- `watch.db` 可删，启动时从 `watch.jsonl` 重建；`watch.jsonl` 不能删。
- 报告标题固定为 `# 守夜人日报 · YYYY-MM-DD`，测试断言同步。
- 时间统一用主机本地时间，不要混 UTC。
- 新增采集项要同时补：状态（ok/partial/failed）、盲区说明、测试。
- 写操作永远走 `approval.ts` 的一次性审批；不要在工具里直接改文件。
- 跨端只传签名摘要；不要把原始证据塞进 bundle。
