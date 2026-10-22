export function keyCreationFailure(error: unknown) {
  const failure = error as { message?: string; status?: number; code?: string };
  const status = failure?.status;
  const unconfirmed = failure?.code === "invalid_response" ||
    status == null || status === 0 || status === 408 || status >= 500;
  const message = failure?.message || "签发 API Key 失败。";
  return {
    unconfirmed,
    message: unconfirmed
      ? `${message} 请先关闭弹窗并核对 Key 列表，确认上次创建结果，勿直接重复签发。`
      : failure?.code === "subscription_required"
        ? "请先在“我的订阅”领取试用或开通 IP 风险画像套餐，开通后再签发 API Key。"
        : message,
  };
}
