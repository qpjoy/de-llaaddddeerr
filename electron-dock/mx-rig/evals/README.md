# 机组评测（Crew Evals）

同一组固定场景，反复跑、用同一套口径打分。用来回答“换模型 / 改 persona / 改工具之后，Agent 是更可靠了还是更差了”。

```bash
npm run eval                                   # 脚本模式：每个场景自带的“标准操作”扮演模型
npm run eval -- --live --settings <state>/settings.json --repeat 5 --out eval.json
npm run eval -- --live --database-url postgres://…  # 共享部署：设置在 PostgreSQL 里（只读）
npm run eval -- --only injection-in-logs,no-evidence
```

- **脚本模式**只验证运行时、工具与评分本身（也在 `npm test` 里跑），数字不代表任何模型的水平。
- **真实模式**使用设置文件里的 Provider 调用序列（文件会先复制，不会被改写），API Key 取自当前 shell 的环境变量；默认每个场景跑 5 次。
- 平台是假的（场景里的固定响应），任务、工具执行器、结论审计、用量计量都是真的；带 `site` 的场景会起一个本地页面，用真实 Chromium 操作。

## 场景格式（`scenarios/*.json`）

| 字段        | 含义                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`     | 传给任务的 `goal` / `agentKey` / `grants`                                                                                                      |
| `policy`    | `allowedTools`、`maxTurns`、`tokenBudget`、`browserPreauth`                                                                                    |
| `platform`  | `路径 → 响应`；`"POST 路径"` 表示写接口；数组表示依次返回（最后一项重复）；未列出的路径返回 404                                                |
| `site`      | `路径 → HTML`，会替换场景里的 `{{origin}}`                                                                                                     |
| `workspace` | `{ files: { 路径: 内容 } }`：终端场景的项目目录，Agent 用 `workspace_*` 工具在里面工作，开始时会收到和 `mx-rig` 一样的项目材料 |
| `approvals` | `approve`（默认）或 `reject`：评测如何回应确认请求；每次确认都计为一次人工介入                                                                 |
| `expect`    | `status`、`verdict`、`verified`、`cites`、`mustCall`、`mustNotRequest`、`mustNotHit`、`assertionsPassed`、`answerIncludes`、`maxInterventions`；终端场景另有 `filesContain`、`filesUnchanged`、`mustRunMatching`、`mustNotRunMatching`、`mustNotRead`、`lastCommandExit`、`answerIncludesAny`、`answerExcludes` |
| `script`    | 脚本模式下的模型动作：`{ "call": 工具, "args": {…} }` 或 `{ "say": 文本 }`                                                                     |

## 指标

成功率（所有检查都满足且无异常）、人工介入次数、工具出错率（出错的调用 / 全部调用）、平均轮数、tokens（均值 / 最大，Provider 未上报时为估算）、耗时，以及最常见的失分项。

现有场景覆盖：产品缺陷归因、环境受阻归因、证据不足不编造、日志注入不执行、按名称派发并等待、页面填写与断言、规程修正（改版与真缺陷），以及终端的三个场景：测试写错了就改测试、产品缺陷不改测试迁就、项目文件里的注入不执行。新增场景时先写好 `script` 让脚本模式通过，再用真实模式看模型的表现。
