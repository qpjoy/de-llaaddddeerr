import { useEffect, useState } from "react";
import {
  Copy,
  Plus,
  Users,
  ShieldCheck,
  Download,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { request } from "./api";
import {
  enterpriseUrl,
  hasPermission,
  membershipFor,
  ownerOf,
} from "./permissions";
import { Pagination } from "./pagination";
import { dateTime } from "./commerce-state";
import { downloadExcel } from "./download";

type Props = { tenant: string; session: any; csrf: string };
function useEnterprise(tenant: string, path: string) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError("");
    request(enterpriseUrl(tenant, path), { signal: c.signal })
      .then((v) => {
        if (!c.signal.aborted) setData(v.data);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [tenant, path, version]);
  return { data, error, setError, reload: () => setVersion((v) => v + 1) };
}
function useWrite({ tenant, csrf }: Props) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return {
    busy,
    error,
    run: async (path: string, body: any) => {
      setBusy(true);
      setError("");
      try {
        return (
          await request(enterpriseUrl(tenant, path), {
            method: "POST",
            headers: { "x-mx-csrf": csrf },
            body: JSON.stringify(body),
          })
        ).data;
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
  };
}
const roleNames: Record<string, string> = {
  owner: "企业超管",
  admin: "企业管理员",
  analyst: "分析员",
  billing: "财务",
  viewer: "只读成员",
};
export function OwnerChallenge({
  tenant,
  csrf,
  onVerified,
}: {
  tenant: string;
  csrf: string;
  onVerified: () => void;
}) {
  const [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Card className="dp-owner-challenge">
      <CardHeader>
        <ShieldCheck size={30} />
        <CardTitle>验证企业超管身份</CardTitle>
        <p>每次新登录后，请输入平台管理员提供的专属邀请码。</p>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await request(enterpriseUrl(tenant, "challenge"), {
                method: "POST",
                headers: { "x-mx-csrf": csrf },
                body: JSON.stringify({ code }),
              });
              setCode("");
              onVerified();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="owner-code">专属邀请码</label>
          <Input
            id="owner-code"
            type="password"
            autoComplete="off"
            required
            maxLength={128}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {error && (
            <p role="alert" className="harbor-error">
              {error}
            </p>
          )}
          <Button disabled={busy}>{busy ? "正在验证…" : "验证并进入"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
export function EnterpriseMembers(props: Props) {
  const { tenant, session } = props,
    view = useEnterprise(tenant, "members"),
    write = useWrite(props),
    owner = ownerOf(session, tenant);
  const [open, setOpen] = useState(false),
    [operation, setOperation] = useState("create"),
    [roleId, setRoleId] = useState("analyst"),
    [commandId, setCommandId] = useState(crypto.randomUUID()),
    [invite, setInvite] = useState<any>(null),
    [password, setPassword] = useState<string | null>(null),
    [roleEditor, setRoleEditor] = useState(false),
    [editingMember, setEditingMember] = useState<any>(null),
    [editingDetails, setEditingDetails] = useState<"profile" | "role" | null>(
      null,
    ),
    [statusMember, setStatusMember] = useState<any>(null);
  const roles = view.data?.roles || [],
    members = view.data?.items || [];
  const membership = membershipFor(session, tenant);
  const memberRoleName = (member: any) =>
    member.role === "owner"
      ? "企业超管"
      : roles.find((role: any) => role.id === member.roleId)?.name ||
        roleNames[member.roleId] ||
        (member.roleId ? "自定义角色" : `原有 ${member.role} 角色`);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>企业账号</h1>
          <p>统一 MX 账号 · 企业成员与角色权限</p>
        </div>
        <div className="harbor-actions">
          <Button
            variant="outline"
            aria-label="刷新企业账号"
            onClick={view.reload}
          >
            <RefreshCw size={15} />
            刷新
          </Button>
          {owner && (
            <Button variant="outline" onClick={() => setRoleEditor(true)}>
              <ShieldCheck size={16} />
              角色与权限
            </Button>
          )}
        </div>
      </div>
      <section className="panel team-summary">
        <div className="team-summary-heading">
          <span className="team-space-avatar">
            <Users size={24} />
          </span>
          <div>
            <span className="team-eyebrow">当前企业</span>
            <h3>{membership?.tenantName}</h3>
          </div>
        </div>
        <div className="team-summary-meta">
          <span
            className={`team-status ${membership?.status === "active" ? "" : "inactive"}`}
            title="当前企业成员状态"
          >
            <i aria-hidden="true" />
            {membership?.status === "active" ? "正常" : "已停用"}
          </span>
          <span>
            {view.data
              ? `${members.filter((m: any) => m.role !== "owner").length} 个员工子账号`
              : view.error
                ? "成员数量暂不可用"
                : "正在读取成员…"}
          </span>
          <span>{membership?.dataport?.roleName}</span>
        </div>
      </section>
      {(view.error || write.error) && (
        <p className="harbor-error" role="alert">
          {view.error || write.error}
        </p>
      )}
      <section className="panel team-members-panel parity-members-panel">
        <div className="section-title">
          <h3>企业成员</h3>
          {hasPermission(session, tenant, "members.create") && (
            <div className="harbor-actions">
              <Button
                variant="outline"
                onClick={() => {
                  setOperation("invite");
                  setCommandId(crypto.randomUUID());
                  setOpen(true);
                }}
              >
                关联已有账号
              </Button>
              <Button
                onClick={() => {
                  setOperation("create");
                  setCommandId(crypto.randomUUID());
                  setOpen(true);
                }}
              >
                <Plus size={16} />
                新建子账号
              </Button>
            </div>
          )}
        </div>
        <div
          className="dp-team-table-scroll"
          role="region"
          aria-label="企业成员列表"
          tabIndex={0}
        >
          <table className="simple-data-table">
            <colgroup>
              <col className="team-column-identity" />
              <col className="team-column-type" />
              <col className="team-column-status" />
              <col className="team-column-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">员工 / 登录账号</th>
                <th scope="col">账号类型</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <div className="team-member-identity">
                      <span className="team-member-avatar" aria-hidden="true">
                        {Array.from(
                          String(m.displayName || m.account || "未"),
                        )[0].toUpperCase()}
                      </span>
                      <div>
                        <strong title={m.displayName || "未设置姓名"}>
                          {m.displayName || "未设置姓名"}
                        </strong>
                        <small title={m.account || "已有 MX 账号"}>
                          {m.account || "已有 MX 账号"}
                        </small>
                      </div>
                      {m.id === session.memberId && (
                        <span className="team-self-label">你</span>
                      )}
                    </div>
                  </td>
                  <td>{m.role === "owner" ? "企业超管" : "员工子账号"}</td>
                  <td>
                    <span
                      className={`team-status ${m.status === "active" ? "" : "inactive"}`}
                    >
                      <i aria-hidden="true" />
                      {m.status === "active" ? "正常" : "已停用"}
                    </span>
                  </td>
                  <td>
                    {m.role !== "owner" && m.id !== session.memberId ? (
                      <div className="account-row-actions">
                        <Button
                          variant="link"
                          disabled={write.busy}
                          onClick={() => {
                            setEditingDetails(null);
                            setEditingMember(m);
                          }}
                        >
                          详情
                        </Button>
                        {hasPermission(session, tenant, "members.disable") && (
                          <Button
                            variant="link"
                            disabled={write.busy}
                            onClick={() => setStatusMember(m)}
                          >
                            {m.status === "active" ? "停用" : "启用"}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {view.error ? (
          <p className="team-empty">成员读取失败，请刷新重试。</p>
        ) : !view.data ? (
          <p className="team-empty" role="status">
            正在读取成员…
          </p>
        ) : members.length === 0 ? (
          <p className="team-empty">暂无企业成员</p>
        ) : null}
        <p className="team-summary-note">
          员工按分配的角色权限查询 IP
          风险画像、查看记录和新建工单；子账号与日志由企业超管管理。
        </p>
      </section>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!write.busy) setOpen(v);
        }}
      >
        <DialogContent className="dp-dialog dp-member-dialog">
          <DialogHeader>
            <DialogTitle>
              {operation === "create" ? "新建员工子账号" : "关联已有 MX 账号"}
            </DialogTitle>
            <DialogDescription>
              {operation === "create"
                ? "填写员工信息，为其创建独立登录账号。"
                : "填写员工已有的 MX 账号，邀请其加入企业。"}
            </DialogDescription>
          </DialogHeader>
          <form
            className="ticket-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              try {
                const result = await write.run("members", {
                  ...values,
                  operation,
                  roleId,
                  commandId,
                });
                setOpen(false);
                setInvite(operation === "invite" ? result : null);
                view.reload();
              } catch {}
            }}
          >
            {operation === "create" && (
              <label>
                <span className="field-label-text">
                  员工名称 <span className="required-mark">*</span>
                </span>
                <input
                  name="displayName"
                  required
                  maxLength={80}
                  placeholder="填写员工姓名"
                  onChange={() => setCommandId(crypto.randomUUID())}
                />
              </label>
            )}
            <label>
              <span className="field-label-text">
                登录账号 <span className="required-mark">*</span>
              </span>
              <input
                name="account"
                required
                maxLength={128}
                autoComplete="off"
                placeholder={
                  operation === "create"
                    ? "填写员工 MX 登录账号"
                    : "填写已有 MX 账号"
                }
                onChange={() => setCommandId(crypto.randomUUID())}
              />
            </label>
            <label>
              <span className="field-label-text">
                角色 <span className="required-mark">*</span>
              </span>
              <select
                required
                value={roleId}
                onChange={(e) => {
                  setRoleId(e.target.value);
                  setCommandId(crypto.randomUUID());
                }}
              >
                {roles
                  .filter((r: any) => r.id !== "owner")
                  .map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <small>
              {operation === "create"
                ? "初始密码自动生成，仅企业超管可在详情中查看和复制。"
                : "邀请链接 24 小时有效，员工登录统一 MX 账号并确认后加入企业。"}
            </small>
            {write.error && <p role="alert">{write.error}</p>}
            <Button disabled={write.busy}>
              {write.busy
                ? "正在提交…"
                : operation === "invite"
                  ? "生成邀请链接"
                  : "创建子账号"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!invite}
        onOpenChange={(v) => {
          if (!v) setInvite(null);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>员工加入邀请</DialogTitle>
            <DialogDescription>
              链接 24 小时有效，请复制后交给指定员工，由员工登录并确认。
            </DialogDescription>
          </DialogHeader>
          <Input
            readOnly
            value={`${location.origin}/join?token=${invite?.joinToken || ""}`}
          />
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(
                `${location.origin}/join?token=${invite.joinToken}`,
              )
            }
          >
            <Copy size={16} />
            复制邀请链接
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={password !== null}
        onOpenChange={(v) => {
          if (!v) setPassword(null);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>员工初始密码</DialogTitle>
            <DialogDescription>
              仅适用于新建员工账号。员工修改密码后，此初始密码立即失效；查看操作将记入审计日志。
            </DialogDescription>
          </DialogHeader>
          <Input readOnly value={password || ""} />
          <Button
            onClick={() => void navigator.clipboard.writeText(password || "")}
          >
            <Copy size={16} />
            复制密码
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!editingMember}
        onOpenChange={(v) => {
          if (!v && !write.busy) setEditingMember(null);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>
              {editingDetails === "role"
                ? "分配数港角色"
                : editingDetails
                  ? "编辑员工资料"
                  : "子账号详情"}
            </DialogTitle>
            <DialogDescription>
              {editingDetails === "role"
                ? "为该员工选择企业角色，页面和操作按角色权限开放。"
                : editingDetails
                  ? "修改该员工在本企业的显示名称，统一 MX 账号资料由员工本人维护。"
                  : "查看员工的登录账号、企业角色和当前状态。"}
            </DialogDescription>
          </DialogHeader>
          {editingMember &&
            (editingDetails ? (
              <form
                className="ticket-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const values = new FormData(e.currentTarget),
                    patch: Record<string, string> = {};
                  if (
                    editingDetails === "profile" &&
                    hasPermission(session, tenant, "members.update")
                  )
                    patch.displayName = String(values.get("displayName") || "");
                  if (
                    editingDetails === "role" &&
                    hasPermission(session, tenant, "members.assign")
                  )
                    patch.roleId = String(values.get("roleId") || "");
                  if (!Object.keys(patch).length) return;
                  try {
                    await write.run(`members/${editingMember.id}`, patch);
                    setEditingMember(null);
                    view.reload();
                  } catch {}
                }}
              >
                {editingDetails === "profile" &&
                  hasPermission(session, tenant, "members.update") && (
                    <label>
                      员工名称
                      <input
                        name="displayName"
                        required
                        maxLength={80}
                        defaultValue={editingMember.displayName || ""}
                      />
                    </label>
                  )}
                {editingDetails === "role" &&
                  hasPermission(session, tenant, "members.assign") && (
                    <label>
                      角色
                      <select
                        name="roleId"
                        required
                        defaultValue={editingMember.roleId || ""}
                      >
                        <option value="" disabled>
                          分配数港角色
                        </option>
                        {roles
                          .filter((r: any) => r.id !== "owner")
                          .map((r: any) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                {write.error && <p role="alert">{write.error}</p>}
                <div className="account-row-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={write.busy}
                    onClick={() => setEditingDetails(null)}
                  >
                    取消
                  </Button>
                  <Button disabled={write.busy}>保存</Button>
                </div>
              </form>
            ) : (
              <>
                <div className="credential-success">
                  <div className="credential-field">
                    <span>员工名称</span>
                    <strong>{editingMember.displayName || "未设置姓名"}</strong>
                  </div>
                  <div className="credential-field">
                    <span>登录账号</span>
                    <code>{editingMember.account || "已有 MX 账号"}</code>
                  </div>
                  <div className="credential-field">
                    <span>角色</span>
                    <strong>{memberRoleName(editingMember)}</strong>
                  </div>
                  <div className="credential-field">
                    <span>状态</span>
                    <strong>
                      {editingMember.status === "active" ? "正常" : "已停用"}
                    </strong>
                  </div>
                </div>
                {hasPermission(session, tenant, "members.update") && (
                  <Button
                    variant="outline"
                    onClick={() => setEditingDetails("profile")}
                  >
                    编辑员工资料
                  </Button>
                )}
                {hasPermission(session, tenant, "members.assign") && (
                  <Button
                    variant="outline"
                    onClick={() => setEditingDetails("role")}
                  >
                    分配角色
                  </Button>
                )}
                {owner && editingMember.managed && (
                  <Button
                    disabled={write.busy}
                    onClick={() =>
                      void write
                        .run(`members/${editingMember.id}/initial-password`, {})
                        .then((v) => {
                          setEditingMember(null);
                          setPassword(v.password);
                        })
                        .catch(() => {})
                    }
                  >
                    <Copy size={16} />
                    查看初始密码
                  </Button>
                )}
                {write.error && <p role="alert">{write.error}</p>}
              </>
            ))}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!statusMember}
        onOpenChange={(v) => {
          if (!v && !write.busy) setStatusMember(null);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>
              {statusMember?.status === "active"
                ? "确认停用子账号？"
                : "确认启用子账号？"}
            </DialogTitle>
            <DialogDescription>
              {statusMember?.displayName || statusMember?.account} ·{" "}
              {statusMember?.status === "active"
                ? "停用后该成员将无法继续访问企业数据。"
                : "启用后该成员可按角色权限访问企业数据。"}
            </DialogDescription>
          </DialogHeader>
          {write.error && <p role="alert">{write.error}</p>}
          <div className="account-row-actions">
            <Button
              variant="outline"
              disabled={write.busy}
              onClick={() => setStatusMember(null)}
            >
              取消
            </Button>
            <Button
              disabled={write.busy}
              onClick={() => {
                if (!hasPermission(session, tenant, "members.disable")) return;
                void write
                  .run(`members/${statusMember.id}`, {
                    status:
                      statusMember.status === "active" ? "suspended" : "active",
                  })
                  .then(() => {
                    setStatusMember(null);
                    view.reload();
                  })
                  .catch(() => {});
              }}
            >
              {write.busy
                ? "处理中…"
                : statusMember?.status === "active"
                  ? "确认停用"
                  : "确认启用"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {owner && roleEditor && (
        <RoleEditor
          {...props}
          onClose={() => {
            setRoleEditor(false);
            view.reload();
          }}
        />
      )}
    </>
  );
}
function RoleEditor(props: Props & { onClose: () => void }) {
  const view = useEnterprise(props.tenant, "roles"),
    write = useWrite(props),
    [draft, setDraft] = useState<any>(null);
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !write.busy) props.onClose();
      }}
    >
      <DialogContent className="dp-role-dialog">
        <DialogHeader>
          <DialogTitle>角色与权限</DialogTitle>
          <DialogDescription>
            固定角色不可修改，可复制为自定义角色。修改立即生效；角色定义和初始密码查看始终仅限企业超管。
          </DialogDescription>
        </DialogHeader>
        {(view.error || write.error) && (
          <p role="alert">{view.error || write.error}</p>
        )}
        <div className="dp-role-layout">
          <div>
            {view.data?.items.map((r: any) => (
              <div className="dp-role-item" key={r.id}>
                <strong>{r.name}</strong>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setDraft(
                      r.builtin
                        ? {
                            name: `${r.name}副本`,
                            permissions: [...r.permissions],
                          }
                        : { ...r },
                    )
                  }
                >
                  {r.builtin ? "复制" : "编辑"}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() => setDraft({ name: "", permissions: [] })}
            >
              新建自定义角色
            </Button>
          </div>
          {draft && (
            <form
              className="dp-form"
              onSubmit={(e) => {
                e.preventDefault();
                void write
                  .run("roles", draft)
                  .then(() => {
                    setDraft(null);
                    view.reload();
                  })
                  .catch(() => {});
              }}
            >
              <label>
                角色名称
                <Input
                  required
                  maxLength={60}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <div className="dp-permission-grid">
                {Object.entries(view.data?.catalog || {}).map(([id, label]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={draft.permissions.includes(id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          permissions: e.target.checked
                            ? [...draft.permissions, id]
                            : draft.permissions.filter((p: string) => p !== id),
                        })
                      }
                    />
                    {String(label)}
                  </label>
                ))}
              </div>
              <div className="harbor-actions">
                <Button disabled={write.busy}>保存角色</Button>
                {draft.id && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={write.busy}
                    onClick={() =>
                      void write
                        .run("roles", { ...draft, archived: true })
                        .then(() => {
                          setDraft(null);
                          view.reload();
                        })
                        .catch(() => {})
                    }
                  >
                    归档角色
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
const categories: Record<string, string> = {
  purchase: "购买与付款",
  technical: "接口与技术",
  account: "账户与账单",
  other: "其他问题",
};
export function Support(props: Props) {
  const [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [open, setOpen] = useState(
      () => !!sessionStorage.getItem("dataport:report-error"),
    ),
    [detail, setDetail] = useState<any>(null);
  const view = useEnterprise(
      props.tenant,
      `tickets?page=${page}&q=${encodeURIComponent(q)}&category=${category}&status=${status}`,
    ),
    write = useWrite(props);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>服务工单</h1>
          <p>提交购买、接入或账户问题，查看工单记录。</p>
        </div>
        {hasPermission(props.session, props.tenant, "support.create") && (
          <Button onClick={() => setOpen(true)}>
            <MessageCircle size={16} />
            新建工单
          </Button>
        )}
      </div>
      <Card className="harbor-table-panel parity-ticket-panel">
        <div className="dp-toolbar">
          <Input
            placeholder="搜索问题或工单编号"
            aria-label="搜索工单"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="工单分类"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部分类</option>
            {Object.entries(categories).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            aria-label="工单状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="saved">已提交</option>
          </select>
        </div>
        {view.error && <p role="alert">{view.error}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工单编号 / 问题</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>优先级</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>提交时间</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.data?.items.map((t: any) => (
              <TableRow key={t.id}>
                <TableCell>
                  <strong>{t.content.slice(0, 45)}</strong>
                  <small className="dp-account-id">{t.id}</small>
                </TableCell>
                <TableCell>{categories[t.category]}</TableCell>
                <TableCell>
                  {t.priority === "urgent" ? "紧急" : "普通"}
                </TableCell>
                <TableCell>
                  <span className="status good">已提交</span>
                </TableCell>
                <TableCell>{dateTime(t.created_at)}</TableCell>
                <TableCell>
                  <Button variant="link" onClick={() => setDetail(t)}>
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {view.data && !view.data.total && (
          <p className="harbor-empty">暂无工单记录</p>
        )}
        {view.data && (
          <Pagination label="工单" {...view.data} onChange={setPage} />
        )}
      </Card>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!write.busy) setOpen(v);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>新建工单</DialogTitle>
            <DialogDescription>选择问题方向，填写具体问题。</DialogDescription>
          </DialogHeader>
          <form
            className="dp-form ticket-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await write.run(
                  "tickets",
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
                sessionStorage.removeItem("dataport:report-error");
                setOpen(false);
                view.reload();
              } catch {}
            }}
          >
            <label>
              <span className="field-label-text">
                问题分类 <span className="required-mark">*</span>
              </span>
              <select name="category">
                {Object.entries(categories).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label-text">
                优先级 <span className="required-mark">*</span>
              </span>
              <select name="priority">
                <option value="normal">普通</option>
                <option value="urgent">紧急</option>
              </select>
            </label>
            <label>
              <span className="field-label-text">
                详细描述 <span className="required-mark">*</span>
              </span>
              <textarea
                name="content"
                required
                maxLength={5000}
                rows={5}
                defaultValue={
                  sessionStorage.getItem("dataport:report-error") || ""
                }
              />
            </label>
            <label>
              联系方式（选填）
              <Input name="contact" maxLength={200} />
            </label>
            {write.error && <p role="alert">{write.error}</p>}
            <Button disabled={write.busy}>新建工单</Button>
            <small>工单会保存到平台，外部客服通知暂未接入。</small>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(v) => {
          if (!v) setDetail(null);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>工单详情</DialogTitle>
            <DialogDescription>{detail?.id} · 已记录</DialogDescription>
          </DialogHeader>
          <p className="dp-prewrap">{detail?.content}</p>
          <p>联系方式：{detail?.contact || "未填写"}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}
export function Audit(props: Props) {
  const actionNames: Record<string, string> = {
    "query.executed": "执行查询",
    "member.created": "创建员工",
    "member.invited": "邀请员工",
    "member.joined": "确认加入企业",
    "member.updated": "修改员工",
    "member.initial-password.viewed": "查看初始密码",
    "role.saved": "保存角色",
    "role.archived": "归档角色",
    "key.created": "创建 API Key",
    "key.revoked": "撤销 API Key",
    "owner.verify": "超管身份验证",
    "owner.code.configured": "配置超管邀请码",
    "operation.failed": "操作失败",
    "order.checkout": "打开支付收银台",
    "order.refresh": "刷新订单状态",
  };
  const [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [action, setAction] = useState(""),
    [actor, setActor] = useState(""),
    [status, setStatus] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [actors, setActors] = useState<any[]>([]);
  useEffect(() => {
    const c = new AbortController();
    setActors([]);
    if (hasPermission(props.session, props.tenant, "members.read"))
      request(enterpriseUrl(props.tenant, "members"), { signal: c.signal })
        .then(({ data }) => {
          if (!c.signal.aborted) setActors(data.items || []);
        })
        .catch(() => {});
    return () => c.abort();
  }, [props.tenant, props.session]);
  const path = `audit?page=${page}&q=${encodeURIComponent(q)}&action=${encodeURIComponent(action)}&actor=${encodeURIComponent(actor)}&status=${status}&from=${from}&to=${to}`,
    view = useEnterprise(props.tenant, path),
    [exporting, setExporting] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>日志审阅</h1>
          <p>企业操作记录 · 时间、操作者与操作结果</p>
        </div>
        <div className="harbor-actions">
          <Button variant="outline" aria-label="刷新日志" onClick={view.reload}>
            <RefreshCw size={16} />
          </Button>
          {hasPermission(props.session, props.tenant, "audit.export") && (
            <Button
              variant="outline"
              disabled={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  let rows: any[] = [];
                  for (let n = 1; ; n++) {
                    const { data } = await request(
                      enterpriseUrl(
                        props.tenant,
                        `${path.replace(/page=\d+/, `page=${n}`)}&pageSize=100&export=1`,
                      ),
                    );
                    rows.push(...data.items);
                    if (rows.length >= data.total) break;
                  }
                  await downloadExcel(
                    "数港审计日志",
                    ["时间", "操作者", "操作", "目标", "状态", "请求编号"],
                    rows.map((r) => [
                      dateTime(r.created_at),
                      r.actorName || "平台管理员",
                      actionNames[r.action] || r.action,
                      r.target,
                      r.status,
                      r.detail?.requestId || "",
                    ]),
                  );
                } catch (e) {
                  view.setError((e as Error).message);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download size={16} />
              导出日志
            </Button>
          )}
        </div>
      </div>
      <Card className="harbor-table-panel parity-audit-panel">
        <div className="dp-toolbar">
          <Input
            aria-label="搜索日志"
            placeholder="搜索目标、操作者或请求编号"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="操作类型"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部操作</option>
            {Object.entries(actionNames).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="parity-actor-select"
            aria-label="操作者"
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部账号</option>
            {actors.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName || member.account || member.id}
              </option>
            ))}
            {actor && !actors.some((member) => member.id === actor) && (
              <option value={actor}>{actor}</option>
            )}
          </select>
        </div>
        <details className="parity-extra-filters">
          <summary>更多筛选</summary>
          <div className="dp-toolbar">
            <Input
              aria-label="操作者编号"
              placeholder="操作者编号"
              value={actor}
              onChange={(e) => {
                setActor(e.target.value);
                setPage(1);
              }}
            />

            <select
              aria-label="操作结果"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部结果</option>
              <option value="success">成功</option>
              <option value="failure">失败</option>
            </select>
            <input
              type="date"
              aria-label="日志开始日期"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
            <input
              type="date"
              aria-label="日志结束日期"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </details>
        {view.error && <p role="alert">{view.error}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>操作者</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>目标</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>操作时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.data?.items.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell title={r.actor}>
                  {r.actorName || (r.actor ? "未记录姓名" : "平台管理员")}
                </TableCell>
                <TableCell>{actionNames[r.action] || r.action}</TableCell>
                <TableCell>
                  <code>{r.target || "—"}</code>
                </TableCell>
                <TableCell>
                  {r.status < 400 ? "成功" : "失败"} · {r.status}
                </TableCell>
                <TableCell>
                  {dateTime(r.created_at)}
                  {r.detail?.requestId && (
                    <details className="audit-request-id">
                      <summary>请求编号</summary>
                      <code>{r.detail.requestId}</code>
                    </details>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {view.data && !view.data.total && (
          <p className="harbor-empty">暂无可审阅的操作记录</p>
        )}
        {view.data && (
          <Pagination label="日志" {...view.data} onChange={setPage} />
        )}
      </Card>
    </>
  );
}
export function JoinEnterprise({
  token,
  csrf,
  onJoined,
}: {
  token: string;
  csrf: string;
  onJoined: (tenant: string) => void;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    request(`/bff/v1/joins/${token}`, { signal: c.signal })
      .then((v) => setData(v.data))
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [token]);
  return (
    <Card className="dp-owner-challenge">
      <CardHeader>
        <CardTitle>确认加入企业</CardTitle>
        <p>加入后可以使用企业分配给你的服务与权限。</p>
      </CardHeader>
      <CardContent>
        {error ? (
          <p role="alert">{error}</p>
        ) : data ? (
          <>
            <h2>{data.tenantName}</h2>
            <p>
              {data.account} · {roleNames[data.roleId] || "自定义角色"}
            </p>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await request(`/bff/v1/joins/${token}`, {
                    method: "POST",
                    headers: { "x-mx-csrf": csrf },
                    body: JSON.stringify({ confirm: true }),
                  });
                  history.replaceState(null, "", "/#/intelligence");
                  onJoined(result.data.tenantId);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认加入
            </Button>
          </>
        ) : (
          <p>正在读取邀请…</p>
        )}
      </CardContent>
    </Card>
  );
}
