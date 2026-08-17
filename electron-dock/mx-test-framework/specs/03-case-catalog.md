# 03 · 用例目录规范

## 为什么需要目录

代码里的 `it(...)` 只能回答"跑了什么"，不能回答"该跑什么"。目录（catalog）是**应该存在的
用例清单**，与代码里实际存在的用例做比对，才能发现：

- 目录里有、代码里没有 → `notRun`（用例被误删或被 `.skip`）
- 代码里有、目录里没有 → `unmapped`（新用例没登记，没人 review 过它测的是什么）
- 同一 Case ID 被执行多次 → `duplicate`（复制粘贴导致的统计污染）

compass 的 `e2e-run.mjs` 已经实现了这套比对逻辑，MXT 把它上移到平台，并把它做成报告里的一等信号。

## Case ID 命名

```
<APP>-<SURFACE>-<DOMAIN>-<NNN>
```

| 段 | 规则 | 例 |
| --- | --- | --- |
| APP | 应用缩写，2–4 位大写 | `CPS`（compass） |
| SURFACE | `FE` web / `EL` electron / `API` 接口 | `EL` |
| DOMAIN | 业务域，大写字母数字 | `BOOT`、`AUTH`、`STRATEGY` |
| NNN | 域内三位序号 | `001` |

正则：`^[A-Z0-9]{2,6}(-[A-Z0-9]+)+-\d{3}$`

**存量豁免**：compass web 现有的 `LP-FE-*` 前缀原样保留，不改标题、不改目录。
Case ID 只在 app 内唯一（[02](02-domain-model.md)），所以两套前缀可以共存。
新增用例才要求走新命名。

Case ID **一经发布不可复用**。用例删除时在目录中标 `retired: true` 而不是直接删行，
平台据此写 `retired_at`，历史 run 仍能解析。

## 目录文件

位置：被测应用仓库的 `<repo>/testing/catalog/*.json`（compass 存量位于
`cypress/case-catalog.*.json`，平台通过 app 配置里的 `catalogGlob` 指定，不强制搬家）。

Schema 见 [`../contracts/case-catalog.schema.json`](../contracts/case-catalog.schema.json)。

```json
{
  "schemaVersion": 2,
  "application": "compass",
  "surface": "electron",
  "suite": "compass-electron",
  "cases": [
    {
      "id": "CPS-EL-BOOT-001",
      "priority": "P0",
      "spec": "testing/playwright/electron/boot.spec.ts",
      "title": "打包应用冷启动进入主窗口且不请求提权",
      "tags": ["boot", "electron", "smoke"],
      "tracks": ["functional", "demo"],
      "requirementRef": "COMPASS-142"
    }
  ]
}
```

相对 compass 现有 `schemaVersion: 1` 的新增字段：

| 字段 | 用途 |
| --- | --- |
| `surface` | 区分 web / electron，决定派给服务端 runner 还是本地 runner |
| `tracks` | 该用例参与哪些轨道。**这是消除双轨代码重复的关键**，见 [05](05-tracks-and-artifacts.md) |
| `requirementRef` | 关联需求，让"需求覆盖率"将来可算而不是靠猜 |
| `retired` | 软删标记 |

`schemaVersion: 1` 的目录平台仍能读，缺失字段按默认值填充（`surface` 取 app 默认、
`tracks: ["functional"]`）。compass 存量因此零改动。

## 用例与代码的关联

compass 现在靠**标题正则**：`test.title.match(/LP-FE-[A-Z0-9-]+/)`。这很脆——改一个字的标题
就断链，而且强迫标题里带 ID，影响可读性。

MXT 定义三级关联，按优先级取第一个命中：

1. **原生标注**（推荐）
   - Playwright：`test('冷启动进入主窗口', { annotation: [{ type: 'case', description: 'CPS-EL-BOOT-001' }] }, ...)`
   - Cypress：`caseId('LP-FE-AUTH-001'); it('...', ...)` —— 由 MXT 的 Cypress 插件提供
2. **标题正则**（兼容存量）：标题中恰好出现一个合法 Case ID
3. **spec 路径 + 序号**（兜底，仅用于 unmapped 报告）

compass 存量停在第 2 级即可工作，新用例走第 1 级。

## Drift 汇总

平台在 ingest 时算出，写入 `mxt_runs.catalog`：

```json
{
  "catalogTotal": 23,
  "counts": { "passed": 21, "failed": 1, "skipped": 0, "flaky": 1, "notRun": 0 },
  "unmapped": [
    { "spec": "cypress/e2e/core/strategy.cy.ts", "title": "...", "reason": "missing-case-id" }
  ],
  "duplicates": [],
  "catalogIssues": [],
  "coverage": {
    "catalogCompletionPercent": 100.0,
    "catalogPassPercent": 91.3,
    "executedPassPercent": 95.5,
    "requirementLinkedPercent": 43.5
  }
}
```

### 三个分母，必须分开说

compass 的 E2E.md 已经诚实地警告过"功能完善率只代表目录内 23 个用例"。MXT 把这个警告
变成结构：

| 指标 | 分母 | 回答的问题 |
| --- | --- | --- |
| `catalogCompletionPercent` | 目录用例数 | 该跑的跑到了吗 |
| `catalogPassPercent` | 目录用例数 | 该跑的都过了吗 |
| `executedPassPercent` | 实际断言的用例数 | 跑到的里面过了多少 |
| `requirementLinkedPercent` | 目录用例数 | 有多少用例能追溯到需求 |

**平台 UI 与报告不得展示单一的"覆盖率"数字。** 产品需求覆盖率在没有完整需求台账前
无法计算，任何声称它的数字都是误导。
