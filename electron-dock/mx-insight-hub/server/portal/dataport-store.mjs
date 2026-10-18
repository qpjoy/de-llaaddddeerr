import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "../core/errors.mjs";
import { withPgTransaction } from "../stores/postgres-store.mjs";
import {
  BUILTIN_ROLES,
  PERMISSIONS,
  legacyPermissions,
  requireDataportAccess,
  requireOwner,
  isOwner,
  validatePermissions,
} from "./dataport-policy.mjs";
import { identityLock } from "../identity/sso-store.mjs";
import { capabilitiesForRole } from "../identity/index.mjs";
import { DataportLocalAccounts } from "./dataport-local-accounts.mjs";

export const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
export function hashCode(code) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(code, salt, 32).toString("hex")}`;
}
export function verifyCode(code, encoded) {
  const [salt, hash] = String(encoded || "").split(":");
  if (!/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{64}$/.test(hash || ""))
    return false;
  return timingSafeEqual(scryptSync(code, salt, 32), Buffer.from(hash, "hex"));
}
export function paging(search, defaultSize = 10) {
  const page = Number(search.get("page") || 1),
    pageSize = Number(search.get("pageSize") || defaultSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new AppError(400, "invalid_pagination", "分页参数不正确。");
  return { page, pageSize, offset: (page - 1) * pageSize };
}
const text = (value, max = 100) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const problem = (status, code, message) => {
  throw new AppError(status, code, message);
};

export class DataportStore {
  constructor(pool, { credentialPepper } = {}) {
    this.pool = pool;
    this.localAccounts = new DataportLocalAccounts(this, credentialPepper);
  }
  available() {
    if (!this.pool)
      problem(503, "dataport_storage_required", "企业服务尚未配置。");
  }
  async event(
    tenantId,
    actor,
    action,
    target = "",
    status = 200,
    detail = {},
    db = this.pool,
  ) {
    if (this.requestId) detail = { ...detail, requestId: this.requestId };
    await db.query(
      "INSERT INTO dataport.events(tenant_id,actor,action,target,status,detail) VALUES($1,$2,$3,$4,$5,$6)",
      [tenantId, actor, action, String(target).slice(0, 255), status, detail],
    );
  }
  async role(tenantId, id, db = this.pool) {
    const builtin = BUILTIN_ROLES.find((r) => r.id === id);
    if (builtin) return builtin;
    return (
      await db.query(
        "SELECT id,name,permissions,revision,false AS builtin FROM dataport.roles WHERE tenant_id=$1 AND id=$2 AND NOT archived",
        [tenantId, id],
      )
    ).rows[0];
  }
  async enrich(principal, sessionDigest) {
    this.available();
    const memberships = [];
    for (let membership of principal.memberships || []) {
      const current = (
        await this.pool.query(
          `SELECT tm.role FROM iam.tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id JOIN iam.members m ON m.id=tm.member_id
          LEFT JOIN dataport.managed_accounts ma ON ma.tenant_id=tm.tenant_id AND ma.member_id=tm.member_id
          WHERE tm.tenant_id=$1 AND tm.member_id=$2 AND tm.status='active' AND t.status='active' AND m.status='active'
          AND ($3='dataport-user' OR coalesce(ma.auth_mode,'mx')<>'local')`,
          [membership.tenantId, principal.memberId, principal.kind],
        )
      ).rows[0];
      if (!current) continue;
      membership = {
        ...membership,
        role: current.role,
        capabilities: capabilitiesForRole(current.role),
      };
      const assignment = (
        await this.pool.query(
          "SELECT role_id,revision FROM dataport.member_roles WHERE tenant_id=$1 AND member_id=$2",
          [membership.tenantId, principal.memberId],
        )
      ).rows[0];
      const role =
        membership.role === "owner"
          ? BUILTIN_ROLES[0]
          : assignment
            ? await this.role(membership.tenantId, assignment.role_id)
            : null;
      let permissions =
        role?.permissions || (assignment ? [] : legacyPermissions(membership));
      let ownerChallengeRequired = false;
      if (membership.role === "owner") {
        const authorized =
          /^[a-f0-9]{64}$/.test(sessionDigest || "") &&
          (
            await this.pool.query(
              `SELECT 1 FROM dataport.owner_sessions s JOIN dataport.owner_codes c
          ON c.tenant_id=s.tenant_id AND c.member_id=s.member_id AND c.revision=s.code_revision
          WHERE s.tenant_id=$1 AND s.member_id=$2 AND s.session_digest=$3 AND s.expires_at>now()`,
              [membership.tenantId, principal.memberId, sessionDigest],
            )
          ).rowCount > 0;
        ownerChallengeRequired = !authorized;
      }
      memberships.push({
        ...membership,
        dataport: {
          roleId: role?.id || `legacy:${membership.role}`,
          roleName: role?.name || `原有${membership.role}角色`,
          permissions,
          revision: assignment?.revision || 0,
          ownerChallengeRequired,
        },
      });
    }
    return {
      ...principal,
      tenantIds: memberships.map((m) => m.tenantId),
      memberships,
      dataportSession: sessionDigest,
    };
  }
  async configureOwnerCode(tenantId, memberId, code, actor) {
    this.available();
    if (
      !uuid(tenantId) ||
      !uuid(memberId) ||
      typeof code !== "string" ||
      code.length < 12 ||
      code.length > 128
    )
      problem(400, "invalid_owner_code", "邀请码须为 12–128 位。");
    return withPgTransaction(this.pool, async (db) => {
      const owner = await db.query(
        "SELECT 1 FROM iam.tenant_memberships WHERE tenant_id=$1 AND member_id=$2 AND role='owner' AND status='active' FOR UPDATE",
        [tenantId, memberId],
      );
      if (!owner.rowCount) problem(404, "owner_not_found", "企业超管不存在。");
      await db.query(
        `INSERT INTO dataport.owner_codes(tenant_id,member_id,digest) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id,member_id) DO UPDATE SET digest=excluded.digest,revision=dataport.owner_codes.revision+1`,
        [tenantId, memberId, hashCode(code)],
      );
      await db.query(
        "DELETE FROM dataport.owner_sessions WHERE tenant_id=$1 AND member_id=$2",
        [tenantId, memberId],
      );
      await this.event(
        tenantId,
        null,
        "owner.code.configured",
        memberId,
        200,
        { operator: actor },
        db,
      );
      return { configured: true };
    });
  }
  async ownerChallenge(principal, tenantId, code) {
    const m = principal.memberships.find((m) => m.tenantId === tenantId);
    if (
      !m ||
      m.role !== "owner" ||
      !/^[a-f0-9]{64}$/.test(principal.dataportSession || "")
    )
      problem(403, "owner_required", "企业超管会话无效。");
    if (typeof code !== "string" || code.length > 128)
      problem(400, "invalid_owner_code", "请填写专属邀请码。");
    // Failed attempts commit before returning an error; the lock covers all browser sessions.
    const result = await withPgTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-owner:${tenantId}:${principal.memberId}`,
      ]);
      const failures = (
        await db.query(
          "SELECT count(*)::int AS n FROM dataport.events WHERE tenant_id=$1 AND actor=$2 AND action='owner.verify' AND status=403 AND created_at>now()-interval '15 minutes'",
          [tenantId, principal.memberId],
        )
      ).rows[0].n;
      if (failures >= 5)
        return {
          status: 429,
          code: "owner_code_rate_limited",
          message: "尝试次数过多，请在 15 分钟后重试。",
        };
      const stored = (
        await db.query(
          "SELECT digest,revision FROM dataport.owner_codes WHERE tenant_id=$1 AND member_id=$2",
          [tenantId, principal.memberId],
        )
      ).rows[0];
      const valid = stored && verifyCode(code, stored.digest);
      await this.event(
        tenantId,
        principal.memberId,
        "owner.verify",
        "",
        valid ? 200 : 403,
        {},
        db,
      );
      if (!valid)
        return {
          status: 403,
          code: stored ? "owner_code_invalid" : "owner_code_not_configured",
          message: stored
            ? "邀请码不正确。"
            : "此超管的邀请码尚未配置，请联系平台管理员。",
        };
      await db.query(
        `INSERT INTO dataport.owner_sessions(tenant_id,member_id,session_digest,code_revision,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '30 days') ON CONFLICT(tenant_id,member_id,session_digest)
        DO UPDATE SET code_revision=excluded.code_revision,expires_at=excluded.expires_at`,
        [
          tenantId,
          principal.memberId,
          principal.dataportSession,
          stored.revision,
        ],
      );
      return { verified: true };
    });
    if (result.status) problem(result.status, result.code, result.message);
    return result;
  }
  async roles(principal, tenantId) {
    requireOwner(principal, tenantId);
    const custom = (
      await this.pool.query(
        "SELECT id,name,permissions,revision,false AS builtin FROM dataport.roles WHERE tenant_id=$1 AND NOT archived ORDER BY name",
        [tenantId],
      )
    ).rows;
    return { items: [...BUILTIN_ROLES, ...custom], catalog: PERMISSIONS };
  }
  async saveRole(principal, tenantId, body) {
    requireOwner(principal, tenantId);
    const name = text(body.name, 60),
      permissions = validatePermissions(body.permissions),
      id = body.id || randomUUID();
    if (!name || !uuid(id)) problem(400, "invalid_role", "请填写角色名称。");
    return withPgTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-members:${tenantId}`,
      ]);
      const before = (
        await db.query(
          "SELECT * FROM dataport.roles WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [tenantId, id],
        )
      ).rows[0];
      if (before && before.revision !== body.revision)
        problem(409, "role_revision_conflict", "角色已被修改，请刷新后重试。");
      if (
        body.archived &&
        (
          await db.query(
            "SELECT 1 FROM dataport.member_roles WHERE tenant_id=$1 AND role_id=$2 LIMIT 1",
            [tenantId, id],
          )
        ).rowCount
      )
        problem(409, "role_in_use", "请先将成员迁移到其他角色。");
      const saved = (
        await db.query(
          `INSERT INTO dataport.roles(tenant_id,id,name,permissions) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,archived=$5,revision=dataport.roles.revision+1
        RETURNING id,name,permissions,revision`,
          [
            tenantId,
            id,
            name,
            JSON.stringify(permissions),
            body.archived === true,
          ],
        )
      ).rows[0];
      await this.event(
        tenantId,
        principal.memberId,
        body.archived ? "role.archived" : "role.saved",
        id,
        200,
        { before: before?.permissions || [], after: permissions },
        db,
      );
      return saved;
    });
  }
  async members(principal, tenantId, search = new URLSearchParams()) {
    requireDataportAccess(principal, tenantId, "members.read");
    const permissions =
        requireDataportAccess(principal, tenantId).dataport?.permissions || [],
      all = [
        ...BUILTIN_ROLES,
        ...(
          await this.pool.query(
            "SELECT id,name,permissions FROM dataport.roles WHERE tenant_id=$1 AND NOT archived",
            [tenantId],
          )
        ).rows,
      ];
    const { page, pageSize, offset } = paging(search),
      q = text(search.get("q"));
    const summary = (
      await this.pool.query(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE role<>'owner')::int AS "employeeCount" FROM iam.tenant_memberships WHERE tenant_id=$1`,
        [tenantId],
      )
    ).rows[0];
    const filter =
      " AND ($2='' OR position(lower($2) in lower(coalesce(mp.display_name,m.display_name)||' '||coalesce(ma.account,'')))>0)";
    const total = (
      await this.pool.query(
        `SELECT count(*)::int AS total FROM iam.tenant_memberships tm JOIN iam.members m ON m.id=tm.member_id LEFT JOIN dataport.member_profiles mp ON mp.tenant_id=tm.tenant_id AND mp.member_id=tm.member_id LEFT JOIN dataport.managed_accounts ma ON ma.tenant_id=tm.tenant_id AND ma.member_id=tm.member_id WHERE tm.tenant_id=$1 ${filter}`,
        [tenantId, q],
      )
    ).rows[0].total;
    return {
      total,
      page,
      pageSize,
      summary,
      roles: all
        .filter(
          (r) =>
            isOwner(principal, tenantId) ||
            (r.id !== "owner" &&
              r.permissions.every((p) => permissions.includes(p))),
        )
        .map((r) => ({ id: r.id, name: r.name })),
      items: (
        await this.pool.query(
          `SELECT m.id,coalesce(mp.display_name,m.display_name) AS "displayName",tm.role,tm.status,
      a.role_id AS "roleId",a.revision,ma.account,ma.auth_mode AS "authMode",coalesce(ma.managed,false) AS managed FROM iam.tenant_memberships tm JOIN iam.members m ON m.id=tm.member_id
      LEFT JOIN dataport.member_roles a ON a.tenant_id=tm.tenant_id AND a.member_id=tm.member_id
      LEFT JOIN dataport.managed_accounts ma ON ma.tenant_id=tm.tenant_id AND ma.member_id=tm.member_id
      LEFT JOIN dataport.member_profiles mp ON mp.tenant_id=tm.tenant_id AND mp.member_id=tm.member_id
      WHERE tm.tenant_id=$1 ${filter} ORDER BY (tm.role='owner') DESC,m.display_name,m.id LIMIT $3 OFFSET $4`,
          [tenantId, q, pageSize, offset],
        )
      ).rows,
    };
  }
  async updateMember(principal, tenantId, memberId, body) {
    if (
      Object.keys(body).length !== 1 ||
      Object.keys(body).some(
        (k) => !["roleId", "status", "displayName"].includes(k),
      )
    )
      problem(400, "invalid_member_update", "每次只能更改一项员工资料。");
    requireDataportAccess(
      principal,
      tenantId,
      body.roleId
        ? "members.assign"
        : body.status
          ? "members.disable"
          : "members.update",
    );
    if (!uuid(memberId)) problem(400, "invalid_member", "请选择成员。");
    return withPgTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-members:${tenantId}`,
      ]);
      const target = (
        await db.query(
          "SELECT * FROM iam.tenant_memberships WHERE tenant_id=$1 AND member_id=$2 FOR UPDATE",
          [tenantId, memberId],
        )
      ).rows[0];
      if (!target || target.role === "owner" || memberId === principal.memberId)
        problem(
          403,
          "member_protected",
          "不能通过此操作修改超管或自己的权限。",
        );
      const currentAssignment = (
        await db.query(
          "SELECT role_id FROM dataport.member_roles WHERE tenant_id=$1 AND member_id=$2",
          [tenantId, memberId],
        )
      ).rows[0];
      const currentRole = currentAssignment
        ? await this.role(tenantId, currentAssignment.role_id, db)
        : null;
      const actorPermissions =
        requireDataportAccess(principal, tenantId).dataport?.permissions || [];
      if (
        !isOwner(principal, tenantId) &&
        (!currentRole ||
          currentRole.permissions.some((p) => !actorPermissions.includes(p)))
      )
        problem(403, "member_protected", "无权管理此成员。");
      if (body.roleId) {
        if (body.roleId === "owner")
          problem(403, "owner_protected", "不能通过角色分配变更企业超管。");
        const role = await this.role(tenantId, body.roleId, db);
        if (!role) problem(404, "role_not_found", "角色不存在。");
        const own =
          requireDataportAccess(principal, tenantId).dataport?.permissions ||
          [];
        if (
          !isOwner(principal, tenantId) &&
          role.permissions.some((p) => !own.includes(p))
        )
          problem(
            403,
            "role_exceeds_authority",
            "不能分配超出自身权限的角色。",
          );
        await db.query(
          `INSERT INTO dataport.member_roles(tenant_id,member_id,role_id) VALUES($1,$2,$3)
          ON CONFLICT(tenant_id,member_id) DO UPDATE SET role_id=excluded.role_id,revision=dataport.member_roles.revision+1`,
          [tenantId, memberId, body.roleId],
        );
      } else if (body.status) {
        if (!["active", "suspended"].includes(body.status))
          problem(400, "invalid_status", "账号状态不正确。");
        const assignment = (
          await db.query(
            "SELECT role_id FROM dataport.member_roles WHERE tenant_id=$1 AND member_id=$2",
            [tenantId, memberId],
          )
        ).rows[0];
        const targetRole = assignment
          ? await this.role(tenantId, assignment.role_id, db)
          : null;
        const own =
          requireDataportAccess(principal, tenantId).dataport?.permissions ||
          [];
        if (
          !isOwner(principal, tenantId) &&
          (!targetRole || targetRole.permissions.some((p) => !own.includes(p)))
        )
          problem(403, "member_protected", "无权管理此成员。");
        await db.query(
          "UPDATE iam.tenant_memberships SET status=$3,updated_at=now() WHERE tenant_id=$1 AND member_id=$2",
          [tenantId, memberId, body.status],
        );
        if (body.status === "suspended")
          await db.query(`DELETE FROM dataport.local_sessions s USING dataport.local_credentials c
            WHERE s.member_id=c.member_id AND c.tenant_id=$1 AND s.member_id=$2`, [tenantId, memberId]);
      } else if (
        typeof body.displayName === "string" &&
        body.displayName.trim() &&
        body.displayName.trim().length <= 80
      ) {
        await db.query(
          "INSERT INTO dataport.member_profiles(tenant_id,member_id,display_name) VALUES($1,$2,$3) ON CONFLICT(tenant_id,member_id) DO UPDATE SET display_name=excluded.display_name",
          [tenantId, memberId, body.displayName.trim()],
        );
      } else
        problem(
          400,
          "invalid_member_update",
          "请填写企业显示名称或选择角色和账号状态。",
        );
      await this.event(
        tenantId,
        principal.memberId,
        "member.updated",
        memberId,
        200,
        {
          roleId: body.roleId,
          status: body.status,
          displayName: body.displayName,
        },
        db,
      );
      return { updated: true };
    });
  }
  async tickets(principal, tenantId, search) {
    const membership = requireDataportAccess(principal, tenantId);
    const permissions =
      membership.dataport?.permissions || legacyPermissions(membership);
    if (
      !permissions.some((p) =>
        ["support.read.self", "support.read.tenant"].includes(p),
      )
    )
      problem(403, "insufficient_permission", "无权查看工单。");
    const { page, pageSize, offset } = paging(search),
      q = text(search.get("q")),
      category = text(search.get("category"), 30),
      status = text(search.get("status"), 30);
    if (
      !["", "saved", "processing", "closed"].includes(status) ||
      !["", "purchase", "technical", "account", "other"].includes(category)
    )
      problem(400, "invalid_ticket_filter", "工单筛选条件无效。");
    const args = [
      tenantId,
      permissions.includes("support.read.tenant") ? null : principal.memberId,
      q,
      category,
      status,
    ];
    const where =
      "tenant_id=$1 AND ($2::uuid IS NULL OR actor=$2) AND ($3='' OR position(lower($3) in lower(content||' '||id::text))>0) AND ($4='' OR category=$4) AND ($5='' OR status=$5)";
    const total = (
      await this.pool.query(
        `SELECT count(*)::int AS total FROM dataport.tickets WHERE ${where}`,
        args,
      )
    ).rows[0].total;
    const items = (
      await this.pool.query(
        `SELECT * FROM dataport.tickets WHERE ${where} ORDER BY created_at DESC,id LIMIT $6 OFFSET $7`,
        [...args, pageSize, offset],
      )
    ).rows;
    return { items, total, page, pageSize };
  }
  async createTicket(principal, tenantId, body) {
    requireDataportAccess(principal, tenantId, "support.create");
    if (
      Object.keys(body).some(
        (k) => !["content", "contact", "category", "priority"].includes(k),
      ) ||
      typeof body.content !== "string" ||
      body.content.trim().length > 5000 ||
      (body.contact !== undefined &&
        (typeof body.contact !== "string" || body.contact.length > 200))
    )
      problem(
        400,
        "invalid_ticket",
        "问题描述最多 5000 字，联系方式最多 200 字。",
      );
    const content = text(body.content, 5000),
      contact = text(body.contact, 200),
      category = body.category || "technical",
      priority = body.priority || "normal";
    if (
      !content ||
      !["purchase", "technical", "account", "other"].includes(category) ||
      !["normal", "urgent"].includes(priority)
    )
      problem(400, "invalid_ticket", "请填写问题内容并选择分类。");
    return withPgTransaction(this.pool, async (db) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO dataport.tickets(id,tenant_id,actor,content,contact,category,priority) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          tenantId,
          principal.memberId,
          content,
          contact,
          category,
          priority,
        ],
      );
      await this.event(
        tenantId,
        principal.memberId,
        "ticket.created",
        id,
        201,
        {},
        db,
      );
      return { id, status: "saved" };
    });
  }
  async audit(principal, tenantId, search) {
    requireDataportAccess(principal, tenantId, "audit.read");
    const { page, pageSize, offset } = paging(search),
      q = text(search.get("q")),
      actor = text(search.get("actor")),
      action = text(search.get("action")),
      status = search.get("status") || "",
      from = search.get("from") || null,
      to = search.get("to") || null;
    if (
      !["", "success", "failure"].includes(status) ||
      [from, to].some(
        (v) =>
          v &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v))),
      )
    )
      problem(400, "invalid_audit_filter", "日志筛选条件无效。");
    // Old events retained only the Portal request ID. Join their tenant-bound
    // query receipt for tracing without rewriting immutable historical events.
    const queryRequestId =
        "coalesce(e.detail->>'queryRequestId',qr.payload#>>'{response,requestId}',qr.payload->>'requestId','')",
      batchId = "coalesce(e.detail->>'batchId',qr.payload->>'batchId','')",
      source = `dataport.events e LEFT JOIN iam.members m ON m.id=e.actor
        LEFT JOIN dataport.member_profiles mp ON mp.tenant_id=e.tenant_id AND mp.member_id=e.actor
        LEFT JOIN dataport.managed_accounts ma ON ma.tenant_id=e.tenant_id AND ma.member_id=e.actor
        LEFT JOIN dataport.queries qr ON e.action='query.executed' AND qr.tenant_id=e.tenant_id
          AND qr.id=CASE WHEN e.target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN e.target::uuid END`,
      // Interpret date-only bounds in the same Beijing timezone as the UI.
      args = [tenantId, q, actor, action, status, from, to],
      where = `e.tenant_id=$1 AND ($2='' OR position(lower($2) in lower(e.target||' '||coalesce(mp.display_name,m.display_name,'')||' '||coalesce(ma.account,'')||' '||coalesce(e.detail->>'requestId','')||' '||coalesce(e.detail->>'ip','')||' '||${queryRequestId}||' '||${batchId}))>0) AND ($3='' OR e.actor::text=$3) AND ($4='' OR e.action=$4) AND ($5='' OR ($5='success' AND e.status<400) OR ($5='failure' AND e.status>=400)) AND ($6::date IS NULL OR e.created_at >= ($6::date::timestamp AT TIME ZONE 'Asia/Shanghai')) AND ($7::date IS NULL OR e.created_at < (($7::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))`;
    const total = (
      await this.pool.query(
        `SELECT count(*)::int AS total FROM ${source} WHERE ${where}`,
        args,
      )
    ).rows[0].total;
    const items = (
      await this.pool.query(
        `SELECT e.*,e.detail || jsonb_strip_nulls(jsonb_build_object(
          'queryRequestId',nullif(${queryRequestId},''),'queryId',qr.id,'batchId',nullif(${batchId},'')
        )) AS detail,coalesce(mp.display_name,m.display_name) AS "actorName",ma.account AS "actorAccount"
        FROM ${source} WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT $8 OFFSET $9`,
        [...args, pageSize, offset],
      )
    ).rows;
    return { items, total, page, pageSize };
  }
  async memberCommand(principal, tenantId, body, accounts, audience) {
    requireDataportAccess(principal, tenantId, "members.create");
    const { operation, account, displayName, roleId, commandId } = body;
    if (
      Object.keys(body).some(
        (k) =>
          ![
            "operation",
            "account",
            "displayName",
            "roleId",
            "commandId",
          ].includes(k),
      )
    )
      problem(400, "invalid_member_command", "账号操作参数无效。");
    if (
      !uuid(commandId) ||
      !["create", "invite"].includes(operation) ||
      typeof account !== "string" ||
      typeof roleId !== "string"
    )
      problem(400, "invalid_member_command", "请填写账号和角色。");
    const role = await this.role(tenantId, roleId),
      own =
        requireDataportAccess(principal, tenantId).dataport?.permissions || [];
    if (
      !role ||
      roleId === "owner" ||
      (!isOwner(principal, tenantId) &&
        role.permissions.some((p) => !own.includes(p)))
    )
      problem(403, "role_exceeds_authority", "不能分配此角色。");
    const fingerprint = digest(
      JSON.stringify({ operation, account, displayName, roleId }),
    );
    if (operation === "create")
      return this.localAccounts.create(principal, tenantId, body);
    await this.pool.query(
      `INSERT INTO dataport.member_commands(id,tenant_id,actor,operation,fingerprint,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        commandId,
        tenantId,
        principal.memberId,
        operation,
        fingerprint,
        { roleId },
      ],
    );
    const command = (
      await this.pool.query(
        "SELECT * FROM dataport.member_commands WHERE id=$1",
        [commandId],
      )
    ).rows[0];
    if (
      command.tenant_id !== tenantId ||
      command.actor !== principal.memberId ||
      command.fingerprint !== fingerprint
    )
      problem(409, "member_command_conflict", "操作编号已被使用。");
    const identity = await accounts.execute({
      operation,
      requestId: commandId,
      tenantId,
      actor: principal.memberId,
      account,
      displayName,
    });
    return withPgTransaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-command:${commandId}`,
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-members:${tenantId}`,
      ]);
      const fresh = await this.enrich(principal, principal.dataportSession),
        freshPermissions = requireDataportAccess(
          fresh,
          tenantId,
          "members.create",
        ).dataport.permissions,
        currentRole = await this.role(tenantId, roleId, db);
      if (!currentRole)
        problem(409, "role_unavailable", "角色已归档，请重新选择角色。");
      if (
        !isOwner(fresh, tenantId) &&
        currentRole.permissions.some((p) => !freshPermissions.includes(p))
      )
        problem(403, "role_exceeds_authority", "角色权限已改变，请重新选择。");
      if (operation === "invite") {
        const token = accounts.invitation(commandId, tenantId);
        await db.query(
          `INSERT INTO dataport.joins(digest,tenant_id,role_id,requested_by,account,issuer,subject,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '24 hours') ON CONFLICT DO NOTHING`,
          [
            digest(token),
            tenantId,
            roleId,
            principal.memberId,
            identity.account,
            identity.issuer,
            identity.subject,
          ],
        );
        const join = (
          await db.query(
            "SELECT expires_at,consumed_by FROM dataport.joins WHERE digest=$1",
            [digest(token)],
          )
        ).rows[0];
        await db.query(
          "UPDATE dataport.member_commands SET state='completed' WHERE id=$1",
          [commandId],
        );
        await this.event(
          tenantId,
          principal.memberId,
          "member.invited",
          identity.userId,
          200,
          { roleId },
          db,
        );
        return {
          joinToken: token,
          expiresAt: join.expires_at,
          consumed: !!join.consumed_by,
        };
      }
    });
  }
  async bindManaged(db, tenantId, identity, audience, roleId, actor, managed) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      identityLock(identity.issuer, identity.subject, audience),
    ]);
    let memberId = (
      await db.query(
        "SELECT member_id FROM iam.external_identity_bindings WHERE issuer=$1 AND subject=$2 AND audience=$3",
        [identity.issuer, identity.subject, audience],
      )
    ).rows[0]?.member_id;
    if (!memberId) {
      memberId = randomUUID();
      await db.query("INSERT INTO iam.members(id,display_name) VALUES($1,$2)", [
        memberId,
        identity.displayName,
      ]);
      await db.query(
        "INSERT INTO iam.external_identity_bindings(id,member_id,issuer,subject,audience) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), memberId, identity.issuer, identity.subject, audience],
      );
    }
    // Never silently reactivate or replace an existing enterprise membership.
    const existing = await db.query(
      "SELECT 1 FROM iam.tenant_memberships WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, memberId],
    );
    if (!existing.rowCount) {
      await db.query(
        "INSERT INTO iam.tenant_memberships(id,tenant_id,member_id,role,granted_by) VALUES($1,$2,$3,'viewer',$4)",
        [randomUUID(), tenantId, memberId, actor],
      );
      await db.query(
        "INSERT INTO dataport.member_roles(tenant_id,member_id,role_id) VALUES($1,$2,$3)",
        [tenantId, memberId, roleId],
      );
    }
    await db.query(
      "INSERT INTO dataport.managed_accounts(tenant_id,member_id,user_id,account,managed) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [tenantId, memberId, identity.userId, identity.account, managed],
    );
    return memberId;
  }
  async join(principal, token, confirm, audience) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      problem(404, "join_not_found", "邀请不存在。");
    return withPgTransaction(this.pool, async (db) => {
      const join = (
        await db.query(
          "SELECT j.*,t.name FROM dataport.joins j JOIN tenants t ON t.id=j.tenant_id WHERE digest=$1 FOR UPDATE OF j",
          [digest(token)],
        )
      ).rows[0];
      if (!join || new Date(join.expires_at) <= new Date())
        problem(410, "join_expired", "邀请已失效，请联系企业超管。");
      if (
        join.subject !== principal.subject ||
        join.issuer !== principal.issuer
      )
        problem(403, "join_account_mismatch", "请使用邀请指定的 MX 账号登录。");
      if (join.consumed_by && join.consumed_by !== principal.memberId)
        problem(409, "join_consumed", "邀请已使用。");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dataport-members:${join.tenant_id}`,
      ]);
      const creator = (
        await db.query(
          "SELECT tm.role,a.role_id,m.status AS member_status,t.status AS tenant_status FROM iam.tenant_memberships tm JOIN iam.members m ON m.id=tm.member_id JOIN tenants t ON t.id=tm.tenant_id LEFT JOIN dataport.member_roles a ON a.tenant_id=tm.tenant_id AND a.member_id=tm.member_id WHERE tm.tenant_id=$1 AND tm.member_id=$2 AND tm.status='active'",
          [join.tenant_id, join.requested_by],
        )
      ).rows[0];
      const targetRole = await this.role(join.tenant_id, join.role_id, db),
        creatorRole =
          creator?.role === "owner"
            ? BUILTIN_ROLES[0]
            : creator?.role_id
              ? await this.role(join.tenant_id, creator.role_id, db)
              : null;
      if (
        !creator ||
        creator.member_status !== "active" ||
        creator.tenant_status !== "active" ||
        !targetRole ||
        !creatorRole?.permissions.includes("members.create") ||
        targetRole.permissions.some((p) => !creatorRole.permissions.includes(p))
      )
        problem(410, "join_revoked", "邀请已撤销。");
      if (!confirm)
        return {
          tenantName: join.name,
          account: join.account,
          roleId: join.role_id,
          expiresAt: join.expires_at,
          consumed: !!join.consumed_by,
        };
      if (!join.consumed_by) {
        await this.bindManaged(
          db,
          join.tenant_id,
          {
            issuer: principal.issuer,
            subject: principal.subject,
            userId: principal.subject.replace(/^user:/, ""),
            account: join.account,
            displayName: principal.displayName,
          },
          audience,
          join.role_id,
          join.requested_by,
          false,
        );
        await db.query(
          "UPDATE dataport.joins SET consumed_by=$2 WHERE digest=$1",
          [digest(token), principal.memberId],
        );
        await this.event(
          join.tenant_id,
          principal.memberId,
          "member.joined",
          principal.memberId,
          200,
          { roleId: join.role_id },
          db,
        );
      }
      return { joined: true, tenantId: join.tenant_id };
    });
  }
  async renameEnterprise(principal, tenantId, body) {
    requireOwner(principal, tenantId);
    if (
      Object.keys(body).length !== 1 ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.trim().length > 80
    )
      problem(400, "invalid_enterprise_name", "企业名称需为 1–80 个字符。");
    return withPgTransaction(this.pool, async (db) => {
      const result = await db.query(
        "UPDATE tenants SET name=$2,updated_at=now() WHERE id=$1 AND status='active' RETURNING name",
        [tenantId, body.name.trim()],
      );
      if (!result.rowCount) problem(404, "tenant_not_found", "企业不存在。");
      await this.event(
        tenantId,
        principal.memberId,
        "enterprise.renamed",
        tenantId,
        200,
        {},
        db,
      );
      return result.rows[0];
    });
  }
  async resetPassword(principal, tenantId, memberId, body, accounts) {
    requireOwner(principal, tenantId);
    if (
      !uuid(memberId) ||
      !uuid(body.commandId) ||
      Object.keys(body).length !== 1
    )
      problem(400, "invalid_password_reset", "密码重置操作编号无效。");
    return this.localAccounts.reset(principal, tenantId, memberId, body.commandId);
  }
  async initialPassword(principal, tenantId, memberId, accounts) {
    return this.localAccounts.initial(principal, tenantId, memberId);
  }
  async query(principal, tenantId, body, intent, execute) {
    requireDataportAccess(
      principal,
      tenantId,
      body?.batch ? "query.batch" : "query.execute",
    );
    if (
      !body ||
      Object.keys(body).some((k) => !["ip", "batch"].includes(k)) ||
      (body.batch !== undefined && typeof body.batch !== "boolean") ||
      typeof body.ip !== "string" ||
      !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(body.ip) ||
      body.ip.split(".").some((v) => Number(v) > 255) ||
      !uuid(intent)
    )
      problem(400, "invalid_query", "请填写 IPv4 地址并提供查询操作编号。");
    const fingerprint = digest(body.ip),
      id = randomUUID();
    const claimed = await this.pool.query(
      `INSERT INTO dataport.queries(id,tenant_id,actor,intent_key,fingerprint,ip) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [id, tenantId, principal.memberId, intent, fingerprint, body.ip],
    );
    if (!claimed.rowCount) {
      const existing = (
        await this.pool.query(
          "SELECT * FROM dataport.queries WHERE tenant_id=$1 AND actor=$2 AND intent_key=$3",
          [tenantId, principal.memberId, intent],
        )
      ).rows[0];
      if (existing.fingerprint !== fingerprint)
        problem(409, "query_intent_conflict", "操作编号对应其他 IP。");
      if (!existing.payload) {
        const batch = (
          await this.pool.query(
            "SELECT response FROM external_platform.ipsearch_batches WHERE tenant_id=$1 AND idempotency_key=$2 AND response IS NOT NULL",
            [tenantId, `dataport-${existing.id}`],
          )
        ).rows[0];
        if (batch?.response?.data?.[0]) {
          existing.payload = {
            ...batch.response.data[0],
            batchId: batch.response.batchId,
          };
          await this.pool.query(
            "UPDATE dataport.queries SET payload=$2,status=$3 WHERE id=$1",
            [existing.id, existing.payload, existing.payload.status],
          );
        }
      }
      if (!existing.payload)
        problem(
          409,
          "query_outcome_unknown",
          "上次查询结果尚未确认，请稍后查看历史；请勿重复提交付费查询。",
        );
      return { ...existing.payload, id: existing.id, replayed: true };
    }
    let payload, status;
    try {
      const result = await execute(`dataport-${id}`);
      const item = result.body?.data?.[0];
      status = item?.status || result.status;
      payload = item
        ? { ...item, batchId: result.body.batchId }
        : {
            ip: body.ip,
            status,
            error: {
              message:
                "查询未返回有效结果，请查看账单和历史后再决定是否重新查询。",
            },
          };
    } catch (error) {
      status =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 503;
      payload = {
        ip: body.ip,
        status,
        error: {
          code:
            typeof error.code === "string" &&
            /^[a-z][a-z0-9_]{1,80}$/.test(error.code)
              ? error.code
              : "query_outcome_unknown",
          message:
            status < 500
              ? error.message
              : "查询服务暂不可用，结果未确认，请查看历史后再决定是否重试。",
        },
      };
    }
    await this.pool.query(
      "UPDATE dataport.queries SET status=$2,payload=$3 WHERE id=$1",
      [id, status, payload],
    );
    await this.event(
      tenantId,
      principal.memberId,
      "query.executed",
      id,
      status,
      {
        ip: body.ip,
        queryId: id,
        queryRequestId:
          text(payload.response?.requestId || payload.requestId, 128) ||
          undefined,
        batchId: text(payload.batchId, 128) || undefined,
      },
    );
    return { ...payload, id };
  }
  async history(principal, tenantId, search) {
    requireDataportAccess(
      principal,
      tenantId,
      search.get("export") === "1" ? "history.export" : "history.read",
    );
    const { page, pageSize, offset } = paging(search, 5),
      q = text(search.get("q"), 128);
    const source = `WITH history AS (
      SELECT q.id::text,q.ip::text,q.actor,q.status,coalesce(q.payload,CASE WHEN b.response IS NOT NULL THEN b.response->'data'->0||jsonb_build_object('batchId',b.id) END) AS payload,q.created_at
        FROM dataport.queries q LEFT JOIN external_platform.ipsearch_batches b ON b.tenant_id=q.tenant_id AND b.idempotency_key='dataport-'||q.id::text WHERE q.tenant_id=$1
      UNION ALL SELECT b.id::text||':'||e.n,e.item->>'ip',NULL::uuid,(e.item->>'status')::int,e.item||jsonb_build_object('batchId',b.id),b.created_at
        FROM external_platform.ipsearch_batches b CROSS JOIN LATERAL jsonb_array_elements(b.response->'data') WITH ORDINALITY e(item,n)
        WHERE b.tenant_id=$1 AND b.response->>'contractVersion'='mx-insight-hub.ip-risk.subscription.v1'
        AND NOT EXISTS(SELECT 1 FROM dataport.queries q WHERE q.tenant_id=$1 AND b.idempotency_key='dataport-'||q.id::text)
    )`,
      where = "($2='' OR ip LIKE '%'||$2||'%')";
    const total = (
      await this.pool.query(
        `${source} SELECT count(*)::int AS total FROM history WHERE ${where}`,
        [tenantId, q],
      )
    ).rows[0].total;
    const items = (
      await this.pool.query(
        `${source} SELECT id,split_part(ip,'/',1) AS ip,actor,status,payload,created_at AS "createdAt" FROM history WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
        [tenantId, q, pageSize, offset],
      )
    ).rows;
    return { items, total, page, pageSize };
  }
}
