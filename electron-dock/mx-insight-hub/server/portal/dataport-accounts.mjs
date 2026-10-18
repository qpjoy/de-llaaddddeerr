import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { AppError } from "../core/errors.mjs";

// A dedicated Auth credential, never the platform operator token. Lazy reads
// allow independent secret provisioning without disabling existing Hub login.
export class DataportAccountsClient {
  config() {
    try {
      const origin = new URL(process.env.MX_DATAPORT_ACCOUNT_ORIGIN);
      const internal =
        /^(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/.test(
          origin.hostname,
        ) ||
        origin.hostname.endsWith(".svc.cluster.local") ||
        origin.hostname.endsWith(".svc");
      if (
        origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && internal)
      )
        throw Error();
      if (
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
      )
        throw Error();
      const token = readFileSync(
        process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE,
        "utf8",
      ).trim();
      if (token.length < 32) throw Error();
      return { origin: origin.origin, token };
    } catch {
      throw new AppError(
        503,
        "dataport_accounts_not_configured",
        "员工账号服务尚未配置。",
      );
    }
  }
  invitation(commandId, tenantId) {
    return createHmac("sha256", this.config().token)
      .update(`dataport-join:${tenantId}:${commandId}`)
      .digest("base64url");
  }
  async execute(input) {
    const { origin, token } = this.config();
    let response, value;
    try {
      response = await fetch(`${origin}/internal/v1/dataport/accounts`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: {
          "content-type": "application/json",
          "x-mx-dataport-account": token,
        },
        body: JSON.stringify(input),
      });
      value = await response.json();
    } catch {
      throw new AppError(
        503,
        "dataport_accounts_unconfirmed",
        "账号操作结果暂未确认，请使用原操作编号重试。",
      );
    }
    if (!response.ok)
      throw new AppError(
        response.status,
        value.code || "dataport_account_error",
        value.message || "账号操作失败。",
      );
    return value;
  }
}
