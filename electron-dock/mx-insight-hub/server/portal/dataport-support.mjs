import { createHash } from "node:crypto";
import { AppError } from "../core/errors.mjs";
import { withPgTransaction } from "../stores/postgres-store.mjs";
import {
  requireDataportAccess,
  legacyPermissions,
} from "./dataport-policy.mjs";
import { paging, uuid } from "./dataport-store.mjs";

const fail = (status, code, message) => {
  throw new AppError(status, code, message);
};
export const ticketStatuses = ["saved", "processing", "closed"];
export class DataportSupport {
  constructor(store) {
    this.store = store;
    this.pool = store.pool;
  }
  async detail(principal, tenantId, id) {
    const m = requireDataportAccess(principal, tenantId),
      p = m.dataport?.permissions || legacyPermissions(m);
    if (
      !uuid(id) ||
      !p.some((x) => ["support.read.self", "support.read.tenant"].includes(x))
    )
      fail(403, "insufficient_permission", "无权查看工单。");
    const ticket = (
      await this.pool.query(
        "SELECT * FROM dataport.tickets WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR actor=$3)",
        [
          tenantId,
          id,
          p.includes("support.read.tenant") ? null : principal.memberId,
        ],
      )
    ).rows[0];
    if (!ticket) fail(404, "ticket_not_found", "工单不存在。");
    return this.withReplies(ticket);
  }
  async withReplies(ticket) {
    return {
      ...ticket,
      replies: (
        await this.pool.query(
          "SELECT id,status,reply,created_at FROM dataport.ticket_updates WHERE tenant_id=$1 AND ticket_id=$2 ORDER BY created_at,id",
          [ticket.tenant_id, ticket.id],
        )
      ).rows,
    };
  }
  requireAdmin(principal) {
    if (principal?.kind !== "admin-token")
      fail(403, "admin_token_required", "工单处理仅允许既有平台管理通道。");
    this.store.available();
  }
  async list(principal, search) {
    this.requireAdmin(principal);
    const { page, pageSize, offset } = paging(search),
      tenant = search.get("tenantId") || null,
      status = search.get("status") || "",
      q = (search.get("q") || "").trim();
    if (
      (tenant && !uuid(tenant)) ||
      !["", ...ticketStatuses].includes(status) ||
      q.length > 100 ||
      [...search.keys()].some(
        (k) =>
          !["page", "pageSize", "tenantId", "status", "q"].includes(k) ||
          search.getAll(k).length !== 1,
      )
    )
      fail(400, "invalid_ticket_filter", "工单筛选条件无效。");
    const args = [tenant, status, q],
      where =
        "($1::uuid IS NULL OR t.tenant_id=$1) AND ($2='' OR t.status=$2) AND ($3='' OR position(lower($3) in lower(t.content||' '||t.id::text||' '||e.name))>0)";
    const total = (
      await this.pool.query(
        `SELECT count(*)::int AS total FROM dataport.tickets t JOIN tenants e ON e.id=t.tenant_id WHERE ${where}`,
        args,
      )
    ).rows[0].total;
    const items = (
      await this.pool.query(
        `SELECT t.*,e.name AS "tenantName" FROM dataport.tickets t JOIN tenants e ON e.id=t.tenant_id WHERE ${where} ORDER BY t.updated_at DESC,t.id LIMIT $4 OFFSET $5`,
        [...args, pageSize, offset],
      )
    ).rows;
    return { items, total, page, pageSize };
  }
  async adminDetail(principal, tenantId, id) {
    this.requireAdmin(principal);
    if (!uuid(tenantId) || !uuid(id))
      fail(400, "invalid_ticket", "工单编号无效。");
    const t = (
      await this.pool.query(
        "SELECT * FROM dataport.tickets WHERE tenant_id=$1 AND id=$2",
        [tenantId, id],
      )
    ).rows[0];
    if (!t) fail(404, "ticket_not_found", "工单不存在。");
    return this.withReplies(t);
  }
  async update(principal, tenantId, id, body) {
    this.requireAdmin(principal);
    if (
      !uuid(tenantId) ||
      !uuid(id) ||
      !body ||
      Object.keys(body).some(
        (k) => !["commandId", "revision", "status", "reply"].includes(k),
      ) ||
      !uuid(body.commandId) ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 1 ||
      !ticketStatuses.includes(body.status) ||
      typeof body.reply !== "string" ||
      body.reply.length > 5000
    )
      fail(400, "invalid_ticket_update", "请填写有效状态、回复和工单版本。");
    const reply = body.reply.trim(),
      fingerprint = createHash("sha256")
        .update(
          JSON.stringify([tenantId, id, body.revision, body.status, reply]),
        )
        .digest("hex");
    return withPgTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-ticket-command:${body.commandId}`,
      ]);
      const t = (
        await db.query(
          "SELECT * FROM dataport.tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [tenantId, id],
        )
      ).rows[0];
      if (!t) fail(404, "ticket_not_found", "工单不存在。");
      const old = (
        await db.query("SELECT * FROM dataport.ticket_updates WHERE id=$1", [
          body.commandId,
        ])
      ).rows[0];
      if (old) {
        if (
          old.tenant_id !== tenantId ||
          old.ticket_id !== id ||
          old.fingerprint !== fingerprint
        )
          fail(409, "ticket_command_conflict", "操作编号已被使用。");
        return { updated: true, replayed: true };
      }
      if (t.revision !== body.revision)
        fail(409, "ticket_revision_conflict", "工单已更新，请刷新后再处理。");
      if (!reply && body.status === t.status)
        fail(400, "empty_ticket_update", "请填写回复或调整状态。");
      await db.query(
        "INSERT INTO dataport.ticket_updates(id,ticket_id,tenant_id,fingerprint,status,reply) VALUES($1,$2,$3,$4,$5,$6)",
        [body.commandId, id, tenantId, fingerprint, body.status, reply],
      );
      await db.query(
        "UPDATE dataport.tickets SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, id, body.status],
      );
      // Only the submitting member receives this receipt. Never broadcast ticket content to the enterprise.
      await db.query(
        "INSERT INTO hub_commerce.messages(tenant_id,kind,recipient_id,document) VALUES($1,'ticket_updated',$2,$3)",
        [
          tenantId,
          t.actor,
          { ticketId: id, status: body.status, hasReply: !!reply },
        ],
      );
      await this.store.event(
        tenantId,
        null,
        "ticket.updated",
        id,
        200,
        { status: body.status, hasReply: !!reply, operator: "admin-token" },
        db,
      );
      return { updated: true };
    });
  }
}
