import { useEffect, useState } from "react";
import { ChartBar, PlayCircle } from "@phosphor-icons/react";
import { api, appName } from "./data.js";
import { DEMO_RACK } from "../server/workflow-catalog.mjs";
import { DEFAULT_POOL_POLICY } from "../server/pool-policy.mjs";

const fields = [
  [
    "idleSpreadThresholdPct",
    "空闲分散阈值",
    "%",
    1,
    0,
    100,
    "自适应策略中，空闲比例超过阈值时优先利用空闲设备。",
  ],
  [
    "maxAffinityDelayMs",
    "同应用亲和等待",
    "秒",
    0.001,
    0,
    3600,
    "为减少应用切换，最多容忍的额外排队时间。",
  ],
  [
    "maxQueueWaitMs",
    "计划等待预算",
    "秒",
    0.001,
    0,
    86400,
    "预计等待超过预算时留在任务池，后续重新规划；不是完成时限。",
  ],
  [
    "maxQueuePerDevice",
    "单设备计划队列上限",
    "个",
    1,
    1,
    10000,
    "限制计划排队长度，未领取任务仍可重新规划。",
  ],
  [
    "shortTaskMs",
    "短任务估时阈值",
    "秒",
    0.001,
    1,
    180,
    "校准估时不超过此值的任务可优先同应用排队；不改变检查点或抢占契约。",
  ],
];
const appFields = [
  ["windowMs", "服务窗口", "秒", 0.001, 1, 86400],
  ["maxRuns", "窗口任务上限", "个", 1, 1, 10000],
  ["maxServiceMs", "累计服务预算", "秒", 0.001, 0.2, 86400],
  ["cooldownMs", "冷却时长", "秒", 0.001, 0, 86400],
];
const strategyNames = {
  adaptive: "自适应亲和与分散",
  spread: "空闲分散优先",
  affinity: "同应用亲和优先",
};
const applicationName = (id) => (id === "xianyu" ? "闲鱼" : appName(id));
const duration = (n) =>
  Number.isFinite(n) ? `${(n / 1000).toFixed(1)} 秒` : "—";
const count = (n) => (Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—");
const percent = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—");
const metrics = [
  ["completed", "完成任务", count],
  ["failed", "失败任务", count],
  ["queued", "剩余排队", count],
  ["makespanMs", "模拟总时长", duration],
  ["waitP50Ms", "等待 P50", duration],
  ["waitP95Ms", "等待 P95", duration],
  ["turnaroundP95Ms", "周转 P95", duration],
  ["utilization", "设备利用率", percent],
  ["appSwitches", "应用切换", count],
  ["replans", "队列重新规划", count],
  ["invariantViolations", "调度约束违规", count],
];

export default function PoolSimulator({ policy, busy, run, canApply }) {
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [scenario, setScenario] = useState("mixed");
  const [deviceCount, setDeviceCount] = useState(10);
  const [seed, setSeed] = useState(42);
  const [settings, setSettings] = useState(DEFAULT_POOL_POLICY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    setError("");
    api("pool-scenarios", "sim", null, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setCatalog(value.scenarios);
        setScenario((current) =>
          value.scenarios.some((s) => s.id === current)
            ? current
            : value.scenarios[0]?.id || "",
        );
        setSettings({ ...DEFAULT_POOL_POLICY, ...value.defaults });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(`演练场景加载失败：${e.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  async function simulate(event) {
    event.preventDefault();
    setPending(true);
    setError("");
    setApplied(false);
    const request = {
      scenario,
      deviceCount: Number(deviceCount),
      seed: Number(seed),
      policy: { ...settings },
    };
    try {
      const report = await api("pool-simulate", "sim", request);
      setResult({
        ...report,
        request,
        appliedPolicy: report.policy || request.policy,
      });
    } catch (e) {
      setError(`本次演练失败：${e.message}。已有报告仍对应上一次成功演练。`);
    } finally {
      setPending(false);
    }
  }

  async function applyPolicy() {
    if (!result) return;
    const ok = await run(
      () =>
        api("loop-policy", "sim", {
          ...policy,
          rack: DEMO_RACK,
          scheduler: { ...policy.scheduler, ...result.appliedPolicy },
        }),
      "报告中的调度策略已应用到模拟实验机架；在途任务继续原执行契约",
    );
    if (ok) setApplied(true);
  }

  async function disablePolicy() {
    const ok = await run(
      () =>
        api("loop-policy", "sim", {
          rack: DEMO_RACK,
          revision: policy.revision,
          scheduler: { enabled: false },
        }),
      "模拟机架已恢复原领取策略；已产生的冷却仍保留",
    );
    if (ok) setApplied(false);
  }

  const selectedScenario = catalog.find((s) => s.id === scenario);
  const configuredApps = [
    ...new Set([
      "xhs",
      "weibo",
      "xianyu",
      "pdd",
      ...Object.keys(settings.appPolicies),
    ]),
  ];
  const events = result?.timeline || [];
  return (
    <section
      className="panel pool-simulator"
      aria-labelledby="pool-simulator-title"
    >
      <div className="section-head">
        <div>
          <span className="lab-eyebrow">
            TASK SCHEDULING CENTER / VIRTUAL CLOCK
          </span>
          <h2 id="pool-simulator-title">调度池 · 策略对照演练</h2>
          <p className="small muted">
            用相同场景和随机种子比较调度结果，验证从 2 台到 100 台的资源分配。
          </p>
        </div>
        <ChartBar size={27} aria-hidden="true" />
      </div>
      <div className="panel-body">
        <p className="pool-isolation">
          独立虚拟时钟 · 不调用手机接口 · 本次演练不向上方实时模拟机架提交任务
        </p>
        <form onSubmit={simulate}>
          <fieldset
            className="pool-fields"
            disabled={catalogLoading || pending}
          >
            <legend className="sr-only">演练场景与调度参数</legend>
            <div className="pool-scenario-fields">
              <label>
                演练场景
                <select
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                  required
                >
                  {!catalog.length && (
                    <option value="">
                      {catalogLoading ? "正在加载场景…" : "暂无场景"}
                    </option>
                  )}
                  {catalog.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                设备池大小
                <select
                  value={deviceCount}
                  onChange={(e) => setDeviceCount(Number(e.target.value))}
                >
                  {[2, 10, 20, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n} 台
                    </option>
                  ))}
                </select>
              </label>
              <label>
                随机种子
                <input
                  type="number"
                  value={seed}
                  min="0"
                  max="2147483647"
                  step="1"
                  required
                  onChange={(e) => setSeed(e.target.value)}
                />
              </label>
            </div>
            <p className="small muted pool-scenario-description">
              {selectedScenario?.description ||
                "选择设备规模与流量场景后开始演练。"}
            </p>
            <details className="pool-policy-controls">
              <summary>调整调度参数</summary>
              <label className="pool-strategy-field">
                调度策略
                <select
                  value={settings.strategy}
                  onChange={(e) =>
                    setSettings((current) => ({
                      ...current,
                      strategy: e.target.value,
                    }))
                  }
                >
                  {Object.entries(strategyNames).map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pool-policy-grid">
                {fields.map(([key, label, unit, scale, min, max, hint]) => (
                  <label key={key}>
                    {label}（{unit}）
                    <input
                      type="number"
                      value={
                        settings[key] === ""
                          ? ""
                          : Number((settings[key] * scale).toFixed(3))
                      }
                      min={min}
                      max={max}
                      step={scale === 1 ? 1 : 0.1}
                      required
                      onChange={(e) =>
                        setSettings((current) => ({
                          ...current,
                          [key]:
                            e.target.value === ""
                              ? ""
                              : Number(e.target.value) / scale,
                        }))
                      }
                    />
                    <small>{hint}</small>
                  </label>
                ))}
              </div>
              <h3 className="pool-app-policy-title">应用服务与冷却</h3>
              <p className="small muted">
                默认规则适用于未单独配置的应用。设置服务窗口、任务次数、累计服务预算和冷却时间，共同约束连续工作。
              </p>
              <div className="pool-policy-grid">
                {appFields.map(([key, label, unit, scale, min, max]) => (
                  <PolicyNumber
                    key={key}
                    label={`默认${label}`}
                    unit={unit}
                    scale={scale}
                    min={min}
                    max={max}
                    value={settings.appDefaults[key]}
                    onChange={(value) =>
                      setSettings((current) => ({
                        ...current,
                        appDefaults: { ...current.appDefaults, [key]: value },
                      }))
                    }
                  />
                ))}
              </div>
              <div className="pool-app-overrides">
                {configuredApps.map((appId) => {
                  const custom = settings.appPolicies[appId];
                  return (
                    <div className="pool-app-override" key={appId}>
                      <label className="pool-override-toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(custom)}
                          onChange={(e) =>
                            setSettings((current) => {
                              const appPolicies = { ...current.appPolicies };
                              if (e.target.checked)
                                appPolicies[appId] = { ...current.appDefaults };
                              else delete appPolicies[appId];
                              return { ...current, appPolicies };
                            })
                          }
                        />
                        {applicationName(appId)} ·{" "}
                        {custom ? "单独配置" : "使用默认规则"}
                      </label>
                      {custom && (
                        <div className="pool-policy-grid">
                          {appFields.map(
                            ([key, label, unit, scale, min, max]) => (
                              <PolicyNumber
                                key={key}
                                label={`${applicationName(appId)}${label}`}
                                unit={unit}
                                scale={scale}
                                min={min}
                                max={max}
                                value={custom[key] ?? settings.appDefaults[key]}
                                onChange={(value) =>
                                  setSettings((current) => ({
                                    ...current,
                                    appPolicies: {
                                      ...current.appPolicies,
                                      [appId]: {
                                        ...current.appPolicies[appId],
                                        [key]: value,
                                      },
                                    },
                                  }))
                                }
                              />
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
            <div className="pool-run-row">
              <p className="small muted">
                领取前的排队计划可重算；领取后保持会话独占。亲和、空闲分散与老化共同参与排队决策。
              </p>
              <button
                className="primary"
                type="submit"
                disabled={!catalog.length || pending}
              >
                <PlayCircle size={19} />
                {pending ? "演练计算中…" : "运行策略对照"}
              </button>
            </div>
          </fieldset>
        </form>
        {error && (
          <p className="feedback error" role="alert">
            {error}
          </p>
        )}
        {!catalogLoading && !catalog.length && (
          <button onClick={() => setReload((n) => n + 1)}>重新加载场景</button>
        )}
        {pending && (
          <p className="small muted" role="status">
            正在虚拟时钟中执行两组相同任务，结果不会改变实时机架。
          </p>
        )}
        {!result && !pending && (
          <p className="pool-empty small muted">
            尚无报告。演练结果将展示吞吐、尾部等待、利用率与调度约束；策略优劣取决于具体负载。
          </p>
        )}
        {result && (
          <div className="pool-report" aria-busy={pending}>
            <div className="pool-report-head">
              <div>
                <h3>
                  本次报告 ·{" "}
                  {result.name ||
                    catalog.find((s) => s.id === result.request.scenario)
                      ?.name ||
                    result.request.scenario}
                </h3>
                <p className="small muted">
                  {result.deviceCount || result.request.deviceCount} 台设备 ·
                  种子 {result.seed ?? result.request.seed} · 提交{" "}
                  {count(result.summary?.submitted)} 个任务 · 同一负载对照
                </p>
              </div>
              <span
                className={`pool-check ${result.summary?.invariantViolations > 0 ? "has-violations" : ""}`}
              >
                约束违规 {count(result.summary?.invariantViolations)}
              </span>
            </div>
            <div className="table-scroll">
              <table className="pool-comparison">
                <caption className="sr-only">
                  本次策略与空闲分散基线的模拟指标比较
                </caption>
                <thead>
                  <tr>
                    <th scope="col">指标</th>
                    <th scope="col">
                      {strategyNames[result.appliedPolicy.strategy] ||
                        "本次调度策略"}
                    </th>
                    <th scope="col">空闲分散基线</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map(([key, label, format]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{format(result.summary?.[key])}</td>
                      <td>{format(result.baseline?.[key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted pool-comparison-note">
              P95 表示 95%
              样本不超过的时间。指标用于比较这次负载，不代表所有流量下的最优策略；剩余排队和失败也要一起评估。
            </p>
            <details className="pool-report-details">
              <summary>查看这次报告的策略参数</summary>
              <dl className="pool-applied-settings">
                <div>
                  <dt>调度策略</dt>
                  <dd>{strategyNames[result.appliedPolicy.strategy]}</dd>
                </div>
                {fields.map(([key, label, unit, scale]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {Number((result.appliedPolicy[key] * scale).toFixed(3))}{" "}
                      {unit}
                    </dd>
                  </div>
                ))}
                {appFields.map(([key, label, unit, scale]) => (
                  <div key={key}>
                    <dt>默认{label}</dt>
                    <dd>
                      {Number(
                        (result.appliedPolicy.appDefaults[key] * scale).toFixed(
                          3,
                        ),
                      )}{" "}
                      {unit}
                    </dd>
                  </div>
                ))}
              </dl>
              {Object.entries(result.appliedPolicy.appPolicies || {}).map(
                ([appId, config]) => (
                  <p className="small muted" key={appId}>
                    {applicationName(appId)}：
                    {appFields
                      .map(
                        ([key, label, unit, scale]) =>
                          `${label} ${Number(((config[key] ?? result.appliedPolicy.appDefaults[key]) * scale).toFixed(3))} ${unit}`,
                      )
                      .join(" · ")}
                  </p>
                ),
              )}
              <p className="small muted">
                报告保留演练初始参数；场景中的策略替换见事件。修改上方表单后需要重新运行才会生成新报告。
              </p>
            </details>
            {result.devices?.length > 0 && (
              <details className="pool-report-details">
                <summary>设备负载分布（{result.devices.length} 台）</summary>
                <div className="pool-device-loads">
                  {result.devices.map((device) => (
                    <div key={device.id}>
                      <strong>{device.name || device.id}</strong>
                      <span>
                        完成 {count(device.completed)} · 忙碌{" "}
                        {duration(device.busyMs)}
                      </span>
                      <progress
                        aria-label={`${device.name || device.id} 忙碌比例`}
                        max={Math.max(1, result.summary?.makespanMs || 1)}
                        value={device.busyMs || 0}
                      />
                    </div>
                  ))}
                </div>
              </details>
            )}
            <details className="pool-report-details">
              <summary>
                调度决策与事件（展示前 {Math.min(events.length, 80)} 条）
              </summary>
              <p className="small muted">
                时间为相对模拟时间。完整任务统计以上方指标为准。
              </p>
              <ol className="pool-event-list">
                {events.slice(0, 80).map((event, i) => (
                  <li key={`${event.at}-${i}`}>
                    <time>+{duration(event.at)}</time>
                    <div>
                      <strong>{event.message || event.type}</strong>
                      <small>
                        {[
                          event.jobId,
                          event.deviceId,
                          event.appId ? applicationName(event.appId) : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              {!events.length && (
                <p className="small muted">本次未返回事件明细。</p>
              )}
            </details>
            <div className="pool-limitations">
              <h4>演练边界</h4>
              <ul>
                {(result.limitations?.length
                  ? result.limitations
                  : [
                      "模拟耗时与冷却规则用于比较调度行为，真实手机性能、应用状态和 adapter 回执仍需独立验收。",
                    ]
                ).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="pool-live-apply">
              <div>
                <strong>应用到实时模拟机架</strong>
                <p className="small muted">
                  仅更新「{DEMO_RACK}
                  」的调度参数，保留循环与冷却配置。使用这次报告的参数。
                </p>
                {policy.scheduler?.enabled && (
                  <p className="small muted">
                    当前已启用：{strategyNames[policy.scheduler.strategy]}
                  </p>
                )}
              </div>
              <button
                onClick={applyPolicy}
                disabled={
                  busy ||
                  pending ||
                  !canApply ||
                  applied ||
                  result.summary?.invariantViolations !== 0
                }
              >
                {applied ? "已应用此报告策略" : "应用这次报告的策略"}
              </button>
              {policy.scheduler?.enabled && (
                <button disabled={busy || pending} onClick={disablePolicy}>
                  停用机架池策略
                </button>
              )}
            </div>
            {!canApply && (
              <p className="small muted">
                上方创建实验机架后可应用策略；独立演练无需创建实时设备。
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function PolicyNumber({ label, unit, scale, min, max, value, onChange }) {
  return (
    <label>
      {label}（{unit}）
      <input
        type="number"
        value={value === "" ? "" : Number((value * scale).toFixed(3))}
        min={min}
        max={max}
        step={scale === 1 ? 1 : 0.1}
        required
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : Number(e.target.value) / scale)
        }
      />
    </label>
  );
}
