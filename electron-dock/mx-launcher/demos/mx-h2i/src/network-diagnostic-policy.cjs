'use strict';

const rows = (value) => Array.isArray(value) ? value : [];
const LEGACY_LUOPAN_HDO_OWNER = 'MX HDO / QPJoy HDO hdo-client';
const sameServers = (left, right) => {
  const a = [...new Set(rows(left))].sort();
  const b = [...new Set(rows(right))].sort();
  return a.length > 0 && a.length === b.length && a.every((value, index) => value === b[index]);
};

function windowsNrptOwnershipConflictMessage(status) {
  const conflicts = rows(status?.namespaces).filter((entry) =>
    rows(entry.conflictingRules).length > 0
    // Older installed core packages only expose the owner names. Do not claim
    // that a foreign owner caused an incorrectly installed owned rule.
    || (entry.ready === false && entry.ownedRuleCount > 0
      && !entry.legacyAmbiguousRuleCount
      && rows(entry.foreignOwners).length > 0
      && sameServers(entry.expectedNameServers, entry.installedNameServers))
  );
  if (conflicts.length === 0) return null;
  const detail = conflicts.map((entry) => {
    const foreign = rows(entry.conflictingRules).length > 0
      ? entry.conflictingRules.map((rule) => `${rule.owner} → ${rows(rule.nameServers).join(', ')}`).join('；')
      : rows(entry.foreignOwners).join(', ');
    return `${entry.namespace}（MX-H2I → ${rows(entry.expectedNameServers).join(', ')}；其他规则：${foreign}）`;
  }).join('；');
  return `Windows split DNS 存在同域规则冲突：${detail}。MX-H2I 不会自动删除其他产品的规则；请先协调这些域名的归属。重复“修复网络”不会消除其他产品的冲突规则。`;
}

function hasLegacyLuopanHdoConflict(status) {
  return rows(status?.namespaces).some(entry =>
    ['mxinfo-inc.cn', '.mxinfo-inc.cn'].includes(entry.namespace)
    && entry.ownedRuleCount > 0
    && sameServers(entry.installedNameServers, ['10.88.0.1'])
    && rows(entry.conflictingRules).some(rule =>
      rule.owner === LEGACY_LUOPAN_HDO_OWNER && sameServers(rule.nameServers, ['100.88.0.1'])
    )
  );
}

function networkDiagnosticsProblem({ phase, resolution, windowsNrpt }) {
  const conflict = windowsNrptOwnershipConflictMessage(windowsNrpt);
  if (resolution?.severity === 'error' || (resolution?.severity === 'warning' && resolution.ok === false)) {
    const message = resolution.message || '网络解析诊断失败。';
    return { level: resolution.severity, message: conflict && !message.includes(conflict) ? `${message} ${conflict}` : message };
  }
  if (windowsNrpt?.state === 'probe-failed') {
    return { level: 'warning', message: `Windows NRPT 实时状态读取失败，尚无法确认规则或清理状态${windowsNrpt.error ? `：${windowsNrpt.error}` : '。'}` };
  }
  if (phase === 'disconnected') {
    // Missing MX rules are expected after disconnect. Only report MX-owned
    // cleanup residue; another product's retained rules are not our residue.
    if (windowsNrpt?.totalOwnedRuleCount > 0 || windowsNrpt?.globalRestorePending === true
      || windowsNrpt?.legacyAmbiguousRuleCount > 0) {
      return { level: 'warning', message: 'MX-H2I 已断开，但本产品的 Windows NRPT 清理尚未确认完成；请刷新诊断检查残留规则。' };
    }
    return null;
  }
  if (windowsNrpt?.ready === false && (phase === 'connected' || windowsNrpt.totalOwnedRuleCount > 0)) {
    return {
      level: 'warning',
      message: conflict || `Windows split DNS 未就绪（${windowsNrpt.state || 'unknown'}）${windowsNrpt.error ? `：${windowsNrpt.error}` : '。'}`
    };
  }
  return null;
}

module.exports = { networkDiagnosticsProblem, windowsNrptOwnershipConflictMessage, hasLegacyLuopanHdoConflict };
