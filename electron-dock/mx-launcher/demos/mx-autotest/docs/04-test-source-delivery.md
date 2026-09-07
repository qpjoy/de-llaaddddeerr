# 04 · 测试源码交付

> 状态：提议。默认策略是 QA 外部仓库优先，但允许对强耦合用例做有证据的例外。

## 决策摘要

1. 测试源码必须进入 Git；平台数据库不充当源码仓库。
2. 新项目的黑盒 e2e、API、性能、桌面冒烟和跨项目流程，优先由测试团队维护独立 QA 仓库。
3. 依赖业务内部 fixture、类型、mock 或编译期 hook 的白盒测试，可以留在业务仓库，与应用 commit 同步。
4. Cypress、Playwright、pytest 是 Suite 属性或目录，不是长期分支。
5. 不推荐长期维护 autotest/cypress、autotest/playwright 等按工具分支。它们会让同一业务意图产生多套漂移的真相。
6. 每次 Run 同时冻结被测源码 ref 和测试源码 ref。

正式理由见 [ADR-0003](adr/0003-qa-owned-test-source.md)。

## 为什么优先 QA 外部仓库

测试团队需要能够：

- 不等待业务仓库排期就增加黑盒场景；
- 独立管理框架版本、依赖、密钥引用和运行脚本；
- 对多个版本或多个产品做跨系统测试；
- 让 Agent 生成的候选用例进入测试团队自己的 PR；
- 避免在业务仓库中加入仅平台使用的 runner 胶水。

外部仓库不是“脱离版本”。Run 必须同时记录：

| 维度 | 示例 |
| --- | --- |
| applicationSource | repo + commit，或安装包 URL + sha256 |
| testSource | QA repo + commit + workingDir |
| catalogSource | QA repo commit 下的 catalog digest |
| toolchain | Cypress / Playwright / browser / image digest |
| targetConfig | 环境引用和脱敏后的 URL |

这样测试团队拥有自主权，同时仍可回答“哪版测试验证了哪版产品”。

## 何时应留在业务仓库

| 场景 | 推荐位置 | 理由 |
| --- | --- | --- |
| 共享 TS 类型、源码模块、内部 fixture | 业务仓库 | 分离后极易漂移 |
| 随源码一起编译的 component / unit test | 业务仓库 | 与实现 commit 强绑定 |
| 大量使用项目内 mock server 或构建别名 | 业务仓库，或先抽公共测试包 | 外部复制造成双维护 |
| 只依赖公开 UI / API 的黑盒 e2e | QA 仓库 | 对业务实现低侵入 |
| 打包 Electron 冒烟 | QA 仓库 | 输入是制品 digest，不需写入应用源码 |
| k6、pytest、协议与数据验证 | QA 仓库 | 测试团队可独立演进 |

“业务仓库零侵入”是默认目标，不是教条。如果迁出会复制 9 份 fixture 或制造不可靠 mock，就先保留已有用例，并通过 adapter 接入。

## 推荐仓库布局

一个项目的 QA 仓库可以按测试意图和 surface 组织：

    mx-autotest.project.yaml
    catalog/
      web.json
      electron.json
      api.json
    suites/
      web-cypress/
        package.json
        cypress.config.ts
        e2e/
      electron-playwright/
        package.json
        playwright.config.ts
        tests/
      api-pytest/
        pyproject.toml
        tests/
      load-k6/
        scripts/
    shared/
      fixtures/
      redaction/
    adapters/
      normalize-cypress.mjs
    docs/
      test-strategy.md

这里按目录隔离依赖和工具，但共享 Catalog、fixture 规范和项目策略。项目较小时可以使用一个 lockfile；依赖冲突明显时再拆 workspace 或多个仓库。

mx-autotest.project.yaml 建议只声明可评审的静态入口：

    schemaVersion: 1
    project: compass
    suites:
      - slug: compass-web-smoke
        surface: web
        adapter: cypress
        workingDir: suites/web-cypress
        entrypoint: ["pnpm", "test:smoke"]
        results: junit/*.xml
      - slug: compass-electron-smoke
        surface: electron
        adapter: playwright-electron
        workingDir: suites/electron-playwright
        entrypoint: ["pnpm", "test"]
        results: junit/*.xml

Compass Electron 的 `pnpm test` 根据结构化 Profile 选择 lane：`mock` 为 bootstrap、V0 合法值 `real` 为 formal-auth；本地也可显式使用 `pnpm test:bootstrap` / `pnpm test:auth`。manifest 不保存账号、密码或验证码开关。

平台 UI 可以生成或导入这份 manifest，但执行前显示最终解析值，不隐藏命令和 ref。

## 为什么不长期按工具建分支

假设长期存在：

- autotest/cypress；
- autotest/playwright；
- autotest/pytest。

同一个登录风险可能在三个分支里各有一份不同的 Catalog、fixture 和预期。业务变化后必须合并三次；某个分支落后却仍能产出绿色报告。这正是质量平台应该消除的漂移。

正确做法：

- 主干表达当前测试真相；
- 工具差异放在 suite 目录和 adapter；
- 一次性迁移可用短期 feature 分支；
- 迁移验证完成后合并或删除分支；
- 同一 caseId 可由多个 Suite 实现，但 Catalog 意图只有一份；
- Run 明确记录使用哪个实现和 commit。

若需要针对应用长期维护多个版本，使用 release 分支或 compatibility matrix，命名按产品版本，而不是按工具。

## Luopan / Compass 存量迁移

public 分支上的 Cypress 用例比 feat/yjj/hdo_v2 落后，不能直接当成当前有效回归。建议分四步：

### 1. Inventory

- 冻结 public 的准确 commit；
- 枚举 spec、Case ID、fixture、自定义 command、环境变量和外部依赖；
- 记录哪些用例是黑盒，哪些强依赖业务仓库；
- 运行现有脚本仅作为存量基线，失败也如实记录。

### 2. Compatibility review

- 对照 feat/yjj/hdo_v2 的路由、选择器、认证、数据契约和构建方式；
- 为每条 Case 标记 unchanged、needs-update、obsolete、unknown；
- 不通过批量修改选择器来掩盖业务意图变化；
- 产品 / 测试共同确认 P0 / P1 目录。

### 3. Delivery choice

- 可独立的黑盒用例迁入 QA 仓库；
- 强依赖 fixture 和内部 mock 的存量用例先留在 po-frontend；
- 两种来源都由同一个 Project 管理，Suite 各自声明 testSource；
- 不把旧 public 分支长期注册为生产 cron 的浮动 source。

### 4. Cutover

- 在同一个应用 commit 上并行跑旧入口与新 Suite；
- 比对 Case 数、状态、视频与关键断言；
- 处理 notRun / unmapped / duplicate；
- 由评审人批准后把新 test commit 设为默认；
- 保留旧 Run 与 source ref，不覆盖历史。

## 平台新建项目的沉浸式流程

### 新手模式

1. 输入项目名和被测表面；
2. 选择“QA 外部仓库”或“业务仓库已有测试”；
3. 粘贴 Git URL，选择可见 branch；
4. 平台只读扫描 manifest、lockfile、Catalog 和可识别 reporter；
5. 显示建议模板：Web 冒烟、Electron 冒烟、API 检查；
6. 运行 preflight，不立即执行；
7. 用户确认冻结的 commit、工具下载量和证据策略；
8. 创建一个手动 Task，再显式运行。

### 专家模式

允许直接配置：

- repo、ref、workingDir；
- adapter、固定工具版本和 runner image；
- argv、环境引用、capabilities；
- JUnit glob、sidecar 和原生 artifacts；
- sharding、retry、timeout、retention；
- secretRefs 和 network policy profile。

两种模式生成同一领域对象。新手模式不是另一套简化数据库。

## Source resolution

Task 可以保存 branch 或 tag 作为选择器，但每次触发必须：

1. 通过只读凭据解析 remote ref；
2. 得到 commit SHA；
3. 验证 commit 可访问；
4. 将 SHA 写入 Run；
5. checkout 该 SHA，而不是再次读取 branch HEAD；
6. 计算 manifest / lockfile / Catalog digest；
7. 执行结束后保存 resolved source manifest。

如果 trigger 到执行之间 commit 不可获取，Run 为 blocked。不得回退到默认分支。

对于被测制品，使用 artifact URL + sha256 / signature + build metadata，不能只写“latest.dmg”或“最新安装包”。

## 凭据与私有仓库

- Git credential 只授予目标仓库 read 权限；
- token 通过 credential helper、短期文件描述符或 runner 安全存储提供；
- 禁止把 token 拼进 clone URL；
- 禁止把 token 写进 .git/config、命令行和 artifact；
- fork / PR 场景不向不可信代码暴露生产 secret；
- runner 日志按精确 secret 值与通用模式双重脱敏；
- 下载完成后删除临时 credential。

## 测试代码评审

测试代码与产品代码一样需要：

- PR diff；
- 至少一名测试意图评审者；
- caseId 和 requirementRef 校验；
- reporter contract test；
- 零用例保护；
- 密钥与大文件扫描；
- 在隔离 target 上的 dry run；
- source / toolchain manifest。

Agent 可以：

- 根据需求生成候选 Catalog；
- 生成 spec 草稿；
- 归纳失败和建议修复；
- 提议 selector 改动。

Agent 不可以绕过 PR 直接修改默认测试真相。一个无人核对的绿色用例只能证明脚本没有报错，不能证明测对了业务。

## 大文件与生成物

以下内容不进 Git：

- 视频、trace、截图、HTML 报告；
- 安装包、浏览器二进制和工具缓存；
- 运行时 profile、session、token；
- node_modules、Python virtualenv、下载目录。

它们进入 artifact store 或 runner 内容寻址缓存，并由 manifest 关联。Git 只保存定义、源码、Catalog、lockfile 和小型确定性 fixture。

## 交付完成的判据

一个 Suite 只有同时满足以下条件才可进入定时任务：

- testSource 已解析为不可变 commit；
- applicationSource 或 artifact digest 可还原；
- Catalog 有负责人并通过 drift preflight；
- 工具链固定且 checksum 可验证；
- JUnit reporter contract test 通过；
- zero-test 会产生 blocked；
- Secret 和 target 使用隔离测试数据；
- 至少一次成功 Run 和一次可控失败 Run 已被评审；
- rollback 能回到上一个 test commit。

在这之前，Suite 标记为 draft 或 experimental，不能包装成“平台已支持”。
