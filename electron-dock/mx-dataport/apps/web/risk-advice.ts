export function riskBand(level: unknown) {
  const value = String(level ?? "")
    .trim()
    .toLowerCase();
  if (["high", "高", "高风险"].includes(value)) return "high";
  if (["medium", "中", "中风险"].includes(value)) return "medium";
  if (["low", "低", "低风险"].includes(value)) return "low";
  return "unknown";
}
export function riskAdvice(level: unknown) {
  if (riskBand(level) === "high")
    return "该 IP 存在较高风险线索。建议结合业务日志核验，并按业务策略增加验证、限制访问或临时封禁。";
  if (riskBand(level) === "medium")
    return "该 IP 存在风险线索。建议复核请求行为与业务日志，按业务策略增加验证或限制频率。";
  if (riskBand(level) === "low")
    return "当前未显示明显高风险线索，建议持续观察业务日志。低风险不代表绝对安全。";
  return "未提供可判断的风险等级，建议结合业务日志和其他证据进一步核验。";
}
