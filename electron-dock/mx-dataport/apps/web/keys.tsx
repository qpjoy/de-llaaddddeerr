import { useEffect, useState } from "react";
import { Plus, Copy, KeyRound, Info, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { request } from "./api";
import { enterpriseUrl, hasPermission } from "./permissions";
import { dateTime } from "./commerce-state";
import { Pagination, useLocalPage } from "./pagination";
export function ApiKeys({
  tenant,
  session,
  csrf,
}: {
  tenant: string;
  session: any;
  csrf: string;
}) {
  const [items, setItems] = useState<any[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [secret, setSecret] = useState(""),
    [revoke, setRevoke] = useState<any>(null),
    [copied, setCopied] = useState(false);
  const rows = useLocalPage(items, 10);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setItems([]);
    request(enterpriseUrl(tenant, "keys"), { signal: c.signal })
      .then((v) => {
        if (!c.signal.aborted) setItems(v.data.items);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [tenant, version]);
  async function post(path: string, body: any) {
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
      setError(
        (e as Error).message +
          (path === "keys"
            ? " 请先关闭弹窗并核对 Key 列表，确认上次创建结果。"
            : ""),
      );
      if (path === "keys") setVersion((v) => v + 1);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>API Keys</h1>
          <p>管理企业接入凭证，Key 仍受独立授权、额度和订阅限制。</p>
        </div>
        {hasPermission(session, tenant, "keys.create") && (
          <Button onClick={() => setOpen(true)}>
            <Plus size={16} />
            签发 API Key
          </Button>
        )}
      </div>
      <div className="notice">
        <Info size={16} />
        <span>
          完整密钥仅展示一次。替换密钥时，请先完成客户端切换，再手动撤销旧
          Key。实际调用仍受企业、Key 权限和订阅额度限制。
        </span>
      </div>
      {error && (
        <p role="alert" className="harbor-error">
          {error}
        </p>
      )}
      <Card className="harbor-table-panel">
        {items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>Key 标识</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>到期时间</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.items.map((k) => (
                <TableRow key={k.id}>
                  <TableCell>
                    <KeyRound size={15} />
                    {k.name}
                  </TableCell>
                  <TableCell>
                    <code>{k.prefix || k.id}••••••</code>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`status ${(k.effectiveStatus || k.status) === "active" ? "good" : "pending"}`}
                    >
                      {(
                        {
                          active: "正常",
                          revoked: "已撤销",
                          expired: "已到期",
                          suspended: "已停用",
                        } as Record<string, string>
                      )[k.effectiveStatus || k.status] || "不可用"}
                    </span>
                  </TableCell>
                  <TableCell>{dateTime(k.expiresAt)}</TableCell>
                  <TableCell>
                    {hasPermission(session, tenant, "keys.revoke") &&
                      (k.effectiveStatus || k.status) === "active" && (
                        <Button variant="ghost" onClick={() => setRevoke(k)}>
                          撤销
                        </Button>
                      )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {loading ? (
          <p className="harbor-empty">正在读取 API Keys…</p>
        ) : (
          !items.length && (
            <div className="empty-state parity-key-empty">
              <div className="empty-icon">
                <Database size={28} />
              </div>
              <h3>签发你的第一把 API Key</h3>
              <p>密钥用于服务端请求鉴权，完整凭证只展示一次。</p>
              {hasPermission(session, tenant, "keys.create") && (
                <Button onClick={() => setOpen(true)}>
                  <Plus size={16} />
                  签发 API Key
                </Button>
              )}
            </div>
          )
        )}
        {items.length > 0 && (
          <Pagination
            label="API Keys"
            {...rows.pagination}
            onChange={rows.setPage}
          />
        )}
      </Card>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>签发 API Key</DialogTitle>
            <DialogDescription>
              新 Key 仅授权当前企业 IP
              风险画像产品，完整凭证仅在创建成功后显示一次。
            </DialogDescription>
          </DialogHeader>
          <form
            className="dp-key-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              try {
                const k = await post("keys", {
                  name: data.get("name"),
                  expiresInDays: Number(data.get("days")),
                });
                setSecret(k.secret);
                setCopied(false);
                setOpen(false);
                setVersion((v) => v + 1);
              } catch {}
            }}
          >
            <label className="field">
              密钥名称
              <input
                name="name"
                required
                maxLength={80}
                placeholder="例如：开发测试环境"
              />
            </label>
            <label className="field">
              有效期
              <select name="days">
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="365">365 天</option>
              </select>
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button disabled={busy}>签发 API Key</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!secret}
        onOpenChange={(v) => {
          if (!v) setSecret("");
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>保存你的 API Key</DialogTitle>
            <DialogDescription>
              完整 Key 仅展示此次，请保存在服务端。关闭后不能再次查看。
            </DialogDescription>
          </DialogHeader>
          <Input readOnly value={secret} aria-label="新 API Key" />
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret);
                setCopied(true);
              } catch {
                setError("复制失败，请手动复制。");
              }
            }}
          >
            <Copy size={16} />
            {copied ? "已复制" : "复制 Key"}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!revoke}
        onOpenChange={(v) => {
          if (!v && !busy) setRevoke(null);
        }}
      >
        <DialogContent className="dp-dialog">
          <DialogHeader>
            <DialogTitle>撤销 API Key</DialogTitle>
            <DialogDescription>
              撤销后，使用「{revoke?.name}
              」的应用将无法继续调用。此操作不能恢复。
            </DialogDescription>
          </DialogHeader>
          <Button
            disabled={busy}
            onClick={() =>
              void post(`keys/${revoke.id}/revoke`, {})
                .then(() => {
                  setRevoke(null);
                  setVersion((v) => v + 1);
                })
                .catch(() => {})
            }
          >
            确认撤销
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
