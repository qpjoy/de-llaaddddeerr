# ADR-0002：Playwright 为主引擎，Cypress 作为一等 runner adapter

状态：已接受（2026-08-12）

## 背景

compass 的存量是 Cypress：23 个用例、双轨（functional/demo/perf/capture）、
mock/real profile、catalog 映射、脱敏、0/1/2 退出码。这套东西是跑通的，质量不低。

但被测范围要扩到 compass 的 Electron 产物，而 Cypress 在浏览器内运行，
无法驱动打包后的 Electron 应用，也不能跨 tab、跨 origin。

## 决策

**新用例统一用 Playwright。Cypress 作为平台的一等 runner adapter 长期保留，
compass 存量零改写继续跑。**

平台不绑定引擎——它绑定的是 [04](../04-runner-contract.md) 的 runner 契约：
环境变量进、`summary.json` + 产物出、退出码 0/1/2。Cypress 与 Playwright 都只是
满足这个契约的实现。

## 理由

**为什么新用例选 Playwright。**

| 能力 | 决定性 |
| --- | --- |
| `_electron.launch()` 驱动打包产物 | compass electron 与将来的 MX-H2I 桌面测试的前提 |
| 跨 origin / 跨 tab | launcher 登录跳转、OAuth 类流程测不了就是硬伤 |
| trace viewer | 失败回放比视频精确得多，能看 DOM 快照与网络 |
| 原生 `test.step()` | 双轨设计需要的步骤锚点，不用自己造 |
| 分片与并发 | 平台化后的规模化前提 |

**为什么不全面迁移 compass。** 23 个用例、9 份 fixture、自定义 `cy.step()`、
mock 拦截逻辑，重写一遍是纯成本——迁移后测的还是同一批场景，产品风险覆盖没有增加，
反而引入"迁移过程中漏掉一个断言"的新风险。而这些用例测的是 Web SPA，
Cypress 在这个范围内没有短板。

**为什么 Cypress 不是"临时兼容"而是一等 adapter。** 如果把它定为过渡方案，
就会产生"什么时候迁完"的持续压力和半新半旧的分裂状态。定为一等实现之后，
判断标准变成清晰的一条：**新用例看它要不要跨出浏览器沙箱——要，用 Playwright；
纯 Web SPA 且该应用已有 Cypress 体系，继续用 Cypress。**

## 后果

- 平台要维护两套 adapter（summary 归一、产物路径归一、step 归一）。
  成本主要在 P1，之后是稳态。
- `mxt gen`（[07](../07-agent-case-authoring.md)）需要能生成两种引擎的代码。
  按应用已有的引擎选择模板。
- 两套引擎的选择器写法、等待语义不同。文档需要给出各自的护栏规则，
  不追求一份"通用测试写法"。
- compass 如果将来要做跨 origin 的登录流程测试，那条用例走 Playwright，
  同一仓库两套引擎并存是被允许的。

## 被否决的方案

- **全面统一到 Playwright**：短期成本最高，且迁移收益是零新增覆盖。
- **继续只用 Cypress**：永久放弃 Electron 与跨 origin 测试，与首批范围直接冲突。
