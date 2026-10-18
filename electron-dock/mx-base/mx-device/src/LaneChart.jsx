import { Fragment, useEffect, useRef, useState } from "react";
import { appName } from "./data.js";
import { APP_COLORS, CRITICAL, inkOn } from "./timeline-model.mjs";
import "./timeline.css";

const pct = (t, start, span) => ((t - start) / span) * 100;
const secs = (ms) =>
  ms == null
    ? "—"
    : ms < 60000
      ? `${Math.round(ms / 100) / 10} 秒`
      : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
const KIND_NAMES = {
  run: "执行",
  failed: "结果待核验",
  remaining: "预计剩余",
  plan: "软计划（可变）",
  cooldown: "App 冷却",
  rest: "整机休息",
  quarantine: "隔离",
};

function tooltipLines(block, lane, clock) {
  const lines = [[KIND_NAMES[block.kind], block.label]];
  if (block.kind === "run" || block.kind === "failed") {
    if (block.steps)
      lines.push([
        "进度",
        `${Math.min(block.done, block.steps)} / ${block.steps} 步`,
      ]);
    lines.push([
      "耗时",
      `实际 ${secs(block.actualMs)} · 预计 ${secs(block.estimateMs)}`,
    ]);
    lines.push(["状态", block.status]);
    if (block.executor === "agent") lines.push(["执行", "宿主机 Agent"]);
  }
  if (block.kind === "plan") {
    lines.push(["预计开始", clock(block.start)]);
    lines.push(["原因", block.reason || "—"]);
    if (block.switchMs) lines.push(["App 切换", secs(block.switchMs)]);
    if (block.moves) lines.push(["改派", `${block.moves} 次`]);
  }
  if (block.until) lines.push(["截止", clock(block.until)]);
  if (block.reason && block.kind === "rest") lines.push(["原因", block.reason]);
  lines.push(["设备", lane.name]);
  return lines;
}

/** Device lanes over a time window. Shared by the live timeline and replay.
 * Bars carry App identity (validated palette, legend + inline labels); plans
 * are dashed outlines; cooldowns and rests are thin bands under the bars. */
export default function LaneChart({
  lanes,
  start,
  end,
  now,
  ticks = [],
  clock = (t) => new Date(t).toLocaleTimeString(),
  compact = false,
  onBlock,
  onLane,
  onDropPlan,
  caption,
}) {
  const span = Math.max(1, end - start);
  const track = useRef(null);
  const [width, setWidth] = useState(600);
  const [tip, setTip] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width || 600),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Compact mode groups lanes by rack; a group expands on click.
  const groups = [];
  for (const lane of lanes) {
    const key = lane.rack || "—";
    let group = groups.find((g) => g.key === key);
    if (!group) groups.push((group = { key, lanes: [] }));
    group.lanes.push(lane);
  }
  const showTip = (e, block, lane) => {
    const box = e.currentTarget.closest(".lc-root").getBoundingClientRect();
    setTip({
      x: Math.min(e.clientX - box.left + 14, box.width - 260),
      y: e.clientY - box.top + 14,
      lines: tooltipLines(block, lane, clock),
    });
  };
  const renderLane = (lane, dense) => (
    <div
      className={`lc-lane${dense ? " dense" : ""}${dragOver === lane.id ? " drop" : ""}`}
      key={lane.id}
      onDragOver={
        onDropPlan
          ? (e) => {
              e.preventDefault();
              setDragOver(lane.id);
            }
          : undefined
      }
      onDragLeave={() => setDragOver((v) => (v === lane.id ? null : v))}
      onDrop={
        onDropPlan
          ? (e) => {
              e.preventDefault();
              setDragOver(null);
              const jobId = e.dataTransfer.getData("text/mx-job");
              if (jobId) onDropPlan(jobId, lane);
            }
          : undefined
      }
    >
      <button
        className="lc-label"
        title={`${lane.name}${lane.host ? ` · ${lane.host}` : ""}`}
        onClick={() => onLane?.(lane)}
      >
        {!dense && lane.name}
        {!dense && lane.agent && <small>Agent</small>}
      </button>
      <div className="lc-track">
        {lane.blocks.map((b) => {
          const left = pct(b.start, start, span),
            w = pct(b.end, start, span) - left;
          if (w <= 0) return null;
          const color =
            b.kind === "failed" || b.kind === "quarantine"
              ? CRITICAL
              : APP_COLORS[b.appId] || "#898781";
          const px = (w / 100) * width;
          const band = ["cooldown", "rest"].includes(b.kind);
          const style = {
            left: `${left}%`,
            width: `max(1px, calc(${w}% - 2px))`,
            "--c": color,
            color: ["run", "failed"].includes(b.kind)
              ? inkOn(color)
              : undefined,
          };
          const label =
            !dense && px > 64 && !band && b.kind !== "quarantine"
              ? b.kind === "failed"
                ? `! ${b.label}`
                : b.label
              : !dense && px > 90 && b.kind === "quarantine"
                ? `! ${b.label}`
                : "";
          return (
            <div
              key={b.id}
              className={`lc-block lc-${b.kind}`}
              style={style}
              role="img"
              aria-label={`${lane.name} ${KIND_NAMES[b.kind]} ${b.label}`}
              tabIndex={b.kind === "plan" || b.kind === "run" ? 0 : -1}
              draggable={b.kind === "plan" && !!onDropPlan}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/mx-job", b.jobId);
                e.dataTransfer.effectAllowed = "move";
                setTip(null);
              }}
              onPointerMove={(e) => showTip(e, b, lane)}
              onPointerLeave={() => setTip(null)}
              onFocus={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                showTip(
                  {
                    ...e,
                    clientX: r.left,
                    clientY: r.bottom,
                    currentTarget: e.currentTarget,
                  },
                  b,
                  lane,
                );
              }}
              onBlur={() => setTip(null)}
              onClick={() => b.jobId && onBlock?.(b, lane)}
            >
              {label && <span>{label}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className={`lc-root${compact ? " compact" : ""}`}>
      {caption && <div className="lc-caption">{caption}</div>}
      <div className="lc-axis">
        <span className="lc-label" />
        <div className="lc-track" ref={track}>
          {ticks.map((t) => (
            <span
              key={t.at}
              className="lc-tick"
              style={{ left: `${pct(t.at, start, span)}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
      <div className="lc-body">
        <div className="lc-grid" aria-hidden="true">
          <span className="lc-label" />
          <div className="lc-track">
            {ticks.map((t) => (
              <i key={t.at} style={{ left: `${pct(t.at, start, span)}%` }} />
            ))}
            {now >= start && now <= end && (
              <b
                className="lc-now"
                style={{ left: `${pct(now, start, span)}%` }}
              />
            )}
          </div>
        </div>
        {compact
          ? groups.map((g) => (
              <Fragment key={g.key}>
                <button
                  className="lc-group"
                  aria-expanded={open.has(g.key)}
                  onClick={() =>
                    setOpen((s) => {
                      const next = new Set(s);
                      next.has(g.key) ? next.delete(g.key) : next.add(g.key);
                      return next;
                    })
                  }
                >
                  {open.has(g.key) ? "▾" : "▸"} {g.key}
                  <small>{g.lanes.length} 台</small>
                </button>
                {g.lanes.map((lane) => renderLane(lane, !open.has(g.key)))}
              </Fragment>
            ))
          : lanes.map((lane) => renderLane(lane, false))}
      </div>
      <div className="lc-legend">
        {Object.entries(APP_COLORS).map(([id, color]) => (
          <span key={id}>
            <i style={{ background: color }} />
            {appName(id)}
          </span>
        ))}
        <span>
          <i className="key-plan" />
          软计划
        </span>
        <span>
          <i className="key-cooldown" />
          App 冷却
        </span>
        <span>
          <i className="key-rest" />
          整机休息
        </span>
        <span>
          <i style={{ background: CRITICAL }} />! 待核验
        </span>
      </div>
      {tip && (
        <div className="lc-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.lines.map(([k, v], i) => (
            <div key={i} className={i === 0 ? "lc-tip-head" : ""}>
              {i === 0 ? (
                <>
                  <strong>{v}</strong>
                  <small>{k}</small>
                </>
              ) : (
                <>
                  <small>{k}</small>
                  <span>{v}</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
