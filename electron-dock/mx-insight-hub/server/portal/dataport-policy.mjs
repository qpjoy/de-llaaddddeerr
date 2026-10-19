import { AppError } from "../core/errors.mjs";

export const PERMISSIONS = Object.freeze({
  "query.execute": "执行查询",
  "query.batch": "批量查询",
  "history.read": "查看企业历史",
  "history.export": "导出结果",
  "usage.read": "查看用量",
  "keys.read": "查看 API Keys",
  "keys.create": "签发 API Key",
  "keys.revoke": "撤销 API Key",
  "subscriptions.read": "查看订阅",
  "subscriptions.buy": "购买、续订和升级",
  "billing.read": "查看账单",
  "billing.export": "导出账单",
  "invoice.request": "申请发票",
  "docs.read": "查看接口文档",
  "members.read": "查看成员",
  "members.create": "创建或关联员工",
  "members.update": "编辑员工",
  "members.disable": "启停员工",
  "members.assign": "分配角色",
  "audit.read": "查看审计日志",
  "audit.export": "导出审计日志",
  "support.create": "提交工单",
  "support.read.self": "查看本人工单",
  "support.read.tenant": "查看企业工单",
});
const work = [
  "query.execute",
  "query.batch",
  "history.read",
  "history.export",
  "usage.read",
  "docs.read",
  "support.create",
  "support.read.self",
];
export const BUILTIN_ROLES = Object.freeze([
  {
    id: "owner",
    name: "企业超管",
    permissions: Object.keys(PERMISSIONS),
    builtin: true,
  },
  {
    id: "admin",
    name: "企业管理员",
    permissions: [
      ...work,
      "keys.read",
      "keys.create",
      "keys.revoke",
      "subscriptions.read",
      "members.read",
      "members.update",
      "members.disable",
      "members.assign",
      "support.read.tenant",
    ],
    builtin: true,
  },
  { id: "analyst", name: "分析员", permissions: work, builtin: true },
  {
    id: "billing",
    name: "财务",
    permissions: [
      "usage.read",
      "subscriptions.read",
      "subscriptions.buy",
      "billing.read",
      "billing.export",
      "invoice.request",
      "support.create",
      "support.read.self",
    ],
    builtin: true,
  },
  {
    id: "viewer",
    name: "只读成员",
    permissions: [
      "history.read",
      "usage.read",
      "docs.read",
      "support.create",
      "support.read.self",
    ],
    builtin: true,
  },
]);
export function validatePermissions(value) {
  if (
    !Array.isArray(value) ||
    value.some((p) => typeof p !== "string" || !Object.hasOwn(PERMISSIONS, p))
  )
    throw new AppError(400, "invalid_permissions", "请选择有效的权限。");
  const result = [...new Set(value)];
  const dependencies = {
    "query.batch": "query.execute",
    "history.export": "history.read",
    "keys.create": "keys.read",
    "keys.revoke": "keys.read",
    "billing.export": "billing.read",
    "invoice.request": "billing.read",
    "subscriptions.buy": "subscriptions.read",
    "members.update": "members.read",
    "members.disable": "members.read",
    "members.assign": "members.read",
    "members.create": "members.read",
    "audit.export": "audit.read",
  };
  for (const [operation, read] of Object.entries(dependencies))
    if (result.includes(operation) && !result.includes(read)) result.push(read);
  return result.sort();
}
// Legacy Hub roles are preserved until an explicit DataPort role is assigned.
export function legacyPermissions(membership) {
  if (membership.role === "owner") return [...BUILTIN_ROLES[0].permissions];
  const c = membership.capabilities || [],
    p = ["support.create", "support.read.self"];
  if (c.includes("usage.read")) p.push("usage.read");
  if (c.includes("consumer.read")) p.push("docs.read");
  if (c.includes("apikey.read")) p.push("keys.read");
  if (c.includes("apikey.write")) p.push("keys.create", "keys.revoke");
  if (c.includes("billing.read"))
    p.push("subscriptions.read", "billing.read", "billing.export");
  if (
    c.includes("billing.read") &&
    c.includes("recharge.create") &&
    c.includes("apikey.write")
  )
    p.push("subscriptions.buy");
  if (c.includes("invoice.request")) p.push("invoice.request");
  if (c.includes("billing.read") && c.includes("apikey.write"))
    p.push("query.execute", "query.batch", "history.read", "history.export");
  return p;
}
export function requireDataportAccess(principal, tenantId, permission) {
  const membership = principal.memberships?.find(
    (m) => m.tenantId === tenantId && m.status !== "suspended",
  );
  if (!membership)
    throw new AppError(403, "tenant_not_permitted", "无权访问此企业。");
  const permissions =
    membership.dataport?.permissions || legacyPermissions(membership);
  if (permission && !permissions.includes(permission))
    throw new AppError(
      403,
      "insufficient_permission",
      "你没有执行此操作的权限。",
    );
  return membership;
}
export const isOwner = (principal, tenantId) =>
  principal.memberships?.some(
    (m) => m.tenantId === tenantId && m.role === "owner",
  ) === true;
export function requireOwner(principal, tenantId) {
  requireDataportAccess(principal, tenantId);
  if (!isOwner(principal, tenantId))
    throw new AppError(403, "owner_required", "仅企业超管可以执行此操作。");
}
