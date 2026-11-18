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
| analyst | `packages/nightwatch-analyst`（`@nightwatch/analyst`，headless + guard/agent/investigator；有界只读调查） |
| investigator 入口 | `packages/nightwatch-investigator`（`@nightwatch/investigator`，re-export agent/investigator） |
| 启动器 | `scripts/nightwatch.mjs`（profile `nightwatch`，home `.nightwatch-home/`，端口 3091） |
| 文档 | `README.md`、`docs/nightwatch.md` |
| 设计/调研/评审 | `外部项目-Watch-构思-v2.md`、`agent-memory-调研.md`、`项目评审-2026-11-09.md` |
| 本轮产出 | `docs/2026-11-09-工作记录.md`、`docs/m0-host-research.md`、`docs/DSH改造与后续实施方案.md`、`docs/强制力探针与DSH改造-实施文档.md`、`docs/AI调查agent与面板-实施方案.md`、`docs/交接-2026-11-17-多端值守与发布.md`、`docs/发布-v0.2.0.md`（**v0.2.0 候选与发布清单**）、`docs/发布-2026-11-17.md`（v0.1.0） |
| 7 天验收机（node A） | `NODE_A_IP`（Ubuntu 22.04 / 2C4G），代码 `/opt/nightwatch`，home `/var/lib/nightwatch`；`nightwatch-daemon.service` 每 1440 分钟巡检，`nightwatch-panel.service` 只读面板仅绑 `127.0.0.1:3092`；节点 id `nw-LFW505Jt0c3B`；见 `docs/服务器验收-2026-11-10.md`、`docs/发布-2026-11-17.md` |
| 第二节点（node B） | `NODE_B_IP`（Ubuntu 24.04 / 2C2G，同机跑博客 + 外部项目，**只读不碰**），代码 `/opt/nightwatch`，home `/var/lib/nightwatch`，`nightwatch-daemon.service` 每 1440 分钟；节点 id `nw-d25kRkC80eDT`。两台都用 `~/.ssh/nightwatch_deploy` key 登录（已追加进各自 root 的 authorized_keys，未碰 sshd） |

最近验证（2026-11-18）：**v0.2.0 候选代码已部署到两台节点（`version` 均为 0.2.0），等待 node B 的 5 日观察窗**；
`pnpm test` **112 通过**；`smoke` / `selfcheck` / `egress-probe` 通过；
两节点跨端：手动 `pull-correlate` 关联出 2 条跨节点高危、退出码 2、协调端 2 节点 4 发现；
node A 8 份日报（11-10 → 11-17），node B 已产 1 份（11-17 上线，首轮 11-18 15:30 CST）；
daemon 的 SIGTERM 现在立即打断 sleep（`systemctl stop` 不再等一分钟）；
`nightwatch investigate` 已用真模型在临时副本跑通（1 条 judgment、pending 减 1，失败保留）；
`tick` / `health` / `timeline` / `daemon` / `export` / `verify` / `register` / `ingest` / `serve` / `push` / `correlate` / `pull-correlate` 跑通；
`inspect.js` 依赖闭包无 `@deepseek-ai`；Linux SSH 走 `sshd -T`。

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
| `src/approval.ts` | 一次性审批：owner key、提案/变更/文件状态绑定、有效期、防重放 |
| `src/projection.ts` | 出口投影：`watch_*` 结果的模型可见副本脱敏（私钥/令牌/绝对路径），日志不动 |
| `src/investigator.ts` | 有界调查：调用/墙钟/字节预算、UNTRUSTED 前缀、推断注释写独立 JSONL |
| `src/selfcheck.ts` | 强制力探针：真实 dispatch 验证工具面、destructive 拒绝门、名称盲区 |
| `src/acceptance.ts` | 发布验收：每日 run/日报、最近健康、从日志副本重建一致性 |
| `src/judgment.ts` | 结构化调查判断：schema/校验（confirmed 必须指向真实观测）/独立 JSONL |
| `src/investigation.ts` | 预算内 read→observe→decide 循环 + 可插拔 Reasoner（桩/模型） |
| `src/trigger.ts` | 新发现/复发自动入队 pending；按 findingId 去重、done 出队 |
| `src/alerts.ts` | 确定性高危告警队列：severity>=high、去重、复发单列、ack 出队 |
| `src/notify.ts` | 出站通知：告警纪律（分级/限频/安静时段/升级）+ 投影脱敏 + 可插拔 sink（console/file/**httpsSink 设备推送**，支持 json/wecom/feishu/text）；默认只写本地文件 |
| `src/consumer.ts` | pending 消费者：跑调查，只有真的落 judgment 才 done，失败保留 |
| `src/panel.ts` | 只读面板：`/api/summary`、`/findings`、`/timeline`、`/investigations`、`/alerts`、`/pending`、`/reports`、**`/coordinator`（多端防护网：节点清单 + 跨节点关联，跨端高危高亮）** + 单页 |
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

1. **7 天观察已完成**（2026-11-10 → 11-17，8 轮全 ok、8 份日报，`acceptance` 全 PASS）；
   验收机 `nightwatch-daemon.service` 每 24h 继续巡检，`nightwatch-panel.service` 提供只读面板
   （仅 `127.0.0.1:3092`，SSH 隧道）。仍然：不要停 daemon、不要删 `watch.jsonl`。
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
   **Task A/B** 已落地（出口投影 + 有界调查）；**Task C 的审批元数据**也已落地：
   `approval.ts`（owner key、提案/变更/文件状态绑定、有效期、一次性 ID）+ `nightwatch approve`。
   写路径仍默认关闭（`applyFix: false`），未过隔离演练前不打开。
   下一步：隔离演练、真实模型的长期调查与升级人类接口。
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
node scripts/nightwatch.mjs analyst <home> "<任务>"  # 有界只读调查（headless + analyst bundle）
node scripts/nightwatch.mjs approve <home> <proposalId> [minutes]  # 一次性审批（绑定提案+文件状态）
node scripts/nightwatch.mjs acceptance <home> [days]  # 发布验收：每日 run/日报 + 重建一致性
node scripts/nightwatch.mjs panel <home> [port] [host]  # 只读面板（默认 127.0.0.1:3092，SSH 隧道）；设 NIGHTWATCH_COORD_STATE=<coordinator-state.json> 开"多端防护网"跨端视图
node scripts/nightwatch.mjs investigate <home> [limit]  # 消费 pending 队列（analyst 跑调查，失败保留）
node scripts/nightwatch.mjs alerts <home> [ack <id>]  # 列出/确认确定性告警
node scripts/nightwatch.mjs version                   # 版本
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
node scripts/nightwatch.mjs pull-correlate <nodes.json>  # 本地：SSH 拉各节点签名摘要→ingest→关联，跨节点高危退出码 2（见 nodes.example.json）
node scripts/nightwatch.mjs web
node scripts/nightwatch.mjs dump
```

## 交接时的状态

- 代码、测试（112）、smoke / selfcheck / egress-probe / acceptance 都是好的；版本 `0.2.0`（**候选，未打 tag**，
  等 node B 5 日观察窗；清单见 `docs/发布-v0.2.0.md`）；核心模块不依赖 DSH。
- P0 全部修完（1–6）；run 记录、健康查询、基线完整性、退出码、恢复语义、配置统一、内置调度、SSH 生效配置已落地。
- M0 已落地：`@nightwatch/standalone` + 强制力探针 + 插件级 PDP（未声明/write/需审批一律拒绝；名称盲区已关闭）。
- Task A 已落地：`projection.ts` + `scripts/egress-probe.mjs`（正反两组通过）。
- Task B 已落地：`investigator.ts` + `@nightwatch/analyst` + `nightwatch analyst`。
- Task C 审批元数据已落地：`approval.ts` + `nightwatch approve`；`watch_apply_fix` 必须带有效一次性 approvalId。
- 结构化判断已落地：`judgment.ts`（confirmed 必须命中真实观测）+ `investigation.ts`（预算内循环，桩 reasoner）
  + `watch_investigate_judgment` 工具 + 面板 `/api/investigations` 分层展示。
- 事件触发已入队：`trigger.ts`；`tick`/`daemon` 新发现自动进 `investigations-pending.jsonl`，面板 `/api/pending` 显示。
- 确定性告警已入队：`alerts.ts`；`severity>=high` 去重入队、复发单列、ack 出队，面板 `/api/alerts` 显示。
- 队列消费者已落地：`consumer.ts` + `nightwatch investigate`；只有真的落 judgment 才 done，失败保留 pending。
- 只读面板已落地：`panel.ts` + `nightwatch panel`（本地 HTTP，SSH 隧道，无写接口）。
- M1 原型：身份 + 摘要 + 显式登记 + 能力/seq + 协调端摄入/关联 + 本地 HTTP 传输（非 TLS）。
- 首台验收机 daemon 连续巡检（2026-11-10 → 11-17，8 轮全 ok）；`acceptance` 全 PASS。
- F2 出站通道 stage 1 已落地（2026-11-17）：`notify.httpsSink` 纯内置 HTTPS 推送（json/wecom/feishu/text），
  `NIGHTWATCH_PUSH_URL` + `NIGHTWATCH_PUSH_FORMAT` 配置；节点 `queuePending` 入队高危后自动推、协调端 `pull-correlate` 推跨节点高危（按 key 去重）；
  真机验证企业微信格式两条跨端告警成功投递、重跑去重。双向确认（手机点批准）+ 原生 web-push 是 stage 2。
- 两节点跨端打通（2026-11-17）：node B（`NODE_B_IP`，博客+外部项目 同机，只读部署）上线并常驻 daemon（14.6M 内存）；
  `coordinator.crossNodeAlerts` + `nightwatch pull-correlate`（SSH 拉摘要→ingest→关联，跨节点高危退出码 2）。
  协调端建议放本地；`ingestBundle` 拒旧序号、`verifyBundle` 可选新鲜度已就位。节点配置见 `nodes.example.json`（占位，不含真 IP/密钥）。
- 发布：✅ `v0.1.0` 已于 2026-11-17 打 tag 并部署（`docs/发布-2026-11-17.md`）；`v0.2.0` 候选代码
  已于 2026-11-18 部署到两台节点（`version`=0.2.0），**tag 等 node B 连续 5 个干净日记（最早 11-22）**；写路径继续关。
- 告警纪律已落地：`notify.ts` + `nightwatch notify`（分级/限频/安静时段/升级、投影脱敏、已发不重发）；
  出站 sink 默认只写本地文件，真设备通道（F2，自建不 link `@fairy/link`）与复发/处置后重查待做。
- 跨端防重放已加固：`ingestBundle` 拒绝更旧序号（同序号幂等仍放行）；`verifyBundle` 可选新鲜度校验（未来/过期）。
- 台面上的活：F2 自建出站通道 + fairyLink 确认服务、复发/处置后重查、面板 P1 展示判断/告警、隔离演练、M1 TLS；别先接 osquery。

---

管家负责“我陪着你”，守夜人负责“这台机器我盯着”。各住各的。
