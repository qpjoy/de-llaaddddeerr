# ADR-0002：JUnit 最低契约与 Rich Sidecar

状态：提议  
日期：2026-09-07

## 背景

MX Autotest 希望接入 Cypress、Playwright、pytest、k6 和未来工具。如果要求每个框架生成平台私有 summary，接入一种新技术栈就要编写平台专用 adapter，平台会退化成某个框架的外壳。

JUnit XML 是最广泛的测试结果交换格式，但它不能完整表达步骤、视频时间线、trace、目录标签、artifact digest 和引擎元数据。

## 决策

1. JUnit XML 是所有测试工具的最低结果合同。
2. 每次有效 Run 必须至少解析出一个 testcase；零用例为 blocked。
3. 平台只有一条归一与入库路径：JUnit / adapter 先转换为统一 CaseResult，再做脱敏、Catalog drift 和持久化。
4. 可选 mx-autotest.sidecar.json 补充：
   - caseId 与 JUnit testcase 的稳定映射；
   - step 与时间；
   - artifact role、相对路径、大小和 sha256；
   - toolchain、source 和 runner 指纹；
   - 框架 warning 和原生能力。
5. sidecar 只能增强，不能把 JUnit failure 改成 passed。
6. runner 生命周期、报告有效性、JUnit 和退出码共同仲裁结论；UI 自报状态优先级最低。
7. 引擎原生 HTML、trace、video 和 logs 作为 artifact 托管，平台不重新实现其 viewer。

## 理由

- 新语言和框架可以零核心代码接入；
- JUnit 支持用例级历史、失败与耗时；
- rich sidecar 保留 MX Autotest 在目录、步骤和证据方面的差异化；
- 单一入库路径避免脱敏和状态规则随 adapter 漂移；
- 平台可以在 sidecar 缺失时降级展示，而不是拒绝整个生态。

## 结论规则

| 条件 | 结论 |
| --- | --- |
| 没有有效 JUnit 或零 testcase | blocked |
| runner OOM、超时、浏览器未启动、目标不可达 | blocked |
| 有效 JUnit 含 failure / error，且执行环境有效 | failed |
| 退出码 0、有 testcase、无失败 | passed |
| 重试后通过 | passed，并显式标 stability = flaky |
| sidecar 与 JUnit 冲突 | 以更保守结论为准，并记录 contract warning |

unknown 退出码不能被 sidecar 覆盖为 passed。

## 后果

- JUnit 无法表达的字段在 Generic adapter 下显示 unavailable，不显示 0；
- 新用例应使用 testcase property 或原生 annotation 提供 caseId；
- 存量标题正则可以兼容，但应显示关联置信度；
- 需要版本化 JSON Schema、XML fixture 和跨框架 contract tests；
- artifact path 必须是相对路径并防目录穿越；
- 报告要标明信息来源。

## 被否决方案

### 只使用私有 summary.json

精度高但每个工具都需专用适配，不符合技术栈无关目标。

### 只使用 JUnit

会丢失步骤、视频、trace、目录与工具指纹，削弱诊断和分享体验。

### 直接解析每个框架数据库或 Cloud API

形成供应商耦合和多条状态真相，不适合作为统一底线。

### 只相信进程退出码

无法提供 Case 级结果，也容易把零用例或损坏报告误判为绿色。

## 验证要求

- Cypress、Playwright 和 pytest fixture 均能进入同一 CaseResult；
- pass、failure、error、skip、flaky、zero-test、malformed XML 有 contract test；
- sidecar 缺失和冲突路径有测试；
- token、URL query 和 Secret 的二次脱敏有测试；
- 同一 Case ID duplicate 和 unmapped 可见；
- 原始 JUnit、归一结果和最终报告可追溯。
