import PhoneProjection from "./PhoneProjection.jsx";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { AppPacing } from "./AppPacing.jsx";
import { time } from "./data.js";
import { DeviceControls } from "./Devices.jsx";
import { useState } from "react";
import { LiveScreen, ControlSession } from "./PhoneConsole.jsx";
import MobileStatus from "./MobileStatus.jsx";
export default function Projection({
  device,
  history,
  onLive,
  onConfigure,
  onRefresh,
  availability,
  now,
  onPacing,
  ...controls
}) {
  const [tab, setTab] = useState("screen");
  const p = history?.projection || device?.projection;
  const live = device?.mode === "real" && tab === "screen" && !history;
  return (
    <aside className="panel projection console-projection">
      <h2>{device?.mode === "real" ? "手机工作台" : "模拟手机工作台"}</h2>
      <p className="muted small">
        {live ? "真实画面与接口投影独立，不以 busy 推断屏幕" : "非实时屏幕"}
        {history ? ` · 历史 ${time(history.at)}` : ""}
      </p>
      {device?.mode === "real" && (
        <div className="screen-tabs" aria-label="画面类型">
          <button
            aria-pressed={live}
            onClick={() => {
              setTab("screen");
              onLive();
            }}
          >
            真实画面
          </button>
          <button aria-pressed={!live} onClick={() => setTab("projection")}>
            接口投影
          </button>
        </div>
      )}
      {history && (
        <button className="text-button replay" onClick={onLive}>
          <ArrowCounterClockwise size={16} />
          返回最新记录
        </button>
      )}
      {live ? (
        <LiveScreen
          key={`${device.id}:${device.observer?.version}`}
          device={device}
          onConfigure={onConfigure}
        />
      ) : (
        <>
          <PhoneProjection device={device} projection={p} />
          <p className="projection-foot">
            连接状态不等于开机状态
            {p?.progressAt && (
              <>
                <br />
                最近内容变化 {time(p.progressAt)}
              </>
            )}
          </p>
        </>
      )}
      <DeviceControls device={device} {...controls} />
      {device && (
        <AppPacing
          device={device}
          availability={availability}
          now={now}
          busy={controls.busy}
          onConfigure={onPacing}
        />
      )}
      {device?.mode === "real" && (
        <MobileStatus device={device} onRefresh={onRefresh} />
      )}
      {device && (
        <ControlSession key={device.id} device={device} onRefresh={onRefresh} />
      )}
    </aside>
  );
}
