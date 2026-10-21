// What a simulated phone shows right now (pure; shared by the workbench tile,
// the device workspace and tests). Built from the last confirmed projection
// (what receipts proved) plus the command in flight (what is being done),
// then the device state on top (cooldown, quarantine, pause, offline).
import { battery, clock, enrich, feed, topic } from "./synth.mjs";
import { simDetailText, simTitle } from "../../server/sim-content.mjs";

// Command action -> the app view it leaves on screen.
export const VIEW_OF = {
  open: "feed",
  restore: "feed",
  list: "feed",
  refresh: "feed",
  scroll: "feed",
  search: "results",
  next: "results",
  detail: "detail",
  ocr: "ocr",
  like: "post",
  back: "feed",
};
const CODE_ACTION = {
  "app.open": "open",
  "session.home": "home",
  "session.back": "back",
  "session.restore": "restore",
};
export const actionOf = (x) =>
  x?.definition?.action ||
  x?.commandAction ||
  CODE_ACTION[x?.code || x?.commandCode] ||
  (x?.code || x?.commandCode || "").split(".").at(-1) ||
  null;
// After this long without anything new, an idle phone shows its lock screen.
export const IDLE_LOCK_MS = 120000;
const TOAST_MS = 3000;

export function screenModel({
  device,
  projection,
  command,
  attempt,
  job,
  status = "idle",
  now,
  cooldownUntil = 0,
  tile = true,
}) {
  const running = status === "running" || !!command;
  const sessionApp = command?.appId || (running ? job?.appId : null);
  // A projection of another App belongs to an earlier session.
  const p =
    projection && (!sessionApp || projection.appId === sessionApp)
      ? projection
      : null;
  const appId =
    sessionApp || p?.appId || job?.appId || device.simApps?.[0] || "xhs";
  const rawKeyword =
    command?.params?.keyword ?? p?.keyword ?? job?.input?.keyword ?? null;
  const n = tile ? 4 : 6;
  const m = {
    appId,
    apps: device.simApps || ["xhs", "weibo"],
    keyword: topic(appId, rawKeyword),
    clock: clock(now),
    battery: battery(device.id),
    // A PoC-driven phone shows what its PoC answered, not synthetic content.
    synthetic: device.mode === "sim" && device.driver !== "poc",
    source: device.driver === "poc" ? "poc" : device.mode,
    surface: "app",
    view: "feed",
    items: [],
    detail: null,
    blocks: [],
    liked: false,
    page: null,
    pending: null,
    overlay: null,
    toast: null,
    parked: attempt?.status === "yielded",
  };
  const confirmed = p ? actionOf(p) : null;
  if (confirmed === "home") m.surface = "home";
  else if (p) {
    m.view = VIEW_OF[confirmed] || (p.detail ? "detail" : "feed");
    m.page = p.page ?? null;
    m.items = (p.items || []).map((item, i) =>
      enrich(appId, m.keyword, item, i),
    );
    if (p.detail)
      m.detail = {
        id: p.detail.id,
        title:
          p.detail.title && p.detail.title !== "模拟正文"
            ? p.detail.title
            : simTitle(appId, rawKeyword, 1, 0),
        content: p.detail.content,
        priceCents: p.detail.priceCents,
      };
    m.blocks = p.blocks || [];
    m.liked = p.liked === true;
    // Toasts of a confirmed step show for a few seconds, as on a phone.
    const fresh = now - (p.progressAt ?? p.observedAt ?? 0) < TOAST_MS;
    if (fresh && confirmed === "back") m.toast = "已返回上一页";
    if (fresh && confirmed === "restore") m.toast = "已恢复上下文";
  } else if (sessionApp) m.surface = "splash";
  else m.surface = "lock";

  const pending = command && actionOf(command);
  if (pending) {
    m.pending = {
      action: pending,
      name: command.definition?.name || command.code,
      page: command.page ?? null,
      startedAt: command.createdAt,
      estimateMs: command.estimatedDurationMs ?? null,
    };
    m.surface = "app";
    if (pending === "open" || pending === "restore") m.surface = "splash";
    else if (pending === "home") m.surface = "home";
    else if (pending === "search") {
      m.view = "search";
      m.keyword = topic(appId, command.params?.keyword);
    } else if (pending === "next") {
      m.view = "results";
      m.loadingPage = command.page ?? (m.page || 1) + 1;
    } else if (["list", "refresh"].includes(pending)) {
      m.view = "feed";
      m.refreshing = true;
    } else if (pending === "scroll") {
      m.view = "feed";
      m.scrolling = true;
    } else if (pending === "detail") {
      m.view = "detail";
      m.loading = !m.detail || m.detail.id !== command.params?.target;
    } else if (pending === "ocr") {
      m.view = "ocr";
      m.scanning = true;
    } else if (pending === "like") {
      m.view = "post";
      m.liking = true;
    } else if (pending === "back") {
      m.view = m.items.length ? "results" : "feed";
      m.toast = "返回上一页";
    }
  }
  // Pages that need content before any receipt filled them.
  if (m.surface === "app") {
    if (
      ["feed", "search", "results", "post"].includes(m.view) &&
      !m.items.length
    )
      m.items = feed(appId, `${device.id}|${m.keyword}`, n);
    if (["detail", "ocr"].includes(m.view) && !m.detail && !m.loading) {
      const target = command?.params?.target || `${device.id}-detail`;
      m.detail = {
        id: target,
        title: simTitle(appId, rawKeyword, 1, 0),
        content: simDetailText(appId, target, rawKeyword),
      };
    }
  }
  if (m.items.length > n) m.items = m.items.slice(0, n);
  // The item a detail page is about (author, image, price, likes).
  if (m.surface === "app" && ["detail", "ocr", "post"].includes(m.view)) {
    const id = m.detail?.id || command?.params?.target || `${device.id}-detail`;
    m.hero = enrich(
      appId,
      m.keyword,
      {
        id,
        title: m.detail?.title,
        priceCents: m.detail?.priceCents,
      },
      0,
    );
  }

  // Device state over the screen.
  const left = Math.max(0, cooldownUntil - now);
  m.overlay =
    status === "quarantined"
      ? {
          tone: "danger",
          icon: "WarningCircle",
          title: "需人工核验",
          note: "执行结果不明 · 已隔离",
        }
      : status === "suspect"
        ? {
            tone: "warn",
            icon: "WifiSlash",
            title: "失联待确认",
            note: "宽限期内等待 Agent 证据",
          }
        : status === "cooling"
          ? {
              tone: "warn",
              icon: "Timer",
              title: device.cooldownUntil > now ? "整机休息中" : "App 冷却中",
              note: `剩余 ${Math.ceil(left / 1000)} 秒`,
              dim: true,
            }
          : status === "paused"
            ? {
                icon: "PauseCircle",
                title: "已暂停",
                note: "不领取新任务",
                dim: true,
              }
            : status === "offline"
              ? {
                  icon: "WifiSlash",
                  title: "离线",
                  note: "等待重新连接",
                  dim: true,
                }
              : status === "reserved"
                ? { icon: "Lock", title: "会话预留", note: "等待当前工作收尾" }
                : null;
  // An idle phone that has been left alone locks itself.
  if (
    status === "idle" &&
    !command &&
    (!p || now - (p.progressAt ?? p.observedAt ?? 0) > IDLE_LOCK_MS)
  )
    m.surface = m.surface === "home" ? "home" : "lock";
  return m;
}
