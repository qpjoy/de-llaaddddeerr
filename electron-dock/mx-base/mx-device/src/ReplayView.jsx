import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipForward } from "@phosphor-icons/react";
import LaneChart from "./LaneChart.jsx";
import { lanesAt } from "./timeline-model.mjs";

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const SPEEDS = [1, 5, 20];

const progress = (lanes, t) => {
  let done = 0,
    running = 0;
  for (const lane of lanes)
    for (const b of lane.blocks)
      if (b.start <= t) b.end <= t ? done++ : running++;
  return { done, running };
};

/** Replays a strategy comparison in the same lane component as the live
 * workbench: 1×/5×/20×, scrubbing, and the two strategies side by side. */
export default function ReplayView({ result }) {
  const end = Math.max(
    result.summary?.makespanMs || 0,
    result.baseline?.makespanMs || 0,
    1000,
  );
  const [t, setT] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(5),
    [split, setSplit] = useState(true);
  const frame = useRef(null);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (at) => {
      const dt = at - last;
      last = at;
      setT((value) => {
        const next = Math.min(end, value + dt * speed);
        if (next >= end) setPlaying(false);
        return next;
      });
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, speed, end]);
  // A new comparison starts from the beginning.
  useEffect(() => {
    setT(0);
    setPlaying(false);
  }, [result]);
  const tickStep = end > 300000 ? 60000 : end > 90000 ? 30000 : 10000;
  const ticks = [];
  for (let at = 0; at <= end; at += tickStep)
    ticks.push({ at, label: clock(at) });
  const runs = [
    { title: `所选策略 · ${result.strategyName}`, lanes: result.lanes || [] },
    ...(split
      ? [{ title: "空闲分散基线", lanes: result.baselineLanes || [] }]
      : []),
  ];
  return (
    <div className="replay">
      <div className="replay-controls">
        <button
          className="primary"
          onClick={() => {
            if (t >= end) setT(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? (
            <Pause size={16} weight="fill" />
          ) : (
            <Play size={16} weight="fill" />
          )}
          {playing ? "暂停" : t > 0 && t < end ? "继续" : "播放"}
        </button>
        <div className="replay-speed" role="group" aria-label="回放速度">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={speed === s ? "selected" : ""}
              aria-pressed={speed === s}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={end}
          step={100}
          value={Math.round(t)}
          aria-label="回放时间"
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
        />
        <span className="replay-time">
          {clock(t)} / {clock(end)}
        </span>
        <button
          className="icon-button"
          title="跳到结束"
          aria-label="跳到结束"
          onClick={() => {
            setPlaying(false);
            setT(end);
          }}
        >
          <SkipForward size={18} />
        </button>
        <label className="check replay-split">
          <input
            type="checkbox"
            checked={split}
            onChange={(e) => setSplit(e.target.checked)}
          />
          分屏对照基线
        </label>
      </div>
      <div className={`replay-grid${split ? " split" : ""}`}>
        {runs.map((run) => {
          const { done, running } = progress(run.lanes, t);
          return (
            <div key={run.title} className="replay-run">
              <LaneChart
                caption={
                  <>
                    {run.title}
                    <small>
                      已完成 {done} · 执行中 {running}
                    </small>
                  </>
                }
                lanes={lanesAt(run.lanes, t)}
                start={0}
                end={end}
                now={t}
                ticks={ticks}
                clock={clock}
                compact={run.lanes.length > 24}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
