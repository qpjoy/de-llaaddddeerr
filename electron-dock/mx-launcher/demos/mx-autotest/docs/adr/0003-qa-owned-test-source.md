# ADR-0003：QA 外部仓库优先，工具不是长期分支

状态：提议  
日期：2026-09-07

## 背景

测试团队希望不侵入业务仓库，也希望独立选择 Cypress、Playwright、pytest、k6 等工具。与此同时，测试源码必须能 review、diff、blame、rollback，并与被测版本绑定。

按工具长期维护 autotest/cypress、autotest/playwright 等分支看似隔离，实际会让同一个业务风险在多个分支形成不同 Catalog、fixture 和预期。Luopan / Compass 的 Cypress 存量在较旧 public 分支，当前开发参考是 feat/yjj/hdo_v2，已经说明浮动旧分支不能直接代表当前产品质量。

## 决策

1. 新项目默认使用测试团队拥有的独立 QA Git 仓库。
2. 黑盒 e2e、API、性能、打包 Electron 和跨项目流程优先进入 QA 仓库。
3. 与内部 fixture、类型、mock、component 编译强耦合的测试可以保留在业务仓库。
4. Suite 分别声明 applicationSource 和 testSource；每个 Run 将两者解析为不可变 commit / artifact digest。
5. 工具差异放在目录、workspace 和 Suite adapter，不建立长期工具分支。
6. 一次性迁移可以使用短期 feature 分支，验证后合并或删除。
7. Catalog 的业务意图只有一份；同一 caseId 可以由多个 Suite 实现，但不得静默分叉。
8. Agent 生成的测试进入 PR，由测试意图负责人 review；不直接写默认分支或数据库源码字段。

## 理由

- QA 对测试策略自主；
- 业务仓库可保持低侵入；
- Git 保留版本、评审与审计能力；
- 应用版本与测试版本可以分别冻结；
- 多工具共享一份 Catalog；
- 第二个项目接入不要求修改平台代码。

## 后果

- Project onboarding 需要明确两个 source；
- 测试仓库要维护 lockfile、manifest、Catalog 和 reporter；
- 私有仓库凭据必须只读、短期且不写 URL；
- 强耦合存量用例可能暂时留在业务仓库，平台 UI 必须显示来源；
- public 存量需要 inventory 和 compatibility review，不能直接挂 cron；
- 多版本支持按产品 release / compatibility 分支组织，而非按工具。

## 被否决方案

### 测试代码存平台数据库

失去 PR、diff、blame 和自然版本绑定，还要自造源码版本系统。

### 所有测试必须进入业务仓库

测试团队的黑盒策略受业务排期限制，也会给业务仓库加入大量平台胶水。

### 所有测试必须迁出业务仓库

会复制 fixture、mock 和内部类型，制造另一种漂移。

### 长期按 Cypress / Playwright 分支

工具升级和业务变化需要多次合并，绿色报告可能来自落后真相。

## Luopan / Compass 验证要求

- 冻结 public 和 feat/yjj/hdo_v2 的实际 SHA；
- 建立 spec、Case、fixture 与依赖 inventory；
- 每条存量 Case 标记 unchanged、needs-update、obsolete 或 unknown；
- 黑盒与强耦合用例分别决定落点；
- 在同一应用 commit 上比较旧入口与新 Suite；
- drift 清零或有显式接受记录；
- 默认 source 切换通过 PR 审批；
- 历史 Run 保留旧 source ref。
