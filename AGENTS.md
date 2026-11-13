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
4. **只读优先。** 执行入口 `watch_apply_fix` 现在**默认不注册**（`applyFix` 默认 `false`）；
   要继续扩大执行面，先过评审和 7 天观察窗。
5. **工具名保留 `watch_*`**（`watch_baseline` / `watch_diff` / `watch_report` / `watch_propose_fix` / `watch_apply_fix`），
   它们描述的是“观察”，不是旧项目名。

## 现在在哪

| 东西 | 位置 |
|---|---|
| agent | `packages/nightwatch-agent`（`@nightwatch/agent`） |
| 宿主 bundle | `packages/nightwatch-host`（`@nightwatch/host`，只装 guard + agent，挂 web profile） |
| 最小宿主 | `packages/nightwatch-standalone`（`@nightwatch/standalone`，完整显式树；无 shell/session/模型/Web） |
| 启动器 | `scripts/nightwatch.mjs`（profile `nightwatch`，home `.nightwatch-home/`，端口 3091） |
| 文档 | `README.md`、`docs/nightwatch.md` |
| 设计/调研/评审 | `外部项目-Watch-构思-v2.md`、`agent-memory-调研.md`、`项目评审-2026-11-09.md` |
| 本轮产出 | `docs/2026-11-09-工作记录.md`、`docs/m0-host-research.md`、`docs/DSH改造与后续实施方案.md`、`docs/强制力探针与DSH改造-实施文档.md` |
| 7 天验收机 | `NODE_A_IP`（Ubuntu 22.04 / 2C4G），代码 `/opt/nightwatch`，home `/var/lib/nightwatch`，内置 `daemon` 每 1440 分钟巡检；见 `docs/服务器验收-2026-11-10.md` |

最近验证（2026-11-13）：`pnpm test` **80 通过**；`node scripts/nightwatch.mjs smoke` / `selfcheck` 通过；
`node scripts/egress-probe.mjs` 正反两组通过（投影开不漏、投影关必漏）；
`tick` / `health` / `timeline` / `daemon` / `export` / `verify` / `register` / `ingest` / `serve` / `push` / `correlate` 跑通；
`inspect.js` 依赖闭包无 `@deepseek-ai`；Linux SSH 走 `sshd -T`；验收机由内置 `daemon` 持续巡检。

## 代码地图

| 文件 | 负责 |
|---|---|
| `src/index.ts` | 插件入口、Config、路径校验、注册工具 |
| `src/inspect.ts` | **巡检管线**：采集 → 落盘 → 规则 → 状态复核 → 日报；不 import DSH，tick 直接调用 |
| `src/health.ts` | 采集健康：`ok / partial / failed / disabled`，由 evidence 退出码推导 |
| `src/collect.ts` `src/parse.ts` | 只读采集（端口/SSH/备份）与纯解析；命令写死 |
| `src/store.ts` | `watch.jsonl` 只追加 + `watch.db`（`node:sqlite`）物化视图 |
| `src/rules.ts` | 基线差分与规则，finding 带 `observationId` |
| `src/report.ts` | 日报 Markdown 渲染（未关闭风险 / 已恢复 / 采集健康 / 盲区 / 原因） |
| `src/timeline.ts` | `watch_timeline`：按 key + 时间窗回放读到/发现/仍存在/已恢复 |
| `src/time.ts` | 本地时间格式化（报告/时间线/健康统一用主机本地时间，不是 UTC） |
| `src/identity.ts` | 节点身份：Ed25519 密钥对、节点 ID = 公钥指纹；私钥只在本机 |
| `src/export.ts` | 跨端签名摘要：run/发现/健康，**不含 facts/evidence/detail** |
| `src/pdp.ts` | 插件级策略决策点：只放行显式声明的只读动作；未声明/write/需审批一律拒绝 |
| `src/projection.ts` | 出口投影：`watch_*` 结果的模型可见副本脱敏（私钥/令牌/绝对路径），日志不动 |
| `src/selfcheck.ts` | 强制力探针：真实 dispatch 验证工具面、destructive 拒绝门、名称盲区 |
| `src/coordinator.ts` | 协调端原型：验签、节点登记、按 (node, finding) 幂等摄入、按 key 跨端关联 |
| `src/transport.ts` | 协调端本地 HTTP 原型（`/v1/bundle`、`/v1/status`）；非 TLS，信任靠登记+签名 |
| `src/tools.ts` | **薄适配层**：`watch_*` 工具，只转调 `inspect.ts` / `timeline.ts`，不含业务规则 |
| `src/propose.ts` | 修复计划（改哪行、风险、回滚、验证） |
| `src/apply.ts` | 应用计划（仅三种 SSH 改行；备份/校验/回滚） |
| `*.test.ts` | 解析、存储重建、规则、工具端到端、巡检管线、提案、执行 |

## 评审 P0 状态（按这个顺序）

以 `项目评审-2026-11-09.md` 为准，行号可能有偏移（代码已迁到本仓库）：

1. ✅ **日报不跑规则**：已修。`writeReport` / `tick` 都走 `inspect.ts` 的统一管线，首次直接要日报也会跑规则。
2. ✅ **采集失败被写成消失**：`Observation` 带 `status` + `error`，每条证据带短原因（退出码/文件不存在）；
   报告有“检查盲区”“原因”和“数据已过期”（`observationValidHours`，默认 26h）；`takeDiff` 不再误报消失。
3. ✅ **漏报**：端口比较监听范围（`127.0.0.1` → `0.0.0.0` 报 `listen_scope_expanded`），PID 变化不报；
   authorized_keys 比**指纹集合差**（等量替换报 `ssh_authorized_key_added`）。
4. ✅ **发现生命周期**：`firstSeen / lastSeen / lastChecked / resolvedAt / recurrenceOf`，
   `finding-update` 事件；持续刷新、只有成功读取才关闭、复发保留 `recurrenceOf`；跨重启从日志重放一致。
5. ✅ **日志恢复**：半行尾部隔离到 `watch.jsonl.torn-*` 并截到最后一个完整行；中间损坏/重复事件 ID 直接报错；
   单写者锁；每次打开重建视图。
6. ✅ 顺手修：历史日报按目标日期取当时的观测/基线/发现；无基线不再把当前端口报成“新端口”；
   `apply` 检查 `executable`，回滚失败标为 `failed` 而不是 `rolled-back`。

## 下一步顺序（观察期内继续开发）

1. **7 天观察进行中**（2026-11-10 → 11-17）：验收机的 `nightwatch-daemon.service` 每 24h 自动巡检；
   每天看 `health`、`watch-reports/` 与 `journalctl -u nightwatch-daemon`，记录成功/失败、盲区、恢复与复发。
   不要停 daemon、不要删 `watch.jsonl`。
2. **观察期内开发**：
   - ✅ **恢复语义**：端口/公钥被新基线吸收 → `invalid`（报告“已失效”）；监听范围缩回/端口关闭 → `fixed`。
   - ✅ **配置统一**：CLI 与宿主共用 `NIGHTWATCH_*` 环境变量（见 `packages/nightwatch-host/cordis.patch.yml`）。
   - ✅ **内置调度**：`nightwatch daemon`（单实例写锁、重启补跑一次、不重叠）；验收机已切换。
     只读命令 `health` / `timeline` 走只读视图，可在 daemon 运行时用；`tick` / `baseline` 需要写锁。
   - ✅ **SSH 生效配置**：Linux 先跑 `sshd -T`（Include / Match / 默认值已解析），失败才回退主文件。
   - ✅ **M1 地基**：节点身份（Ed25519，ID=公钥指纹）+ 签名摘要（run/发现/健康，不含 facts/detail），
     CLI `export` / `verify`；协调端 `register` 显式登记、`ingest` 拒绝未登记节点、`correlate` 跨端关联；
     bundle 带 `seq` 与 `capabilities`。
3. **M0 落地**：✅ `@nightwatch/standalone` + `selfcheck`（强制力探针 + PDP）。
   **Task A 出口投影**也已完成：`projection.ts` + `scripts/egress-probe.mjs`（假模型端点 + canary，正反两组）。
   下一步按实施文档做 **Task B（analyst + investigator）**，然后 C 的审批元数据/内核验证。
4. M1 多端：本地 HTTP 传输原型已完成（`serve` / `push`，非 TLS）；TLS/部署方式、审批通道、真实两台主机联动待做；osquery / Sigma 继续后置。

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
node scripts/nightwatch.mjs selfcheck        # 强制力探针 + PDP：工具面 / 拒绝门 / 名称盲区（见 docs/强制力探针与DSH改造-实施文档.md）
node scripts/egress-probe.mjs                # 出口投影探针：假模型端点 + canary，正反两组
node scripts/nightwatch.mjs baseline <home>   # 无模型：记录基线（有盲区时拒绝）
node scripts/nightwatch.mjs tick <home>       # 无模型巡检：0 正常 / 2 部分 / 1 失败
node scripts/nightwatch.mjs health <home>     # 最近成功、盲区、数据过期、未运行项
node scripts/nightwatch.mjs timeline <home> <key> [days]  # 回放一个事实的时间线
node scripts/nightwatch.mjs daemon <home> [minutes]       # 内置调度（前台；单实例写锁、补跑一次）
node scripts/nightwatch.mjs export <home> [days]          # 签名摘要（findings/health，无原始事实）
node scripts/nightwatch.mjs verify <bundle.json>          # 校验摘要签名与节点 ID
node scripts/nightwatch.mjs ingest <state.json> <bundle.json>  # 协调端：验签并幂等摄入
node scripts/nightwatch.mjs serve <state.json> [port] [host]   # 协调端本地 HTTP（非 TLS）
node scripts/nightwatch.mjs push <url> <bundle.json>           # 推送 bundle 到协调端
node scripts/nightwatch.mjs correlate <state.json>        # 按事实 key 跨节点关联
node scripts/nightwatch.mjs web
node scripts/nightwatch.mjs dump
```

## 交接时的状态

- 代码、测试（80）、smoke / selfcheck / egress-probe 都是好的；核心模块不依赖 DSH，`tick` / `health` / `daemon` / `export` / `ingest` 可无模型运行。
- P0 全部修完（1–6）；run 记录、健康查询、基线完整性、退出码、恢复语义、配置统一、内置调度、SSH 生效配置已落地。
- M0 已落地：`@nightwatch/standalone` + 强制力探针 + 插件级 PDP（未声明/write/需审批一律拒绝；名称盲区已关闭）。
- Task A 已落地：`projection.ts`（模型可见副本脱敏）+ `scripts/egress-probe.mjs`（正反两组通过）。
- M1 原型：身份 + 摘要 + 显式登记 + 能力/seq + 协调端摄入/关联 + 本地 HTTP 传输（非 TLS）。
- 首台验收机由内置 `daemon` 连续巡检（2026-11-10 → 11-17）；只读 health/timeline 可在 daemon 运行时用。
- 下一步：Task B（analyst + investigator）；M1 的 TLS/审批通道随后；别先接 osquery。

---

管家负责“我陪着你”，守夜人负责“这台机器我盯着”。各住各的。
