import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { request } from "./api";
import { dateTime } from "./commerce-state";

type Message = {
  id: string;
  kind:
    | "scheduled"
    | "active"
    | "expiring_7d"
    | "expiring_1d"
    | "expired"
    | "ticket_updated"
    | "ticket_updated_owner"
    | "member_created"
    | "member_enabled"
    | "member_disabled";
  document: {
    ticketId?: string;
    status?: string;
    hasReply?: boolean;
    memberId?: string;
    memberName?: string;
    account?: string;
    productName?: string;
    startsAt?: string;
    endsAt?: string;
    quota?: number;
    scope?: "tenant" | "consumer";
  };
  createdAt: string;
  readAt: string | null;
};
type Inbox = { items: Message[]; unread: number; nextBefore: string | null };
const titles = {
  ticket_updated: "工单处理有更新",
  ticket_updated_owner: "企业工单处理有更新",
  member_created: "员工子账号已创建",
  member_enabled: "员工子账号已启用",
  member_disabled: "员工子账号已停用",
  scheduled: "续订已开通，等待生效",
  active: "订阅已生效",
  expiring_7d: "订阅将在 7 天内到期",
  expiring_1d: "订阅将在 24 小时内到期",
  expired: "订阅已到期",
};
export function useMessageInbox(tenant: string, enabled: boolean, accessScope = "") {
  const cacheScope = JSON.stringify([tenant, accessScope]);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState("");
  const [scope, setScope] = useState(cacheScope);
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled || !tenant) return;
    const version = generation.current;
    const sequence = ++requestSequence.current;
    try {
      const result = await request(
        `/bff/v1/commerce/tenants/${tenant}/messages`,
      );
      if (
        version === generation.current &&
        sequence === requestSequence.current
      ) {
        setInbox(result.data);
        setError("");
      }
    } catch (e) {
      if (
        version === generation.current &&
        sequence === requestSequence.current
      )
        setError((e as Error).message);
    }
  }, [tenant, enabled, cacheScope]);
  useEffect(() => {
    generation.current++;
    setScope(cacheScope);
    setInbox(null);
    setError("");
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, 60_000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [reload]);
  return {
    scope: cacheScope,
    inbox: enabled && scope === cacheScope ? inbox : null,
    error: scope === cacheScope ? error : "",
    reload,
  };
}
export function Messages({
  tenant,
  csrf,
  enabled,
  state,
  go,
  compact = false,
}: {
  tenant: string;
  csrf: string;
  enabled: boolean;
  compact?: boolean;
  state: ReturnType<typeof useMessageInbox>;
  go: (page: string) => void;
}) {
  const { inbox, error, reload } = state;
  // Keep the displayed first page stable while browsing older pages. Background
  // inbox refreshes must not push unread records out between the loaded pages.
  const [firstPage, setFirstPage] = useState<Message[] | null>(null);
  const [older, setOlder] = useState<Message[]>([]);
  const [next, setNext] = useState<string | null | undefined>();
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const lock = useRef(false);
  const items = [...(firstPage || inbox?.items || []), ...older].filter(
    (item, i, all) => all.findIndex((value) => value.id === item.id) === i,
  );
  const cursor = next === undefined ? inbox?.nextBefore : next;
  async function act(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError("");
    try {
      await work();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="harbor-messages">
      <div
        className={
          compact
            ? "notification-toolbar"
            : "page-heading harbor-heading-actions"
        }
      >
        {compact ? (
          <span>
            {inbox?.unread ? `${inbox.unread} 条未读消息` : "暂无未读消息"}
          </span>
        ) : (
          <div>
            <h1>消息通知</h1>
            <p>
              企业账号操作、订阅动态与工单更新
              {inbox ? ` · ${inbox.unread} 条未读` : ""}
            </p>
          </div>
        )}
        {enabled && (
          <Button
            variant="ghost"
            disabled={busy || !inbox?.unread}
            onClick={() =>
              act(async () => {
                await request(
                  `/bff/v1/commerce/tenants/${tenant}/messages/read-all`,
                  {
                    method: "POST",
                    headers: { "x-mx-csrf": csrf },
                    body: "{}",
                  },
                );
                setFirstPage(null);
                setOlder([]);
                setNext(undefined);
                await reload();
              })
            }
          >
            <Check size={14} />
            全部已读
          </Button>
        )}
        {enabled && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              act(async () => {
                setFirstPage(null);
                setOlder([]);
                setNext(undefined);
                await reload();
              })
            }
          >
            刷新
          </Button>
        )}
      </div>
      {!enabled ? (
        <p className="harbor-empty">请先登录并选择当前企业。</p>
      ) : (
        <>
          {(error || actionError) && (
            <p className="harbor-error" role="alert">
              {actionError || error}
            </p>
          )}
          {firstPage && inbox?.items[0]?.id !== firstPage[0]?.id && (
            <p className="harbor-hint">有新消息，点击刷新查看。</p>
          )}
          {!inbox && !error && <p role="status">正在读取消息…</p>}
          {inbox && !items.length && (
            <Card className="harbor-empty">
              <Bell aria-hidden="true" />
              <h2>暂无消息</h2>
              <p>当前账号有权查看的账号操作、订阅提醒与工单更新会显示在这里。</p>
            </Card>
          )}
          {items.map((message) => (
            <Card
              key={message.id}
              className="harbor-message"
              data-unread={!message.readAt}
            >
              <div className="harbor-message-icon">
                <Bell size={20} aria-hidden="true" />
              </div>
              <div className="harbor-message-copy">
                <div className="harbor-message-heading">
                  <h2>{titles[message.kind]}</h2>
                  <span>{message.readAt ? "已读" : "未读"}</span>
                </div>
                {["ticket_updated", "ticket_updated_owner"].includes(message.kind) ? (
                  <>
                    <p>
                      {message.document.hasReply
                        ? message.kind === "ticket_updated_owner" ? "平台客服已回复企业工单。" : "平台客服已回复你的工单。"
                        : message.kind === "ticket_updated_owner" ? "企业工单处理状态已更新。" : "你的工单处理状态已更新。"}
                    </p>
                    <p>
                      工单编号：{message.document.ticketId} ·{" "}
                      {(
                        {
                          saved: "已提交",
                          processing: "处理中",
                          closed: "已关闭",
                        } as Record<string, string>
                      )[message.document.status || ""] || "已更新"}
                    </p>
                  </>
                ) : message.kind.startsWith("member_") ? (
                  <>
                    <p>{message.document.memberName || message.document.account || "企业员工"}</p>
                    <p>登录账号：{message.document.account || "已有 MX 账号"}</p>
                    <p>企业超管专属通知</p>
                  </>
                ) : (
                  <>
                    <p>{message.document.productName}</p>
                    <p>
                      有效期：{dateTime(message.document.startsAt)} —{" "}
                      {dateTime(message.document.endsAt)}
                    </p>
                    <p>
                      {message.document.quota?.toLocaleString() || "—"} 次调用 ·{" "}
                      {message.document.scope === "tenant"
                        ? "空间共享"
                        : "指定调用者"}
                    </p>
                    {message.kind.startsWith("expiring") && (
                      <p>
                        可在订阅期内继续购买。已购续订与当前可用服务请在「我的订阅」查看。
                      </p>
                    )}
                    {message.kind === "expired" && (
                      <p>
                        此订阅已到期，其他可用订阅不受影响。查询记录仍可回看。
                      </p>
                    )}
                  </>
                )}
                <time>{dateTime(message.createdAt)}</time>
                <div className="harbor-actions">
                  <Button
                    variant="link"
                    onClick={() => {
                      if (
                        ["ticket_updated", "ticket_updated_owner"].includes(message.kind) &&
                        message.document.ticketId
                      ) {
                        sessionStorage.setItem(
                          "dataport:open-ticket",
                          message.document.ticketId,
                        );
                        window.dispatchEvent(new Event("dataport:open-ticket"));
                      }
                      go(
                        ["ticket_updated", "ticket_updated_owner"].includes(message.kind)
                          ? "support" : message.kind.startsWith("member_") ? "team" : "services",
                      );
                    }}
                  >
                    {["ticket_updated", "ticket_updated_owner"].includes(message.kind)
                      ? "查看工单" : message.kind.startsWith("member_") ? "查看企业账号" : "查看订阅"}{" "}
                    <ArrowRight />
                  </Button>
                  {!message.readAt && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          const result = await request(
                            `/bff/v1/commerce/tenants/${tenant}/messages/${message.id}/read`,
                            {
                              method: "POST",
                              headers: { "x-mx-csrf": csrf },
                              body: "{}",
                            },
                          );
                          setOlder((values) =>
                            values.map((value) =>
                              value.id === message.id
                                ? { ...value, readAt: result.data.readAt }
                                : value,
                            ),
                          );
                          setFirstPage(
                            (values) =>
                              values?.map((value) =>
                                value.id === message.id
                                  ? { ...value, readAt: result.data.readAt }
                                  : value,
                              ) || null,
                          );
                          await reload();
                        })
                      }
                    >
                      <Check /> 标为已读
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {!!items.length && (
            <p className="harbor-hint" aria-live="polite">
              已显示 {items.length} 条
              {cursor ? "，可继续加载更早消息。" : "，已显示全部消息。"}
            </p>
          )}
          {cursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const result = await request(
                    `/bff/v1/commerce/tenants/${tenant}/messages?before=${cursor}`,
                  );
                  setFirstPage((values) => values || inbox?.items || []);
                  setOlder((values) => [...values, ...result.data.items]);
                  setNext(result.data.nextBefore);
                })
              }
            >
              更早消息
            </Button>
          )}
        </>
      )}
    </div>
  );
}
