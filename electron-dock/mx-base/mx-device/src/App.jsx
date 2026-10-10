import SchedulerLab from "./SchedulerLab.jsx";
import { useState, useCallback, useEffect } from "react";
import {
  Desktop,
  FileText,
  Gear,
  Cube,
  SignOut,
  PlayCircle,
  Info,
  Plus,
  ArrowsClockwise,
  HardDrives,
} from "@phosphor-icons/react";
import { api, useSnapshot } from "./data.js";
import { Modal, DeviceForm, JobForm, ObserverForm } from "./Forms.jsx";
import { Devices, Connections } from "./Devices.jsx";
import { Tasks, Events, JobDetail, Scheduler } from "./Tasks.jsx";
import { Racks, ResourceForm, PlacementForm } from "./Racks.jsx";
import { PacingForm } from "./AppPacing.jsx";
import Projection from "./Projection.jsx";
import { requestId } from "./request-id.mjs";
import { submitJob } from "./submit-job.mjs";

function Login({ onLogin }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <div className="login-brand">
        MX Device<span>独立设备实验中心</span>
      </div>
      <form
        className="panel login-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const token = new FormData(e.currentTarget).get("token");
          setBusy(true);
          try {
            await api("login", null, { token });
            onLogin();
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>进入设备中心</h1>
        <p className="muted">与 Hub 登录、数据和运行环境完全独立。</p>
        <label>
          管理凭证
          <input
            name="token"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            placeholder="使用初始化工具生成的管理凭证"
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "验证中…" : "登录"}
        </button>
        <p className="small muted">
          凭证不会保存到浏览器本地存储。首次进入只展示模拟设备，不会访问真实手机。
        </p>
      </form>
    </div>
  );
}
export default function App() {
  const [logged, setLogged] = useState(false);
  const expire = useCallback(() => setLogged(false), []);
  useEffect(() => {
    let alive = true;
    api("session")
      .then(() => {
        if (alive) setLogged(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return logged ? (
    <Workspace onExpired={expire} />
  ) : (
    <Login onLogin={() => setLogged(true)} />
  );
}
function Workspace({ onExpired }) {
  const [mode, setMode] = useState("sim"),
    [page, setPage] = useState("lab"),
    [selectedId, setSelectedId] = useState(null),
    [history, setHistory] = useState(null),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [failure, setFailure] = useState(false),
    [detail, setDetail] = useState(null),
    [resource, setResource] = useState(null),
    [placement, setPlacement] = useState(null),
    [pacing, setPacing] = useState(null);
  const { state, error, loading, refresh } = useSnapshot(mode, onExpired);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page, mode]);
  const device =
    state.devices.find((d) => d.id === selectedId) || state.devices[0];
  const active = state.jobs.some((j) =>
    ["queued", "running"].includes(j.status),
  );
  const latestRun = state.jobs
    .filter((j) => j.runId)
    .sort((a, b) => b.createdAt - a.createdAt)[0]?.runId;
  const visibleJobs =
    page === "jobs"
      ? state.jobs
      : state.jobs.filter((j) => !j.runId || j.runId === latestRun);
  async function run(fn, message) {
    setBusy(true);
    setNotice("");
    setFailure(false);
    try {
      const r = await fn();
      setNotice(message || "操作已保存");
      await refresh();
      return r;
    } catch (e) {
      setFailure(true);
      setNotice(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function control(d, action) {
    const body = { revision: d.revision, action };
    if (action === "enable" && mode === "real") {
      if (
        !confirm(
          "启用真实调度前，确认旧 Hub 外设调度、脚本和其他调用方都已停止，并且没有在途任务。此中心将成为该手机唯一调度者。",
        )
      )
        return;
      body.confirmedExclusive = true;
    }
    if (action === "recover") {
      const reason = prompt(
        "核验旧执行器和手机操作确已停止后，填写核验说明。此操作不会重试未知任务，也不会自动启用。",
      );
      if (!reason) return;
      body.reason = reason;
      body.confirmedStopped = true;
    }
    void run(() => api(`devices/${d.id}/control`, mode, body));
  }
  const newScene = (kind) =>
    run(
      () => api("scenarios", "sim", { kind, key: requestId() }),
      kind === "failover"
        ? "双机模拟已启动。选中 A，点击“模拟断线”，观察等待与接管。"
        : "演示已启动，不会调用真机。",
    );
  const inspect = async (j) => {
    setDetail(null);
    setModal("detail");
    const d = await run(() => api(`jobs/${j.id}`, mode), "已读取任务证据");
    setDetail(d);
  };
  const openPacing = (d) => {
    setPacing({
      device: d,
      availability: state.scheduling?.devices.find((a) => a.deviceId === d.id),
    });
    setModal("pacing");
  };
  const nav = [
    ["lab", "调度实验室", PlayCircle],
    ["racks", "机架总览", HardDrives],
    ["workbench", "设备工作台", Desktop],
    ["jobs", "任务池与调度", FileText],
    ["settings", "连接设置", Gear],
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          MX Device<span>设备中心</span>
        </div>
        <nav aria-label="主导航">
          {nav.map(([key, label, Icon]) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
              onClick={() => setPage(key)}
            >
              <Icon size={24} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Cube size={22} />
          独立实验系统
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            设备中心 <span className="slash">/</span>{" "}
            {nav.find((n) => n[0] === page)[1]}
          </span>
          <div className="button-row">
            <label className={`mode-select ${mode === "real" ? "real" : ""}`}>
              <PlayCircle size={19} />
              <span className="sr-only">运行模式</span>
              <select
                aria-label="运行模式"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setSelectedId(null);
                  setHistory(null);
                  setNotice("");
                  setModal(null);
                }}
              >
                <option value="sim">模拟演练</option>
                <option value="real">真实设备</option>
              </select>
            </label>
            <button
              className="text-button logout"
              onClick={async () => {
                await api("logout", null, {});
                onExpired();
              }}
            >
              <SignOut size={21} />
              退出
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>
                {page === "lab"
                  ? "让调度过程可观测、可控制"
                  : page === "racks"
                    ? "机架与设备资源"
                    : page === "jobs"
                      ? "让任务有序流向设备"
                      : "让每一次执行都有据可查"}
              </h1>
              <p>单机串行，多机协作。真实执行与模拟演练严格分离。</p>
            </div>
            <button className="primary" onClick={() => setModal("device")}>
              <Plus size={19} />
              添加设备
            </button>
          </div>
          <div
            className={`notice mode-notice ${mode === "real" ? "real" : ""}`}
          >
            <Info size={20} />
            {mode === "sim"
              ? "当前为模拟演练 · 不会连接真实手机"
              : "真实设备 · 默认暂停 · 只有显式操作才检查或调度手机"}
          </div>
          {(notice || error) && (
            <div
              className={`feedback ${failure || error ? "error" : "success"}`}
              role={failure || error ? "alert" : "status"}
            >
              {error || notice}
            </div>
          )}
          {page === "lab" ? (
            <SchedulerLab
              state={state}
              mode={mode}
              busy={busy}
              run={run}
              onInspect={inspect}
              failure={failure}
              notice={notice}
              onDevices={() => setPage("racks")}
            />
          ) : page === "racks" ? (
            <Racks
              key={mode}
              state={state}
              mode={mode}
              busy={busy}
              onPacing={openPacing}
              onAdd={() => setModal("device")}
              onOpenDevice={(id) => {
                setSelectedId(id);
                setHistory(null);
                setPage("workbench");
              }}
              onPolicy={(group) => {
                setResource(group);
                setModal("resource");
              }}
              onPlacement={(d) => {
                setPlacement(d);
                setModal("placement");
              }}
            />
          ) : page === "jobs" ? (
            <Scheduler
              key={mode}
              state={state}
              busy={busy}
              onInspect={inspect}
              onCancel={(j) => run(() => api(`jobs/${j.id}/cancel`, mode, {}))}
              onSubmit={() => setModal("job")}
              onScene={mode === "sim" ? newScene : null}
              onReplay={(e) => {
                setSelectedId(e.deviceId);
                setHistory(e);
                setPage("workbench");
              }}
            />
          ) : page === "settings" ? (
            <Connections
              state={state}
              onAdd={() => setModal("device")}
              onConnectReal={() => {
                setMode("real");
                setSelectedId(null);
                setHistory(null);
                setNotice("");
                setModal("device");
              }}
            />
          ) : (
            <div className="work-grid">
              <section className="panel scheduling">
                <div className="section-head">
                  <h2>{page === "jobs" ? "任务池与执行证据" : "设备与调度"}</h2>
                  <div className="button-row">
                    {mode === "sim" && (
                      <>
                        <button
                          disabled={busy || active}
                          onClick={() => newScene("five")}
                        >
                          五任务演示
                        </button>
                        <button
                          disabled={busy || active}
                          onClick={() => newScene("failover")}
                        >
                          双机接管演示
                        </button>
                      </>
                    )}
                    {mode === "real" && (
                      <button
                        disabled={
                          busy ||
                          !state.devices.some(
                            (d) => d.enabled && d.state !== "quarantined",
                          )
                        }
                        onClick={() => setModal("real-demo")}
                      >
                        真机搜索 → 详情演示
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label="刷新本中心记录"
                      onClick={refresh}
                    >
                      <ArrowsClockwise size={20} />
                    </button>
                  </div>
                </div>
                <div className="panel-body">
                  {mode === "real" && (
                    <p className="notice">
                      看画面：Mobile-Agent 8787 + 手机序列号 → 开始观看。已有
                      PoC 手机直接配置画面连接，不重复登记。 旧 18081
                      搜索/详情仍需明确空闲和独占交接；观察不会清
                      busy、点击手机或重启 VPN。
                    </p>
                  )}
                  {loading ? (
                    <p className="muted">读取本中心记录…</p>
                  ) : (
                    <Devices
                      devices={state.devices}
                      selected={device}
                      onSelect={(id) => {
                        setSelectedId(id);
                        setHistory(null);
                      }}
                    />
                  )}
                  <div className="sub-head">
                    <h3>任务池</h3>
                    <div className="button-row">
                      {mode === "sim" && (
                        <button
                          className="text-button"
                          disabled={busy || active}
                          onClick={() => newScene("priority")}
                        >
                          优先级演示
                        </button>
                      )}
                      <button
                        className="text-button"
                        onClick={() => setModal("job")}
                      >
                        提交任务
                      </button>
                    </div>
                  </div>
                  <Tasks
                    jobs={visibleJobs}
                    devices={state.devices}
                    scheduling={state.scheduling}
                    onInspect={inspect}
                    onCancel={(j) =>
                      run(() => api(`jobs/${j.id}/cancel`, mode, {}))
                    }
                  />
                  {active && (
                    <p className="small muted">
                      运行中的搜索会话不可抢占；等待每 30
                      秒提升一级优先级。点击任务名称查看尝试证据。
                    </p>
                  )}
                  <h3 className="events-heading">调度事件</h3>
                  <Events
                    events={state.events}
                    onReplay={(e) => {
                      setSelectedId(e.deviceId);
                      setHistory(e);
                    }}
                  />
                </div>
              </section>
              <Projection
                key={`${mode}:${device?.id}`}
                device={device}
                history={history}
                availability={state.scheduling?.devices.find(
                  (a) => a.deviceId === device?.id,
                )}
                now={state.scheduling?.at}
                onPacing={openPacing}
                onLive={() => setHistory(null)}
                busy={busy}
                onControl={control}
                onRefresh={refresh}
                onConfigure={() => setModal("observer")}
                onProbe={(d) =>
                  run(
                    () =>
                      api(`devices/${d.id}/probe`, mode, {
                        revision: d.revision,
                      }),
                    "只读检查已排入执行器；若无回执，请查看连接设置中的心跳。",
                  )
                }
              />
            </div>
          )}
        </main>
      </div>
      {modal && (
        <Modal
          title={
            modal === "pacing"
              ? "App 与整机冷却策略"
              : modal === "resource"
                ? `${resource.scope === "rack" ? "机架" : "宿主机"}调度策略`
                : modal === "placement"
                  ? "编辑设备归属"
                  : modal === "device"
                    ? "添加设备"
                    : modal === "observer"
                      ? "配置真实画面"
                      : modal === "job"
                        ? `提交${mode === "sim" ? "模拟" : "真实"}任务`
                        : modal === "real-demo"
                          ? "真机搜索 → 详情演示"
                          : "执行证据"
          }
          onClose={() => setModal(null)}
        >
          {failure && notice && (
            <p role="alert" className="error modal-error">
              {notice}
            </p>
          )}
          {modal === "pacing" ? (
            <PacingForm
              device={pacing.device}
              availability={pacing.availability}
              busy={busy}
              onSubmit={async (body) => {
                const r = await run(
                  () => api(`devices/${pacing.device.id}/pacing`, mode, body),
                  "冷却策略已保存，设备仍暂停",
                );
                if (r) setModal(null);
              }}
            />
          ) : modal === "resource" ? (
            <ResourceForm
              group={resource}
              busy={busy}
              onSubmit={async (body) => {
                const r = await run(
                  () =>
                    api("resources/control", mode, {
                      scope: resource.scope,
                      rack: resource.rack,
                      host: resource.host,
                      revision: resource.revision,
                      ...body,
                    }),
                  "资源策略已保存",
                );
                if (r) setModal(null);
              }}
            />
          ) : modal === "placement" ? (
            <PlacementForm
              device={placement}
              devices={state.devices}
              busy={busy}
              onSubmit={async (body) => {
                const r = await run(
                  () => api(`devices/${placement.id}/placement`, mode, body),
                  "归属已保存，设备仍暂停",
                );
                if (r) setModal(null);
              }}
            />
          ) : modal === "observer" ? (
            <ObserverForm
              device={device}
              busy={busy}
              onSubmit={async (b) => {
                const r = await run(
                  () => api(`devices/${device.id}/observer`, "real", b),
                  "画面连接已保存，点击开始观看才访问手机",
                );
                if (r) setModal(null);
              }}
            />
          ) : modal === "device" ? (
            <DeviceForm
              mode={mode}
              workers={state.workers}
              busy={busy}
              onSubmit={async (b) => {
                const d = await run(
                  () => api("devices", mode, b),
                  "设备已登记",
                );
                if (d) {
                  setSelectedId(d.id);
                  setModal(null);
                }
              }}
            />
          ) : modal === "job" || modal === "real-demo" ? (
            <JobForm
              mode={mode}
              demo={modal === "real-demo"}
              devices={state.devices}
              selectedDeviceId={device?.id}
              busy={busy}
              onSubmit={async (b) => {
                if (
                  await run(
                    () => submitJob(api, mode, b),
                    b.followup
                      ? "真机搜索与依赖详情已入池；同一手机串行执行。"
                      : "任务已入池",
                  )
                )
                  setModal(null);
              }}
            />
          ) : (
            <JobDetail detail={detail} />
          )}
        </Modal>
      )}
    </div>
  );
}
