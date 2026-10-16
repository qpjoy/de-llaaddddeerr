import { useEffect, useState } from "react";
import {
  Archive,
  ArrowClockwise,
  ArrowRight,
  ChartBar,
  Check,
  Copy,
  PencilSimple,
  PlayCircle,
  Plus,
  SlidersHorizontal,
  Stack,
} from "@phosphor-icons/react";
import { api, appName } from "./data.js";
import { Modal } from "./Forms.jsx";
import { requestId } from "./request-id.mjs";
import {
  RULE_KINDS,
  RULE_OPTIONAL_DEFAULTS,
} from "../server/strategy-catalog.mjs";
import { DEFAULT_POOL_POLICY } from "../server/pool-policy.mjs";
import "./scenarios.css";

const scenarioDetails = {
  mixed: {
    label: "日常流量",
    example: "长搜索占用一台设备，短详情由其他设备并行处理。",
    shape: [3, 7, 4, 8, 5, 9, 4, 6],
  },
  affinity: {
    label: "连续短任务",
    example: "同 App 任务可短暂排队；空闲设备充足时分流。",
    shape: [2, 3, 5, 6, 6, 7, 8, 8],
  },
  cooldown: {
    label: "应用预算",
    example: "小红书进入冷却，设备仍可接收其他 App 的任务。",
    shape: [8, 8, 3, 2, 2, 5, 7, 8],
  },
  burst: {
    label: "突发请求",
    example: "大量请求先进入全局池，按容量和优先级逐批领取。",
    shape: [2, 2, 9, 9, 4, 8, 8, 3],
  },
  capabilities: {
    label: "能力变化",
    example: "第 8 秒补充设备指令能力，未领取任务重新匹配。",
    shape: [3, 3, 3, 5, 7, 7, 9, 9],
  },
  failure: {
    label: "故障隔离",
    example: "错误回执使设备隔离；排队任务继续寻找可用设备。",
    shape: [6, 7, 3, 3, 4, 6, 7, 8],
  },
  scale: {
    label: "渐进扩容",
    example: "先用 2 台设备，第 8 秒扩至所选规模。",
    shape: [2, 2, 2, 4, 6, 7, 9, 9],
  },
  "policy-change": {
    label: "策略替换",
    example: "第 8 秒切换分散优先，执行中的任务继续原会话。",
    shape: [4, 5, 4, 5, 7, 8, 7, 8],
  },
};
const liveScenarios = new Set(["mixed", "affinity", "cooldown", "burst"]);
const phaseNames = {
  placement: "分配位置",
  queue: "排队预算",
  "app-budget": "应用冷却",
  "app-override": "平台例外",
  pacing: "节奏账本",
};
const strategyNames = {
  adaptive: "自适应",
  spread: "分散优先",
  affinity: "亲和优先",
};
const secs = (value) =>
  Number.isFinite(value) ? `${Math.round(value / 100) / 10} 秒` : "—";
const latest = (rows = []) => {
  const byCode = new Map();
  for (const row of rows)
    if (!byCode.has(row.code) || byCode.get(row.code).version < row.version)
      byCode.set(row.code, row);
  return [...byCode.values()];
};
const emptyCatalog = {
  strategies: [],
  history: [],
  rules: [],
  ruleHistory: [],
};
const appFields = [
  [
    "windowMs",
    "统计窗口",
    1000,
    1,
    86400,
    "秒",
    "窗口内累计应用执行次数与服务时间。",
  ],
  [
    "maxRuns",
    "窗口任务上限",
    1,
    1,
    10000,
    "个",
    "达到上限后，新会话等待冷却。",
  ],
  [
    "maxServiceMs",
    "累计服务预算",
    1000,
    0.2,
    86400,
    "秒",
    "准入时同时考虑任务的预计耗时。",
  ],
  ["cooldownMs", "应用冷却", 1000, 0, 86400, "秒", "只约束该设备上的该 App。"],
];
const fieldGroups = {
  placement: [
    [
      "idleSpreadThresholdPct",
      "空闲分散阈值",
      1,
      0,
      100,
      "%",
      "自适应模式下，空闲比例超过此值时优先分散。",
    ],
    [
      "maxAffinityDelayMs",
      "亲和额外等待上限",
      1000,
      0,
      3600,
      "秒",
      "为减少 App 切换，最多多等多久。",
    ],
    [
      "switchCostMs",
      "App 切换耗时",
      1000,
      0,
      600,
      "秒",
      "设备当前 App 与任务不同时，计划额外计入的切换时间；模拟执行同样计入。",
    ],
  ],
  queue: [
    [
      "maxQueueWaitMs",
      "计划等待预算",
      1000,
      0,
      86400,
      "秒",
      "超过预计等待预算，任务保留在全局池。",
    ],
    [
      "maxQueuePerDevice",
      "单机计划队列上限",
      1,
      1,
      10000,
      "个",
      "计划可动态变更，只有领取后锁定设备。",
    ],
    [
      "shortTaskMs",
      "短任务估时阈值",
      1000,
      1,
      180,
      "秒",
      "短任务参与同 App 亲和，不会抢占正在执行的会话。",
    ],
    [
      "stickyGainMs",
      "改派最小提前量",
      1000,
      0,
      600,
      "秒",
      "已计划的任务换设备，至少要提前这么多完成。",
    ],
    [
      "stickyGainPct",
      "改派最小提前比例",
      1,
      0,
      100,
      "%",
      "按剩余预计时间计算，与上一项取较大者。",
    ],
    [
      "maxPlanMoves",
      "最多改派次数",
      1,
      0,
      100,
      "次",
      "达到后保留计划设备，除非它变为不可用。",
    ],
    [
      "planFreezeMs",
      "开始前冻结",
      1000,
      0,
      60,
      "秒",
      "距计划开始不足此时间时不再改派。",
    ],
  ],
  "app-budget": appFields,
  "app-override": appFields,
  pacing: [
    [
      "burstWindowMs",
      "连续执行统计窗口",
      1000,
      1,
      86400,
      "秒",
      "统计同 App 连续执行次数的窗口。",
    ],
    [
      "smallLimit",
      "小任务次数",
      1,
      0,
      1000,
      "个",
      "窗口内达到即随机休息；0 关闭随机休息。",
    ],
    [
      "largeLimit",
      "大任务次数",
      1,
      0,
      1000,
      "个",
      "大任务计数单独累计；0 关闭随机休息。",
    ],
    [
      "burstRestMinMs",
      "随机休息下限",
      1000,
      0,
      86400,
      "秒",
      "休息时长在下限与上限之间随机，生成后保存。",
    ],
    ["burstRestMaxMs", "随机休息上限", 1000, 0, 86400, "秒", "不小于下限。"],
    [
      "continuousCapMs",
      "整机连续服务上限",
      1000,
      0,
      86400,
      "秒",
      "设备不间断服务达到后强制休息；0 关闭。",
    ],
    [
      "continuousRestMs",
      "整机休息时长",
      1000,
      0,
      86400,
      "秒",
      "间隔不足此时长不算中断。",
    ],
    [
      "accountMinGapMs",
      "账号间隔",
      1000,
      0,
      86400,
      "秒",
      "同一账号两次会话的最小间隔，跨设备生效；0 关闭。",
    ],
    [
      "accountWindowMs",
      "账号预算窗口",
      1000,
      1,
      86400,
      "秒",
      "账号窗口预算的统计窗口。",
    ],
    [
      "accountMaxRuns",
      "账号窗口次数",
      1,
      0,
      100000,
      "次",
      "窗口内会话次数上限；0 关闭窗口预算。",
    ],
    [
      "accountMaxServiceMs",
      "账号窗口服务时长",
      1000,
      0,
      864000,
      "秒",
      "窗口内累计服务时长上限；0 不限。",
    ],
    [
      "accountRestMs",
      "账号预算休息",
      1000,
      0,
      86400,
      "秒",
      "窗口预算用完后账号休息。",
    ],
    [
      "accountDailyCap",
      "账号 24 小时上限",
      1,
      0,
      100000,
      "次",
      "滚动 24 小时内的会话上限；0 关闭。",
    ],
  ],
};
// Fields added later are optional in stored rules; show and edit their defaults.
const withOptional = (kind, config) => ({
  ...(RULE_OPTIONAL_DEFAULTS[kind] || {}),
  ...config,
});
function ruleSummary(rule) {
  const c = withOptional(rule.kind, rule.config || {});
  if (rule.kind === "placement")
    return `${
      c.strategy === "adaptive"
        ? `空闲 > ${c.idleSpreadThresholdPct}% 分散；亲和多等 ≤ ${secs(c.maxAffinityDelayMs)}`
        : `${strategyNames[c.strategy]} · 亲和多等 ≤ ${secs(c.maxAffinityDelayMs)}`
    }；App 切换计 ${secs(c.switchCostMs)}`;
  if (rule.kind === "pacing")
    return [
      c.smallLimit > 0 && c.largeLimit > 0
        ? `${secs(c.burstWindowMs)}内 ${c.smallLimit} 小 / ${c.largeLimit} 大后休息 ${secs(c.burstRestMinMs)}–${secs(c.burstRestMaxMs)}`
        : "不设随机休息",
      c.continuousCapMs > 0
        ? `整机连续 ${secs(c.continuousCapMs)} 后休息 ${secs(c.continuousRestMs)}`
        : null,
      c.accountMinGapMs > 0 ? `账号间隔 ${secs(c.accountMinGapMs)}` : null,
      c.accountMaxRuns > 0
        ? `账号 ${secs(c.accountWindowMs)}内 ≤ ${c.accountMaxRuns} 次`
        : null,
      c.accountDailyCap > 0 ? `账号 24 小时 ≤ ${c.accountDailyCap} 次` : null,
    ]
      .filter(Boolean)
      .join("；");
  if (rule.kind === "queue")
    return `计划等待 ≤ ${secs(c.maxQueueWaitMs)} · 单机 ≤ ${c.maxQueuePerDevice} 个 · 短任务 ≤ ${secs(c.shortTaskMs)}；改派需提前 ≥ ${secs(c.stickyGainMs)} 且 ≥ ${c.stickyGainPct}%，最多 ${c.maxPlanMoves} 次`;
  const p = rule.kind === "app-override" ? c.policy : c;
  return `${rule.kind === "app-override" ? `${appName(c.appId)} · ` : ""}${secs(p?.windowMs)}内 ≤ ${p?.maxRuns ?? "—"} 个 / ${secs(p?.maxServiceMs)}，冷却 ${secs(p?.cooldownMs)}`;
}
function PolicyReading({ policy: given, compact = false }) {
  if (!given) return null;
  // Seeded strategies omit fields added later; read them with their defaults.
  const policy = { ...DEFAULT_POOL_POLICY, ...given };
  const rows = [
    [
      "01",
      "选择设备",
      policy.strategy === "adaptive"
        ? `空闲 > ${policy.idleSpreadThresholdPct}% 时分散`
        : strategyNames[policy.strategy],
      `同 App 亲和额外等待 ≤ ${secs(policy.maxAffinityDelayMs)}；App 切换计 ${secs(policy.switchCostMs)}`,
    ],
    [
      "02",
      "保留排队",
      `预计等待 ≤ ${secs(policy.maxQueueWaitMs)}`,
      `每台最多计划 ${policy.maxQueuePerDevice} 个任务；未领取可重排`,
    ],
    [
      "03",
      "应用冷却",
      `${policy.appDefaults.maxRuns} 个任务 / ${secs(policy.appDefaults.windowMs)}`,
      `累计服务 ≤ ${secs(policy.appDefaults.maxServiceMs)}，冷却 ${secs(policy.appDefaults.cooldownMs)}`,
    ],
    [
      "04",
      "节奏账本",
      policy.pacing
        ? policy.pacing.burst
          ? `${policy.pacing.burst.smallLimit} 小 / ${policy.pacing.burst.largeLimit} 大后休息 ${secs(policy.pacing.burst.restMinMs)}–${secs(policy.pacing.burst.restMaxMs)}`
          : "不设随机休息"
        : "沿用机架循环设置",
      policy.pacing
        ? [
            policy.pacing.continuous
              ? `整机连续 ${secs(policy.pacing.continuous.capMs)} 后休息`
              : "不限整机连续服务",
            policy.pacing.account
              ? `账号预算：${policy.pacing.account.dailyCap ? `24 小时 ≤ ${policy.pacing.account.dailyCap} 次` : ""}${policy.pacing.account.minGapMs ? ` 间隔 ${secs(policy.pacing.account.minGapMs)}` : ""}${policy.pacing.account.maxRuns ? ` 窗口 ≤ ${policy.pacing.account.maxRuns} 次` : ""}`
              : "不设账号预算",
          ].join("；")
        : "账号状态（受限、复核、停用）仍为硬约束",
    ],
    [
      "05",
      "计划稳定",
      `改派需提前 ≥ ${secs(policy.stickyGainMs)} 且 ≥ ${policy.stickyGainPct}%`,
      `每个任务最多改派 ${policy.maxPlanMoves} 次；开始前 ${secs(policy.planFreezeMs)} 冻结`,
    ],
  ];
  return (
    <div className={`scenario-policy-reading${compact ? " compact" : ""}`}>
      {rows.map(([no, title, value, detail]) => (
        <div key={no}>
          <span>
            {no} · {title}
          </span>
          <strong>{value}</strong>
          <small>{detail}</small>
        </div>
      ))}
    </div>
  );
}
async function archiveDefinition(type, row) {
  const response = await fetch(
    `/api/${type}-definitions/${encodeURIComponent(row.id)}?mode=sim`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: row.version }),
      signal: AbortSignal.timeout(8000),
    },
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error || "归档失败");
  return value;
}
function EditorBasics({ draft, setDraft, editing, label }) {
  return (
    <>
      <div className="form-grid">
        <label>
          {label}代码
          <input
            required
            readOnly={editing}
            maxLength={60}
            pattern="[a-z][a-z0-9_.\-]*"
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          />
        </label>
        <label>
          {label}名称
          <input
            required
            maxLength={80}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
      </div>
      <label>
        说明
        <textarea
          maxLength={600}
          rows={2}
          value={draft.description || ""}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>
    </>
  );
}
function RuleEditor({ initial, editing, busy, onSubmit }) {
  const [draft, setDraft] = useState(() => ({
    code: "rule.custom",
    name: "自定义放置规则",
    description: "",
    kind: "placement",
    config: withOptional(
      "placement",
      structuredClone(RULE_KINDS.find((k) => k.kind === "placement").defaults),
    ),
    ...initial,
    ...(initial?.config
      ? { config: withOptional(initial.kind, structuredClone(initial.config)) }
      : {}),
  }));
  const values =
    draft.kind === "app-override" ? draft.config.policy : draft.config;
  const changeValue = (key, value) =>
    setDraft((d) => ({
      ...d,
      config:
        d.kind === "app-override"
          ? { ...d.config, policy: { ...d.config.policy, [key]: value } }
          : { ...d.config, [key]: value },
    }));
  return (
    <form
      className="form scenario-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          code: draft.code,
          name: draft.name,
          description: draft.description,
          kind: draft.kind,
          config: draft.config,
          expectedVersion: editing ? initial.version : 0,
        });
      }}
    >
      <fieldset disabled={busy}>
        <EditorBasics
          draft={draft}
          setDraft={setDraft}
          editing={editing}
          label="规则"
        />
        <label>
          规则阶段
          <select
            value={draft.kind}
            onChange={(e) => {
              const kind = RULE_KINDS.find((r) => r.kind === e.target.value);
              setDraft({
                ...draft,
                kind: kind.kind,
                config: withOptional(kind.kind, structuredClone(kind.defaults)),
              });
            }}
          >
            {RULE_KINDS.map((r) => (
              <option key={r.kind} value={r.kind}>
                {phaseNames[r.kind]} · {r.name}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted">
          {RULE_KINDS.find((r) => r.kind === draft.kind)?.description}
        </p>
        {draft.kind === "placement" ? (
          <label>
            放置方式
            <select
              value={draft.config.strategy}
              onChange={(e) => changeValue("strategy", e.target.value)}
            >
              {Object.entries(strategyNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {draft.kind === "app-override" ? (
          <label>
            适用平台
            <select
              value={draft.config.appId}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  config: { ...draft.config, appId: e.target.value },
                })
              }
            >
              {["xhs", "weibo", "xianyu", "pdd"].map((id) => (
                <option key={id} value={id}>
                  {appName(id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="form-grid">
          {fieldGroups[draft.kind].map(
            ([key, label, scale, min, max, unit, hint]) => (
              <label key={key}>
                {label}（{unit}）
                <input
                  type="number"
                  required
                  min={min}
                  max={max}
                  step={scale === 1 ? 1 : 0.001}
                  value={values?.[key] == null ? "" : values[key] / scale}
                  onChange={(e) =>
                    changeValue(key, Math.round(Number(e.target.value) * scale))
                  }
                />
                <small>{hint}</small>
              </label>
            ),
          )}
        </div>
        <p className="scenario-preview">
          <strong>规则效果</strong>
          {ruleSummary(draft)}
        </p>
        <button className="primary" type="submit">
          {editing ? "保存下一版本" : "创建规则"}
        </button>
      </fieldset>
    </form>
  );
}
function StrategyEditor({ initial, editing, rules, history, busy, onSubmit }) {
  const [draft, setDraft] = useState(() => ({
    code: "pool.custom",
    name: "自定义调度策略",
    description: "",
    ...initial,
  }));
  const [refs, setRefs] = useState(
    () =>
      initial?.rules?.map(({ code, version }) => ({ code, version })) ||
      ["placement", "queue", "app-budget"]
        .map((kind) => rules.find((r) => r.kind === kind))
        .filter(Boolean)
        .map(({ code, version }) => ({ code, version })),
  );
  const getRow = (ref) =>
    history.find((r) => r.code === ref.code && r.version === ref.version) ||
    initial?.rules?.find(
      (r) => r.code === ref.code && r.version === ref.version,
    )?.definition;
  const selected = refs
    .map((ref) => ({ ref, row: getRow(ref) }))
    .filter((r) => r.row);
  const invalidRefs = refs.some(
    (ref) => !rules.some((r) => r.code === ref.code),
  );
  function replace(kind, value) {
    const row =
      history.find((r) => r.id === value) || rules.find((r) => r.id === value);
    setRefs((current) => [
      ...current.filter((ref) => getRow(ref)?.kind !== kind),
      ...(row ? [{ code: row.code, version: row.version }] : []),
    ]);
  }
  return (
    <form
      className="form scenario-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          code: draft.code,
          name: draft.name,
          description: draft.description,
          rules: refs,
          expectedVersion: editing ? initial.version : 0,
        });
      }}
    >
      <fieldset disabled={busy}>
        <EditorBasics
          draft={draft}
          setDraft={setDraft}
          editing={editing}
          label="策略"
        />
        <div className="scenario-editor-intro">
          <h3>按阶段组合规则</h3>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setRefs((current) =>
                current.map((ref) => {
                  const row = rules.find((r) => r.code === ref.code);
                  return row ? { code: row.code, version: row.version } : ref;
                }),
              )
            }
          >
            升级到规则最新版本
          </button>
        </div>
        {["placement", "queue", "app-budget", "pacing"].map((kind, index) => {
          const current = selected.find((r) => r.row.kind === kind)?.row;
          const options = rules.filter((r) => r.kind === kind);
          if (current && !options.some((r) => r.id === current.id))
            options.unshift(current);
          return (
            <div className="scenario-rule-selector" key={kind}>
              <b>{index + 1}</b>
              <label>
                {phaseNames[kind]}
                <select
                  required={kind !== "pacing"}
                  aria-label={`${phaseNames[kind]}规则`}
                  value={current?.id || ""}
                  onChange={(e) => replace(kind, e.target.value)}
                >
                  <option value="">
                    {kind === "pacing"
                      ? "不使用（沿用机架循环设置）"
                      : "选择规则"}
                  </option>
                  {options.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} · v{row.version}
                      {rules.some((r) => r.id === row.id) ? "" : "（历史快照）"}
                    </option>
                  ))}
                </select>
                {current ? <small>{ruleSummary(current)}</small> : null}
              </label>
            </div>
          );
        })}
        <div className="scenario-override-list">
          <strong>平台例外（可选）</strong>
          <p className="small muted">
            为不同 App 覆盖默认预算；同一平台只选择一条。
          </p>
          {rules
            .filter((r) => r.kind === "app-override")
            .map((row) => {
              const frozen =
                selected.find((item) => item.row.code === row.code)?.row || row;
              return (
                <label key={row.id} className="scenario-check">
                  <input
                    type="checkbox"
                    checked={refs.some((ref) => ref.code === row.code)}
                    onChange={(e) =>
                      setRefs((current) =>
                        e.target.checked
                          ? [
                              ...current.filter((ref) => {
                                const r = getRow(ref);
                                return !(
                                  r?.kind === "app-override" &&
                                  r.config.appId === row.config.appId
                                );
                              }),
                              { code: row.code, version: row.version },
                            ]
                          : current.filter((ref) => ref.code !== row.code),
                      )
                    }
                  />
                  <span>
                    {frozen.name} · v{frozen.version}
                    {frozen.version !== row.version ? "（固定历史版本）" : ""}
                    <small>{ruleSummary(frozen)}</small>
                  </span>
                </label>
              );
            })}
          {selected
            .filter(
              ({ row }) =>
                row.kind === "app-override" &&
                !rules.some((r) => r.code === row.code),
            )
            .map(({ row }) => (
              <div className="scenario-preview" key={row.id}>
                <span>{row.name}（规则已归档）</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setRefs((current) =>
                      current.filter((r) => r.code !== row.code),
                    )
                  }
                >
                  移除此引用
                </button>
              </div>
            ))}
        </div>
        {invalidRefs ? (
          <p role="alert" className="error">
            引用的规则已归档。请替换规则后保存；已有策略仍保留原来的执行快照。
          </p>
        ) : null}
        <p className="small muted">
          保存时冻结各条规则的具体版本。后续修改规则不会悄悄改变已应用策略；需要明确保存并应用新策略版本。
        </p>
        <button
          className="primary"
          type="submit"
          disabled={
            invalidRefs ||
            !["placement", "queue", "app-budget"].every((kind) =>
              selected.some((r) => r.row.kind === kind),
            )
          }
        >
          {editing ? "保存下一版本" : "创建策略"}
        </button>
      </fieldset>
    </form>
  );
}

export default function Scenarios({ state, mode, busy, run, onOpenRack }) {
  const [tab, setTab] = useState("scenarios");
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [scenarios, setScenarios] = useState([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [scenario, setScenario] = useState("mixed");
  const [deviceCount, setDeviceCount] = useState(10);
  const [seed, setSeed] = useState(42);
  const [strategyId, setStrategyId] = useState("");
  const [rack, setRack] = useState("场景演练机架");
  const [result, setResult] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(null);
  useEffect(() => {
    if (mode !== "sim") {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.all([
      api("strategy-definitions", "sim", null, controller.signal),
      api("pool-scenarios", "sim", null, controller.signal),
    ])
      .then(([value, pool]) => {
        if (controller.signal.aborted) return;
        setCatalog(value);
        setScenarios(pool.scenarios);
        setStrategyId((current) =>
          value.strategies.some((r) => r.id === current)
            ? current
            : (
                value.strategies.find((r) => r.recommended) ||
                value.strategies[0]
              )?.id || "",
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, mode]);
  const chosen = catalog.strategies.find((r) => r.id === strategyId);
  const scenarioRow = scenarios.find((r) => r.id === scenario);
  const disabled = Boolean(busy || pending || loading);
  async function mutate(action, message) {
    setPending(true);
    setError("");
    try {
      const ok = await run(action, message);
      if (ok) {
        setModal(null);
        setReload((n) => n + 1);
      }
      return ok;
    } catch (cause) {
      setError(cause.message);
      return false;
    } finally {
      setPending(false);
    }
  }
  async function benchmark() {
    setPending(true);
    setError("");
    try {
      const report = await api("pool-simulate", "sim", {
        scenario,
        deviceCount,
        seed,
        policy: chosen.policy,
      });
      setResult({
        ...report,
        strategyId: chosen.id,
        strategyName: chosen.name,
      });
    } catch (cause) {
      setError(`本次对照失败：${cause.message}。已有报告仍是上一次成功结果。`);
    } finally {
      setPending(false);
    }
  }
  async function launch() {
    let launched;
    const ok = await mutate(async () => {
      launched = await api("workstation-demo", "sim", {
        key: requestId(),
        rack: rack.trim(),
        deviceCount,
        scenario,
        strategyId,
      });
      return launched;
    }, "场景任务已加入模拟工作台，策略已应用到所选机架");
    if (ok) onOpenRack?.(launched?.rack || rack.trim());
  }
  function open(action, row = null) {
    setModal({ action, row, type: tab === "rules" ? "rule" : "strategy" });
  }
  if (mode !== "sim")
    return (
      <section className="panel scenario-real-note">
        <Stack size={32} />
        <h2>场景与策略仅用于模拟演练</h2>
        <p className="muted">
          切换到模拟模式后，可管理版本化规则并验证调度。真实设备继续使用既有执行与隔离约束。
        </p>
      </section>
    );
  const rows = latest(
    tab === "rules" ? catalog.ruleHistory : catalog.history,
  ).filter(
    (row) =>
      (showArchived || !row.archived) &&
      `${row.name} ${row.code} ${row.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const currentReport =
    result &&
    result.scenario === scenario &&
    result.deviceCount === deviceCount &&
    result.seed === seed &&
    result.strategyId === strategyId;
  const historicalRows =
    modal?.action === "history"
      ? (modal.type === "rule" ? catalog.ruleHistory : catalog.history)
          .filter((row) => row.code === modal.row.code)
          .sort((a, b) => b.version - a.version)
      : [];
  return (
    <div className="scenarios-page">
      <div className="scenario-page-heading">
        <div>
          <span className="scenario-eyebrow">
            SCENARIOS / SCHEDULING POLICY
          </span>
          <h2>把调度决策变成可验证的场景</h2>
          <p>场景提供任务流量，策略组合规则，设备工作台呈现执行过程。</p>
        </div>
        <span className="scenario-mode-label">模拟环境</span>
      </div>
      <div className="scenario-tabs" aria-label="场景目录分类">
        {[
          ["scenarios", "演练场景", PlayCircle],
          ["strategies", "调度策略", SlidersHorizontal],
          ["rules", "规则库", Stack],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
              setQuery("");
            }}
          >
            <Icon size={18} />
            {label}
            <span>
              {id === "scenarios"
                ? scenarios.length
                : id === "strategies"
                  ? catalog.strategies.length
                  : catalog.rules.length}
            </span>
          </button>
        ))}
      </div>
      {error ? (
        <p className="error scenario-error" role="alert">
          {error}
          <button
            className="text-button"
            onClick={() => setReload((n) => n + 1)}
          >
            重新加载目录
          </button>
        </p>
      ) : null}
      {loading ? (
        <p className="muted scenario-loading">读取场景与版本化调度目录…</p>
      ) : tab === "scenarios" ? (
        <>
          <div className="scenario-selection-layout">
            <section className="scenario-gallery" aria-label="选择演练场景">
              {scenarios.map((row, index) => {
                const detail = scenarioDetails[row.id];
                return (
                  <button
                    className={`scenario-choice${scenario === row.id ? " selected" : ""}`}
                    key={row.id}
                    aria-pressed={scenario === row.id}
                    onClick={() => setScenario(row.id)}
                  >
                    <div className="scenario-choice-top">
                      <span>
                        {String(index + 1).padStart(2, "0")} / {detail?.label}
                      </span>
                      {scenario === row.id ? (
                        <Check size={18} weight="bold" />
                      ) : (
                        <ArrowRight size={18} />
                      )}
                    </div>
                    <strong>{row.name}</strong>
                    <p>{detail?.example || row.description}</p>
                    <div className="scenario-choice-foot">
                      <span className="scenario-spark" aria-hidden="true">
                        {detail?.shape.map((height, n) => (
                          <i key={n} style={{ height: `${height * 2}px` }} />
                        ))}
                      </span>
                      <small>
                        {liveScenarios.has(row.id)
                          ? "支持工作台演示"
                          : "虚拟时钟验证"}
                      </small>
                    </div>
                  </button>
                );
              })}
            </section>
            <section className="panel scenario-configuration">
              <div className="section-head">
                <div>
                  <span className="scenario-eyebrow">演练配置</span>
                  <h3>{scenarioRow?.name || "选择场景"}</h3>
                </div>
              </div>
              <fieldset disabled={disabled}>
                <label>
                  设备池规模
                  <div className="scenario-size-options">
                    {[2, 10, 20, 50, 100].map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={deviceCount === n}
                        onClick={() => setDeviceCount(n)}
                      >
                        {n}
                        <small>台</small>
                      </button>
                    ))}
                  </div>
                </label>
                <label>
                  调度策略
                  <select
                    aria-label="演练调度策略"
                    value={strategyId}
                    onChange={(e) => setStrategyId(e.target.value)}
                  >
                    {catalog.strategies.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name} · v{row.version}
                        {row.recommended ? "（推荐初始值）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="small muted">{chosen?.description}</p>
                <label>
                  随机种子
                  <input
                    aria-label="场景随机种子"
                    type="number"
                    min={0}
                    max={2147483647}
                    step={1}
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                  />
                </label>
                <small className="muted">
                  对照使用同一批任务、同一逐指令耗时。推荐是均衡初始值，结果随负载变化。
                </small>
                <button
                  className="primary"
                  disabled={
                    !chosen ||
                    !Number.isInteger(seed) ||
                    seed < 0 ||
                    seed > 2147483647
                  }
                  onClick={benchmark}
                >
                  <ChartBar size={19} />
                  {pending ? "正在处理…" : "运行策略对照"}
                </button>
                <p className="scenario-operation-note">
                  虚拟时钟独立运行，不向工作台提交任务。
                </p>
                <div className="scenario-live-launch">
                  <label>
                    工作台机架名
                    <input
                      aria-label="场景机架名称"
                      value={rack}
                      maxLength={80}
                      onChange={(e) => setRack(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={
                      !liveScenarios.has(scenario) || !chosen || !rack.trim()
                    }
                    onClick={launch}
                  >
                    <PlayCircle size={19} />
                    加入工作台演示
                  </button>
                  <small className="muted">
                    {liveScenarios.has(scenario)
                      ? "创建模拟设备并提交一批任务，按所选策略实际流转。现场 Worker 最多同时执行 10 台。"
                      : "此场景包含故障、能力变更或时钟事件，目前仅支持上方虚拟时钟验证。"}
                  </small>
                </div>
              </fieldset>
            </section>
          </div>
          <PolicyReading policy={chosen?.policy} />
          {result ? (
            <section className="panel scenario-report">
              <div className="section-head">
                <div>
                  <span className="scenario-eyebrow">
                    对照结果 · 隔离虚拟时钟
                  </span>
                  <h3>
                    {result.name} / {result.deviceCount} 台
                  </h3>
                  <p className="small muted">
                    {result.strategyName} · seed {result.seed}
                    {!currentReport
                      ? " · 当前配置已变化，重新运行以更新报告"
                      : ""}
                  </p>
                </div>
                <span
                  className={`scenario-result-status${result.summary.invariantViolations ? " warning" : ""}`}
                >
                  {result.summary.invariantViolations
                    ? `${result.summary.invariantViolations} 项违规`
                    : "调度约束通过"}
                </span>
              </div>
              <div className="scenario-table-wrap">
                <table className="scenario-table">
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>所选策略</th>
                      <th>分散优先对照</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      [
                        "完成任务 / 提交",
                        (s) => `${s.completed} / ${s.submitted}`,
                      ],
                      [
                        "吞吐量",
                        (s) =>
                          `${s.makespanMs ? ((s.completed * 60000) / s.makespanMs).toFixed(1) : 0} 个 / 分钟`,
                      ],
                      ["等待 P95", (s) => secs(s.waitP95Ms)],
                      [
                        "设备利用率",
                        (s) => `${(s.utilization * 100).toFixed(1)}%`,
                      ],
                      ["剩余排队 / 失败", (s) => `${s.queued} / ${s.failed}`],
                      [
                        "应用切换 / 重新规划",
                        (s) => `${s.appSwitches} / ${s.replans}`,
                      ],
                      [
                        "调度约束违规（含单机串行）",
                        (s) => s.invariantViolations,
                      ],
                    ].map(([label, format]) => (
                      <tr key={label}>
                        <th>{label}</th>
                        <td>{format(result.summary)}</td>
                        <td>{format(result.baseline)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="scenario-report-note">
                对照只改变放置方式，预算与工作负载保持一致。等待分位数只统计已开始任务，请同时查看积压。
              </p>
              <details className="scenario-report-events">
                <summary>
                  事件轨迹 · 最近 {Math.min(60, result.timeline.length)} /{" "}
                  {result.timeline.length} 条
                </summary>
                <ol>
                  {result.timeline.slice(-60).map((event, n) => (
                    <li key={n}>
                      <time>{secs(event.at)}</time>
                      <span>{event.message}</span>
                      <small>{event.type}</small>
                    </li>
                  ))}
                </ol>
              </details>
            </section>
          ) : (
            <div className="scenario-report-placeholder">
              <ChartBar size={24} />
              <p>运行对照后，在这里比较吞吐、等待、利用率与任务积压。</p>
            </div>
          )}
        </>
      ) : (
        <section className="panel scenario-catalog">
          <div className="scenario-catalog-toolbar">
            <div>
              <h3>{tab === "rules" ? "规则库" : "调度策略"}</h3>
              <p className="small muted">
                {tab === "rules"
                  ? "每条规则只负责一个阶段。修改保留历史，已应用策略继续使用冻结版本。"
                  : "放置、排队与冷却规则共同组成策略。在设备工作台选择并应用到机架。"}
              </p>
            </div>
            <button
              disabled={disabled}
              className="primary"
              onClick={() => open("create")}
            >
              <Plus size={18} />
              新增{tab === "rules" ? "规则" : "策略"}
            </button>
          </div>
          <div className="scenario-catalog-filter">
            <input
              aria-label="查找策略或规则"
              value={query}
              placeholder="查找名称或代码"
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="scenario-check">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              包含已归档
            </label>
            <button
              className="icon-button"
              aria-label="刷新策略目录"
              disabled={disabled}
              onClick={() => setReload((n) => n + 1)}
            >
              <ArrowClockwise size={19} />
            </button>
          </div>
          <div className="scenario-table-wrap">
            <table className="scenario-table">
              <thead>
                <tr>
                  <th>{tab === "rules" ? "规则" : "策略"}</th>
                  <th>{tab === "rules" ? "阶段与效果" : "组合与决策"}</th>
                  <th>版本</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.archived ? "scenario-archived" : ""}
                  >
                    <td>
                      <strong>{row.name}</strong>
                      <code>{row.code}</code>
                      {row.recommended && !row.archived ? (
                        <span className="scenario-tag">推荐初始策略</span>
                      ) : null}
                      {row.archived ? (
                        <span className="scenario-tag">已归档</span>
                      ) : null}
                      <small>{row.description}</small>
                    </td>
                    <td>
                      {tab === "rules" ? (
                        <>
                          <span className="scenario-tag">
                            {phaseNames[row.kind]}
                          </span>
                          <p>{ruleSummary(row)}</p>
                        </>
                      ) : (
                        <>
                          <div className="scenario-rule-chain">
                            {row.rules?.map((ref) => (
                              <span key={ref.code}>
                                {ref.definition?.name || ref.code}
                                <small>v{ref.version}</small>
                              </span>
                            ))}
                          </div>
                          <PolicyReading policy={row.policy} compact />
                        </>
                      )}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => open("history", row)}
                        aria-label={`查看 ${row.code} 版本历史`}
                      >
                        v{row.version}
                      </button>
                    </td>
                    <td>
                      <div className="scenario-row-actions">
                        <button
                          disabled={disabled}
                          className="text-button"
                          onClick={() => open("edit", row)}
                          aria-label={`${row.archived ? "恢复" : "编辑"} ${row.code}`}
                        >
                          <PencilSimple size={15} />
                          {row.archived ? "恢复" : "编辑"}
                        </button>
                        <button
                          disabled={disabled}
                          className="text-button"
                          onClick={() => open("clone", row)}
                          aria-label={`复制 ${row.code}`}
                        >
                          <Copy size={15} />
                          复制
                        </button>
                        {!row.archived ? (
                          <button
                            disabled={disabled}
                            className="text-button"
                            onClick={() => open("archive", row)}
                            aria-label={`归档 ${row.code}`}
                          >
                            <Archive size={15} />
                            归档
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length ? (
              <p className="scenario-empty muted">
                没有符合条件的{tab === "rules" ? "规则" : "策略"}。
              </p>
            ) : null}
          </div>
        </section>
      )}
      {modal ? (
        <Modal
          title={`${{ create: "新增", edit: modal.row?.archived ? "恢复" : "编辑", clone: "复制", archive: "归档", history: "版本历史" }[modal.action]}${modal.type === "rule" ? "规则" : "策略"}`}
          onClose={() => {
            if (!pending) setModal(null);
          }}
          className="scenario-modal"
        >
          {modal.action === "archive" ? (
            <div className="form">
              <p>归档「{modal.row.name}」？</p>
              <p className="muted">
                {modal.type === "rule"
                  ? "已有策略继续保留该规则的冻结快照；新策略不能再引用已归档规则。"
                  : "该策略将从新应用列表移除；机架已应用的快照与在途任务继续有效。"}
                历史版本和执行证据都会保留，之后可恢复为新版本。
              </p>
              <button
                className="primary"
                disabled={disabled}
                onClick={() =>
                  mutate(
                    () => archiveDefinition(modal.type, modal.row),
                    "已归档，历史与已应用快照保留",
                  )
                }
              >
                确认归档
              </button>
            </div>
          ) : modal.action === "history" ? (
            <div className="scenario-table-wrap">
              <table className="scenario-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>定义</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalRows.map((row) => (
                    <tr key={row.id}>
                      <td>v{row.version}</td>
                      <td>
                        {row.archived ? "归档记录" : "有效快照"}
                        <small>
                          {row.createdAt
                            ? new Date(row.createdAt).toLocaleString("zh-CN")
                            : "内置迁移"}
                        </small>
                      </td>
                      <td>
                        <strong>{row.name}</strong>
                        <small>
                          {modal.type === "rule"
                            ? ruleSummary(row)
                            : row.rules
                                ?.map((r) => `${r.code} @ v${r.version}`)
                                .join(" → ")}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : modal.type === "rule" ? (
            <RuleEditor
              busy={disabled}
              editing={modal.action === "edit"}
              initial={
                modal.row
                  ? {
                      ...modal.row,
                      ...(modal.action === "clone"
                        ? {
                            code: `${modal.row.code}.copy`.slice(0, 60),
                            name: `${modal.row.name} · 副本`.slice(0, 80),
                          }
                        : {}),
                    }
                  : undefined
              }
              onSubmit={(body) =>
                mutate(
                  () => api("rule-definitions", "sim", body),
                  "规则已保存为新版本；已应用策略保持原快照",
                )
              }
            />
          ) : (
            <StrategyEditor
              busy={disabled}
              editing={modal.action === "edit"}
              rules={catalog.rules}
              history={catalog.ruleHistory}
              initial={
                modal.row
                  ? {
                      ...modal.row,
                      ...(modal.action === "clone"
                        ? {
                            code: `${modal.row.code}.copy`.slice(0, 60),
                            name: `${modal.row.name} · 副本`.slice(0, 80),
                          }
                        : {}),
                    }
                  : undefined
              }
              onSubmit={(body) =>
                mutate(
                  () => api("strategy-definitions", "sim", body),
                  "策略已保存；可在设备工作台选择应用",
                )
              }
            />
          )}
        </Modal>
      ) : null}
    </div>
  );
}
