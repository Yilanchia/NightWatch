# Contributors

守夜人是**人与 AI 结对**做出来的：方向、边界、验收和发布由项目主人拍板，实现与验证由 AI agent 执行。

| 角色 | 谁 | 负责 |
|---|---|---|
| 项目主人 / 决策 | **Yilanchia** | 目标与取舍、安全边界、验收与发布决定；两台验收机的拥有者 |
| 实现 / 测试 / 部署 / 文档 | **DeepSeek Harness**（AI 结对，`deepseek-v4.1-flash`） | 按确认的方案写代码与测试、在两台 Linux 节点上部署与验收、写运行文档；不替主人做发布决定 |

## AI 参与了什么

- 只读采集、证据日志、基线差分、发现生命周期、日报、健康/时间线；
- 面板（只读、SSH 隧道）、结构化调查判断、pending 队列与消费者、确定性告警与告警纪律；
- 多端：节点身份、签名摘要、SSH `pull-correlate`、协调端关联、面板多端视图；
- 测试（112）、强制力探针、出口投影探针、两台节点的部署与 `acceptance`。

## AI 没有做什么

- 没有决定产品方向、安全边界或发布时机——这些是主人的决定；
- 没有打开写路径（`applyFix: false`），没有自动改 sshd / findings / baseline；
- 没有保留任何服务器口令或私钥；发布前按主人要求把文档里的真实 IP 换成了占位符。

## 怎么标

提交里用 `Co-authored-by: DeepSeek Harness <dsh-agent@users.noreply.github.com>` 记录 AI 的共同参与。
