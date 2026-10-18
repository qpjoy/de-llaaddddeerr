import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Body,
  Controller,
  Header,
  Headers,
  HttpException,
  Inject,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import { RUNTIME_CONFIG } from "../tokens.js";
import type {
  RuntimeConfig,
  UserCenterUser,
  UserCenterUserCredential,
} from "../types.js";
import {
  createUserCenterUser,
  createUserCenterUserCredential,
  userCredentialSummary,
  userMatchesLogin,
} from "../store/domain.js";
import { accountWriteLock, RegistrationError } from "./repository.js";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const credentialFingerprint = (credential: UserCenterUserCredential) =>
  hash(
    JSON.stringify([
      credential.userId,
      credential.kind,
      credential.passwordHash,
      credential.updatedAt,
    ]),
  );
const fail = (status: number, code: string, message: string): never => {
  throw new RegistrationError(status, code, message);
};
export interface DataportAccountCommand {
  operation: "create" | "invite" | "initial-password" | "reset-password";
  requestId: string;
  tenantId: string;
  actor: string;
  account?: string;
  displayName?: string;
  userId?: string;
}
interface ManagedPassword {
  tenantId: string;
  userId: string;
  fingerprint: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Dedicated DataPort account writer. It cannot change roles, other app grants,
 * passwords of existing MX accounts, networking, subscriptions or platform operator rights. */
export class DataportAccounts {
  private db: DataSource;
  private initializing?: Promise<DataSource>;
  constructor(
    url: string,
    private environment: string,
    private siteId: string,
    private key: Buffer,
  ) {
    if (key.length !== 32)
      throw Error("DataPort credential key must contain 32 bytes");
    this.db = new DataSource({
      type: "postgres",
      url,
      synchronize: false,
      extra: {
        max: 3,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10000,
      },
    });
  }
  private async ready() {
    return (this.initializing ??= this.db.initialize().catch((e) => {
      this.initializing = undefined;
      throw e;
    }));
  }
  async close() {
    if (this.initializing) await this.initializing;
    if (this.db.isInitialized) await this.db.destroy();
  }
  private async read<T>(
    db: EntityManager,
    kind: string,
    id: string,
  ): Promise<T | undefined> {
    return (
      await db.query(
        "SELECT data FROM mx_platform_records WHERE environment=$1 AND kind=$2 AND id=$3",
        [this.environment, kind, id],
      )
    )[0]?.data;
  }
  private async write(
    db: EntityManager,
    kind: string,
    id: string,
    data: unknown,
  ) {
    await db.query(
      `INSERT INTO mx_platform_records(environment,kind,id,site_id,data) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(environment,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()`,
      [this.environment, kind, id, this.siteId, data],
    );
  }
  async execute(input: DataportAccountCommand) {
    if (
      !input ||
      !["create", "invite", "initial-password", "reset-password"].includes(
        input.operation,
      ) ||
      !/^[0-9a-f-]{36}$/i.test(input.tenantId || "") ||
      !/^[0-9a-f-]{36}$/i.test(input.actor || "") ||
      !/^[0-9a-f-]{36}$/i.test(input.requestId || "") ||
      (input.displayName !== undefined &&
        (typeof input.displayName !== "string" ||
          !input.displayName.trim() ||
          input.displayName.trim().length > 80)) ||
      Object.keys(input).some(
        (k) =>
          ![
            "operation",
            "requestId",
            "tenantId",
            "actor",
            "account",
            "displayName",
            "userId",
          ].includes(k),
      )
    )
      fail(400, "invalid_dataport_command", "账号操作无效。");
    await this.ready();
    return this.db.transaction(async (db) => {
      await accountWriteLock(db, this.environment);
      const commandId = hash(input.tenantId + ":" + input.requestId),
        fingerprint = hash(
          JSON.stringify([
            input.operation,
            input.requestId,
            input.tenantId,
            input.actor,
            input.account ?? null,
            input.displayName ?? null,
            input.userId ?? null,
          ]),
        );
      const previous = await this.read<{ fingerprint: string; result: any }>(
        db,
        "dataport-account-command",
        commandId,
      );
      if (previous && previous.fingerprint !== fingerprint)
        fail(409, "account_command_conflict", "操作编号已被使用。");
      if (previous && input.operation !== "initial-password")
        return previous.result;
      let result: any;
      if (input.operation === "initial-password") {
        const managed = await this.read<ManagedPassword>(
          db,
          "dataport-managed-password",
          input.userId || "",
        );
        const credential = await this.read<UserCenterUserCredential>(
          db,
          "iam-user-credential",
          input.userId || "",
        );
        const user = await this.read<UserCenterUser>(
          db,
          "iam-user",
          input.userId || "",
        );
        if (
          !managed ||
          managed.tenantId !== input.tenantId ||
          user?.status !== "active"
        )
          fail(
            404,
            "initial_password_unavailable",
            "此账号没有可查看的初始密码。",
          );
        if (
          !credential ||
          managed!.fingerprint !== credentialFingerprint(credential)
        )
          fail(
            409,
            "initial_password_changed",
            "员工已修改密码，原始初始密码已失效。",
          );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.key,
          Buffer.from(managed!.iv, "base64"),
        );
        decipher.setAAD(Buffer.from(`${input.tenantId}:${input.userId}`));
        decipher.setAuthTag(Buffer.from(managed!.tag, "base64"));
        result = {
          password: Buffer.concat([
            decipher.update(Buffer.from(managed!.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        };
      } else if (input.operation === "reset-password") {
        const managed = await this.read<ManagedPassword>(
          db,
          "dataport-managed-password",
          input.userId || "",
        );
        const user = await this.read<UserCenterUser>(
          db,
          "iam-user",
          input.userId || "",
        );
        const old = await this.read<UserCenterUserCredential>(
          db,
          "iam-user-credential",
          input.userId || "",
        );
        if (
          !managed ||
          managed.tenantId !== input.tenantId ||
          !user ||
          user.status !== "active" ||
          !old ||
          user.appAccess.registeredByAppId !== "mx-harbor" ||
          !user.appAccess.allowedAppIds.includes("mx-harbor") ||
          user.appAccess.deniedAppIds.includes("mx-harbor") ||
          user.roleIds.some((r) => r !== "mx-user") ||
          user.appAccess.allowedAppIds.some((app) => app !== "mx-harbor")
        )
          fail(
            403,
            "managed_account_required",
            "仅可重置本企业托管的数港子账号，其他 MX 账号请使用统一找回。",
          );
        const password = randomBytes(18).toString("base64url"),
          now = new Date().toISOString();
        const credential = createUserCenterUserCredential(
          user!.userId,
          password,
          {
            requestedBy: `dataport:${input.actor}`,
            requestId: input.requestId,
          },
          old!,
          now,
        );
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from(`${input.tenantId}:${input.userId}`));
        const ciphertext = Buffer.concat([
          cipher.update(password, "utf8"),
          cipher.final(),
        ]);
        await this.write(db, "iam-user-credential", user!.userId, credential);
        await this.write(db, "iam-user", user!.userId, {
          ...user!,
          updatedAt: now,
          credential: userCredentialSummary(credential),
          webSessionsInvalidBefore: now,
        });
        await this.write(db, "dataport-managed-password", user!.userId, {
          tenantId: input.tenantId,
          userId: user!.userId,
          fingerprint: credentialFingerprint(credential),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        });
        await db.query(
          `UPDATE mx_platform_records SET data=jsonb_set(data,'{revokedAt}',to_jsonb($3::text)),updated_at=now()
          WHERE environment=$1 AND kind='iam-token' AND data->>'subjectKind'='user' AND data->>'subjectId'=$2 AND COALESCE(data->>'revokedAt','')=''`,
          [this.environment, user!.userId, now],
        );
        result = { reset: true };
        await this.write(db, "dataport-account-command", commandId, {
          fingerprint,
          result,
        });
      } else {
        const account = String(input.account || "").trim();
        if (!/^[A-Za-z][A-Za-z0-9_.@+-]{2,127}$/.test(account))
          fail(
            400,
            "invalid_account",
            "账号需为 3–128 位字母、数字或邮箱格式。",
          );
        const rows: Array<{ data: UserCenterUser }> = await db.query(
          "SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user'",
          [this.environment],
        );
        const matches = rows.filter((r) => userMatchesLogin(r.data, account));
        if (matches.length > 1)
          fail(409, "account_conflict", "账号存在冲突，请联系平台管理员。");
        let user = matches[0]?.data;
        if (input.operation === "create") {
          if (user)
            fail(409, "account_exists", "账号已存在，请使用关联已有账号。");
          const userId = `usr_${randomUUID()}`,
            password = randomBytes(18).toString("base64url");
          const credential = createUserCenterUserCredential(userId, password, {
            requestedBy: `dataport:${input.actor}`,
            requestId: input.requestId,
          });
          user = createUserCenterUser(
            {
              userId,
              account,
              displayName: String(input.displayName || account)
                .trim()
                .slice(0, 80),
              roleIds: ["mx-user"],
              appAccess: {
                homeAppId: "mx-harbor",
                registeredByAppId: "mx-harbor",
                allowedAppIds: ["mx-harbor"],
                deniedAppIds: ["mx-h2i", "luopan"],
              },
            },
            null,
            userCredentialSummary(credential),
          );
          const iv = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", this.key, iv);
          cipher.setAAD(Buffer.from(`${input.tenantId}:${userId}`));
          const ciphertext = Buffer.concat([
            cipher.update(password, "utf8"),
            cipher.final(),
          ]);
          await this.write(db, "iam-user", userId, user);
          await this.write(db, "iam-user-credential", userId, credential);
          await this.write(db, "dataport-managed-password", userId, {
            tenantId: input.tenantId,
            userId,
            fingerprint: credentialFingerprint(credential),
            iv: iv.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            ciphertext: ciphertext.toString("base64"),
          });
        } else {
          if (
            !user ||
            user.status !== "active" ||
            ["usr_demo_admin", "usr_demo_user"].includes(user.userId)
          )
            fail(404, "account_not_found", "未找到可关联的 MX 账号。");
          if (user!.appAccess.deniedAppIds.includes("mx-harbor"))
            fail(403, "app_access_denied", "此账号已被平台禁止访问数港。");
          // App login eligibility alone grants no enterprise membership. The
          // addressed employee must separately consume the Hub join invitation.
          await this.write(db, "iam-user", user!.userId, {
            ...user,
            updatedAt: new Date().toISOString(),
            appAccess: {
              ...user!.appAccess,
              allowedAppIds: [
                ...new Set([...user!.appAccess.allowedAppIds, "mx-harbor"]),
              ],
            },
          });
        }
        result = {
          userId: user!.userId,
          account: user!.account,
          displayName: user!.displayName,
          issuer: `mx-user-center:${this.environment}`,
          subject: `user:${user!.userId}`,
        };
        await this.write(db, "dataport-account-command", commandId, {
          fingerprint,
          result,
        });
      }
      const id = `aud_${randomUUID()}`;
      await this.write(db, "audit-event", id, {
        eventId: id,
        eventType: `dataport.account.${input.operation}`,
        provenance: "server",
        actorKind: "dataport",
        userId: input.userId || result.userId,
        environment: this.environment,
        siteId: this.siteId,
        metadata: {
          tenantId: input.tenantId,
          actor: input.actor,
          requestId: input.requestId,
        },
        createdAt: new Date().toISOString(),
      });
      return result;
    });
  }
}

@Controller()
export class DataportAccountsController implements OnModuleDestroy {
  private repository?: DataportAccounts;
  constructor(@Inject(RUNTIME_CONFIG) private config: RuntimeConfig) {}
  async onModuleDestroy() {
    await this.repository?.close();
  }
  @Post("internal/v1/dataport/accounts")
  @Header("Cache-Control", "no-store")
  async command(
    @Headers("x-mx-dataport-account") supplied: string | undefined,
    @Body() body: DataportAccountCommand,
  ) {
    let token: string, key: Buffer;
    try {
      token = readFileSync(
        process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE!,
        "utf8",
      ).trim();
      key = Buffer.from(
        readFileSync(
          process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE!,
          "utf8",
        ).trim(),
        "hex",
      );
    } catch {
      throw new ServiceUnavailableException("数港账号服务尚未配置。");
    }
    if (
      token.length < 32 ||
      !supplied ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    )
      throw new UnauthorizedException();
    if (
      !this.config.databaseUrl ||
      this.config.storeDriver !== "postgres" ||
      key.length !== 32
    )
      throw new ServiceUnavailableException("数港账号服务配置无效。");
    try {
      return await (this.repository ??= new DataportAccounts(
        this.config.databaseUrl,
        this.config.environment,
        this.config.siteId,
        key,
      )).execute(body);
    } catch (e) {
      if (e instanceof RegistrationError)
        throw new HttpException({ code: e.code, message: e.message }, e.status);
      throw new ServiceUnavailableException("数港账号服务暂不可用。");
    }
  }
}
