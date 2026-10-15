import { useEffect, useState } from "react";
import { Building2, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { request } from "./api";
import { Pagination } from "./pagination";
import { dateTime } from "./commerce-state";
const base = "/bff/v1/platform/enterprises";
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, "0")).join("");
type Target = {
    kind: "enterprise" | "owner" | "code" | "password";
    tenant?: any;
    owner?: any;
};
export function PlatformAdmin({ csrf, memberId }: {
    csrf: string;
    memberId: string;
}) {
    const pendingKey = `dataport:platform-command:${memberId}`;
    const [data, setData] = useState<any>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [page, setPage] = useState(1), [query, setQuery] = useState(""), [search, setSearch] = useState(""), [revision, setRevision] = useState(0), [target, setTarget] = useState<Target | null>(null), [name, setName] = useState(""), [account, setAccount] = useState(""), [operation, setOperation] = useState("invite"), [code, setCode] = useState(""), [result, setResult] = useState<any>(null), [intent, setIntent] = useState(() => crypto.randomUUID()), [submitted, setSubmitted] = useState(false), [canEdit, setCanEdit] = useState(false), [notice, setNotice] = useState("");
    useEffect(() => {
        try {
            const saved = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
            if (saved && ["enterprise", "owner"].includes(saved.target?.kind) && /^[0-9a-f-]{36}$/.test(saved.intent || "") && typeof saved.name === "string" && typeof saved.account === "string" && ["invite", "create"].includes(saved.operation)) {
                setTarget(saved.target);
                setName(saved.name);
                setAccount(saved.account);
                setOperation(saved.operation);
                setIntent(saved.intent);
                setSubmitted(true);
                setError("上一次操作结果待确认，请使用原编号重试。");
            }
        }
        catch { /* Corrupt local intent cannot grant any server permission. */ }
    }, [pendingKey]);
    useEffect(() => {
        const c = new AbortController();
        setData(null);
        setError("");
        request(`${base}?page=${page}&pageSize=10&q=${encodeURIComponent(search)}`, { signal: c.signal })
            .then(v => { if (!c.signal.aborted)
            setData(v.data); })
            .catch(e => { if (!c.signal.aborted)
            setError(e.message); });
        return () => c.abort();
    }, [page, search, revision]);
    function open(next: Target) {
        const pending = sessionStorage.getItem(pendingKey);
        if (pending) {
            try {
                const saved = JSON.parse(pending);
                setTarget(saved.target);
                setName(saved.name);
                setAccount(saved.account);
                setOperation(saved.operation);
                setIntent(saved.intent);
                setSubmitted(true);
                setResult(null);
                setError("上一次操作结果待确认，请使用原编号重试。");
                return;
            }
            catch {
                setError("操作记录损坏，请联系管理员核实后再开户。");
                return;
            }
        }
        setCanEdit(false);
        setTarget(next);
        setName("");
        setAccount("");
        setCode("");
        setOperation("invite");
        setResult(null);
        setError("");
        setIntent(crypto.randomUUID());
        setSubmitted(false);
    }
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!target || busy)
            return;
        setBusy(true);
        setError("");
        if (target.kind === "enterprise" || target.kind === "owner") {
            try {
                sessionStorage.setItem(pendingKey, JSON.stringify({ target: { kind: target.kind, tenant: target.tenant ? { id: target.tenant.id, name: target.tenant.name } : undefined }, intent, name, account, operation }));
            }
            catch {
                setError("无法保存操作编号，请允许站点存储后重试。");
                setBusy(false);
                return;
            }
        }
        setSubmitted(true);
        try {
            let path = base, body: any;
            if (target.kind === "enterprise")
                body = { commandId: intent, name };
            else if (target.kind === "owner") {
                path += `/${target.tenant.id}/owners`;
                body = { commandId: intent, account, displayName: name || undefined, operation };
            }
            else if (target.kind === "code") {
                path += `/${target.tenant.id}/owners/${target.owner.memberId}/code`;
                body = { code };
            }
            else {
                path += `/${target.tenant.id}/owners/${target.owner.memberId}/initial-password`;
                body = {};
            }
            const value = (await request(path, { method: "POST", headers: { "x-mx-csrf": csrf }, body: JSON.stringify(body) })).data;
            sessionStorage.removeItem(pendingKey);
            setResult(value);
            setRevision(v => v + 1);
            setNotice(target.kind === "enterprise" ? "企业已创建，请为企业添加超管。" : target.kind === "code" ? "专属邀请码已更新，原超管会话需要重新验证。" : target.kind === "owner" ? (value.joinToken ? "邀请已生成，待指定 MX 账号确认加入。" : "企业超管已创建，请配置专属邀请码并查看初始密码。") : "");
            if (target.kind === "code")
                setCode("");
        }
        catch (e) {
            setError((e as Error).message);
            setCanEdit(["account_exists", "invalid_account", "invalid_platform_command"].includes((e as any).code));
        }
        finally {
            setBusy(false);
        }
    }
    return <section className="enterprise-page platform-page">
    <div className="platform-heading"><div><h1><ShieldCheck size={26}/> 数港平台管理</h1><p>开通企业、添加企业超管，并管理超管专属邀请码。</p></div><Button onClick={() => open({ kind: "enterprise" })}><Plus size={16}/>创建企业</Button></div>
    {notice && <p role="status">{notice}</p>}
    {!target && error && <p role="alert">{error}</p>}
    <Card><CardHeader><CardTitle>企业与超管</CardTitle></CardHeader><CardContent>
      <form className="platform-search" onSubmit={e => { e.preventDefault(); setSearch(query); setPage(1); }}><Input aria-label="搜索企业" placeholder="搜索企业名称" value={query} onChange={e => setQuery(e.target.value)} maxLength={100}/><Button type="submit" variant="outline">搜索</Button><Button type="button" variant="outline" aria-label="刷新企业列表" onClick={() => setRevision(v => v + 1)}><RefreshCw size={16}/></Button></form>
      {!data ? <p>{error ? "企业加载失败，请刷新重试。" : "正在加载企业…"}</p> : data.items.length === 0 ? <p>暂无匹配的企业。</p> : data.items.map((tenant: any) => <article className="platform-enterprise" key={tenant.id}>
        <div className="platform-enterprise-title"><h2><Building2 size={18}/>{tenant.name}</h2><Button variant="outline" size="sm" onClick={() => open({ kind: "owner", tenant })}>添加企业超管</Button></div>
        {!tenant.owners.length ? <p>尚未添加企业超管。</p> : tenant.owners.map((owner: any) => <div className="platform-owner" key={owner.memberId}>
          <div><strong>{owner.displayName}</strong>{owner.account && <span> · {owner.account}</span>}<p>{owner.codeConfigured ? "专属邀请码已配置" : "专属邀请码未配置"}</p></div>
          <div className="platform-actions"><Button size="sm" variant="outline" onClick={() => open({ kind: "code", tenant, owner })}>{owner.codeConfigured ? "重置邀请码" : "配置邀请码"}</Button>{owner.managed && <Button size="sm" variant="outline" onClick={() => open({ kind: "password", tenant, owner })}>查看初始密码</Button>}</div>
        </div>)}
      </article>)}
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} label="企业" onChange={setPage}/>}
    </CardContent></Card>
    <Dialog open={!!target} onOpenChange={value => { if (!busy && !value) {
        setTarget(null);
        setResult(null);
        setCode("");
        setError("");
    } }}><DialogContent className="platform-dialog"><DialogHeader><DialogTitle>{target?.kind === "enterprise" ? "创建企业" : target?.kind === "owner" ? `添加企业超管 · ${target.tenant.name}` : target?.kind === "code" ? `配置专属邀请码 · ${target.owner.displayName}` : `查看初始密码 · ${target?.owner.displayName || ""}`}</DialogTitle><DialogDescription>{target?.kind === "enterprise" ? "创建后可添加企业超管。" : target?.kind === "owner" ? "使用统一 MX 认证。已有账号须确认邀请后才会获得企业超管权限。" : target?.kind === "code" ? "用于企业超管登录验证，与注册邀请码不同。重置后原超管会话须重新验证，请妥善交付新码。" : "仅可查看数港创建且尚未修改过的初始密码。"}</DialogDescription></DialogHeader>
      <form className="platform-form" onSubmit={submit}>
        {target?.kind === "enterprise" && <label>企业名称<Input required maxLength={100} value={name} disabled={submitted} onChange={e => setName(e.target.value)}/></label>}
        {target?.kind === "owner" && <><label>开户方式<select value={operation} disabled={submitted} onChange={e => setOperation(e.target.value)}><option value="invite">邀请已有 MX 账号</option><option value="create">创建新的 MX 账号</option></select></label><label>MX 账号<Input required autoComplete="off" minLength={3} maxLength={128} value={account} disabled={submitted} onChange={e => setAccount(e.target.value)}/></label><label>姓名<Input maxLength={80} value={name} disabled={submitted} onChange={e => setName(e.target.value)}/></label><p>企业超管可以管理该企业的成员、角色、API Key、订阅和账单。操作未确认时，关闭或刷新页面后仍会保留原编号。</p></>}
        {target?.kind === "code" && !result && <><label>专属邀请码<Input required autoComplete="off" minLength={12} maxLength={128} value={code} disabled={submitted} onChange={e => setCode(e.target.value)}/></label><Button type="button" variant="outline" disabled={submitted} onClick={() => setCode(newCode())}>生成随机邀请码</Button><p>请先保存并通过可靠渠道交付。保存后无法查看原码。</p></>}
        {error && <p role="alert">{error}{submitted && " 操作参数已锁定；可使用原编号重试确认结果。"}</p>}
        {result && <div role="status">{result.joinToken ? <><p>邀请有效至 {dateTime(result.expiresAt)}。确认加入后，在企业列表为该超管配置专属邀请码。</p><label>邀请链接<Input readOnly value={`${location.origin}/join?token=${result.joinToken}`} onFocus={e => e.target.select()}/></label></> : result.password ? <label>初始密码<Input readOnly value={result.password} onFocus={e => e.target.select()}/></label> : <p>{notice}</p>}</div>}
        <div className="platform-actions">{canEdit && <Button type="button" variant="outline" disabled={busy} onClick={() => { sessionStorage.removeItem(pendingKey); setIntent(crypto.randomUUID()); setSubmitted(false); setError(""); setCanEdit(false); }}>重新填写</Button>}<Button type="button" variant="outline" disabled={busy} onClick={() => { setTarget(null); setResult(null); setCode(""); setError(""); }}>关闭</Button>{!result && <Button type="submit" disabled={busy}>{busy ? "正在处理…" : submitted ? "使用原编号重试" : target?.kind === "password" ? "确认查看" : target?.kind === "owner" ? (operation === "invite" ? "生成超管邀请" : "确认创建超管") : "确认保存"}</Button>}</div>
      </form>
    </DialogContent></Dialog>
  </section>;
}
