import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import { flowModel } from "./flow-model.mjs";

const secs = (ms) =>
  ms == null
    ? "—"
    : ms < 60000
      ? `${Math.round(ms / 100) / 10} 秒`
      : `${Math.round(ms / 6000) / 10} 分钟`;

/** Lifecycle stages with counts, plus throughput and waits (last 3 minutes). */
export default function FlowView({ state, rack, now, onStage }) {
  const flow = flowModel(state, { rack, now });
  return (
    <div className="flow-view">
      <div className="flow-kpis">
        <div>
          <strong>{flow.throughputPerMin}</strong>
          <span>个/分钟 · 近 3 分钟吞吐</span>
        </div>
        <div>
          <strong>{secs(flow.waitP50Ms)}</strong>
          <span>排队等待 P50</span>
        </div>
        <div>
          <strong>{secs(flow.waitP95Ms)}</strong>
          <span>排队等待 P95</span>
        </div>
      </div>
      <ol className="flow-stages" aria-label="任务生命周期">
        {flow.stages.map((stage, i) => (
          <li key={stage.id}>
            {i > 0 && (
              <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />
            )}
            <button
              className={`flow-stage flow-${stage.id}`}
              onClick={() => onStage?.(stage.id)}
            >
              <span>{stage.label}</span>
              <strong>{stage.count}</strong>
              <small>{stage.note}</small>
            </button>
          </li>
        ))}
      </ol>
      <div className="flow-abnormal">
        <span className="flow-abnormal-title">
          <WarningCircle size={16} weight="fill" />
          异常终态（近 3 分钟）
        </span>
        {flow.abnormal.length ? (
          flow.abnormal.map((x) => (
            <span key={x.status} className={`flow-chip flow-chip-${x.status}`}>
              {x.label} <b>{x.count}</b>
            </span>
          ))
        ) : (
          <span className="muted">无</span>
        )}
      </div>
      <p className="muted small">
        已计划的任务仍可改派；已签租约表示设备已绑定但尚未发出指令，这时撤回不会产生副作用。
      </p>
    </div>
  );
}
