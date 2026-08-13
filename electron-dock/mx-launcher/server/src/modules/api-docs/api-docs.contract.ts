type JsonRecord = Record<string, unknown>;

type AuthMode =
  | 'public'
  | 'token-body'
  | 'bearer'
  | 'internal'
  | 'internal-bearer'
  | 'internal-consumer'
  | 'ops-token';

interface ApiOperation {
  tags: string[];
  summary: string;
  description: string;
  operationId: string;
  security: Array<Record<string, string[]>>;
  requestBody?: JsonRecord;
  parameters?: JsonRecord[];
  responses: Record<string, JsonRecord>;
  'x-route-id'?: string;
  'x-accepted-scopes': string[];
  'x-mx-auth': string;
  'x-mx-curl'?: string;
}

export interface ApiDocsDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, ApiOperation>>;
  components: JsonRecord;
  'x-mx-context': {
    authority: string;
    compatibility: string;
    publicBoundary: string;
    onlinePath: string;
    openApiPath: string;
    markdownPath: string;
  };
}

const roleExample = {
  roleId: 'mx-user',
  displayName: 'MX User',
  scopes: ['auth.read', 'appcenter.read', 'permission.request', 'network.dns.policy'],
  createdAt: '2026-07-20T00:00:00.000Z'
};

const userExample = {
  userId: 'usr_partner_alice',
  tenantId: 'tenant_default',
  orgIds: ['org_default'],
  account: 'partner-alice',
  email: 'alice@example.com',
  displayName: 'Alice',
  roleIds: ['mx-user'],
  status: 'active',
  profile: {
    title: null,
    department: 'Partner',
    location: 'remote',
    address: null,
    phone: null,
    tags: [],
    attributes: { sourceSystem: 'partner-portal' },
    externalIds: { partner: 'alice-001' }
  },
  credential: {
    hasPassword: true,
    passwordUpdatedAt: '2026-07-20T00:00:00.000Z',
    providers: ['local-password']
  },
  appAccess: {
    homeAppId: 'mx-h2i',
    registeredByAppId: 'partner-portal',
    allowedAppIds: ['mx-h2i', 'appcenter', 'h2o'],
    deniedAppIds: []
  },
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z'
};

const serviceAccountExample = {
  serviceAccountId: 'svc_partner_portal',
  tenantId: 'tenant_default',
  displayName: 'Partner Portal',
  roleIds: ['mx-service-account'],
  scopes: ['sdk.identity.read', 'sdk.user.read', 'sdk.permission.request'],
  allowedProductIds: [],
  status: 'active',
  createdAt: '2026-07-20T00:00:00.000Z'
};

const serviceAccountCredentialStatusExample = {
  credentialId: 'sacred_0123456789abcdef0123456789abcdef',
  serviceAccountId: 'svc_partner_portal',
  version: 1,
  source: 'issued',
  issuedAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z'
};

const issuedServiceAccountCredentialExample = {
  clientId: 'svc_partner_portal',
  clientSecret: 'mxsa1.<仅本次响应返回的随机值>',
  credential: serviceAccountCredentialStatusExample
};

const appCenterAppExample = {
  appId: 'luopan',
  displayName: 'Luopan',
  builtin: false,
  systemOwned: false,
  packageName: '@qpjoy/luopan-demo',
  version: '0.1.0',
  category: 'custom',
  description: 'Luopan standalone Launcher application.',
  launcherMode: 'standalone',
  standaloneChannelProductId: 'luopan',
  productNetworkId: 'luopan',
  enabled: true,
  channels: ['shadow', 'beta', 'stable'],
  permissions: ['auth.read'],
  requiredCapabilities: ['launcher-network', 'launcher-standalone'],
  accessPolicy: {
    defaultDecision: 'private',
    allowAdmin: true,
    allowRoles: [],
    allowUserIds: [],
    allowOrgIds: [],
    allowRegisteredByAppIds: [],
    allowHomeAppIds: [],
    requirePermissionGrant: false
  },
  updatePolicy: 'app-managed'
};

const appCenterPublisherServiceAccountExample = {
  ...serviceAccountExample,
  serviceAccountId: 'svc_luopan_release_publisher',
  displayName: 'Luopan Release Publisher',
  roleIds: ['mx-release-publisher'],
  scopes: ['sdk.release.read', 'sdk.release.publish'],
  allowedProductIds: ['luopan']
};

const appCenterIssuedPublisherCredentialExample = {
  ...issuedServiceAccountCredentialExample,
  clientId: 'svc_luopan_release_publisher',
  credential: {
    ...serviceAccountCredentialStatusExample,
    credentialId: 'sacred_0123456789abcdef0123456789abcdef',
    serviceAccountId: 'svc_luopan_release_publisher'
  }
};

const appCenterUpsertResponseExample = {
  app: appCenterAppExample,
  publisher: {
    serviceAccount: appCenterPublisherServiceAccountExample,
    credential: appCenterIssuedPublisherCredentialExample
  }
};

const appCenterUpsertResponseSchema = {
  type: 'object',
  required: ['app', 'publisher'],
  properties: {
    app: schemaFromExample(appCenterAppExample),
    publisher: {
      oneOf: [{
        type: 'object',
        required: ['serviceAccount', 'credential'],
        properties: {
          serviceAccount: schemaFromExample(appCenterPublisherServiceAccountExample),
          credential: {
            oneOf: [
              schemaFromExample(appCenterIssuedPublisherCredentialExample),
              { type: 'null' }
            ],
            description: '首次签发时包含一次性 clientSecret；已有 credential 的幂等更新返回 null。'
          }
        }
      }, {
        type: 'null'
      }],
      description: 'enabled 应用返回 Publisher；disabled 应用返回 null。'
    }
  }
};

const entitlementExample = {
  entitlementId: 'uent_partner_alice',
  userId: 'usr_partner_alice',
  environment: 'production',
  service: 'hysteria2',
  siteIds: ['oversea-main'],
  accounts: [{
    siteId: 'oversea-main',
    username: 'mx_alice',
    accountId: 'acct_oversea_main_alice',
    status: 'active',
    subscriptionPath: '/internal/v1/user-center/users/usr_partner_alice/oversea/subscription.yaml',
    siteSubscriptionUrl: 'https://oversea.example.com/subscriptions/mx_alice.yaml',
    runtimeSync: {
      status: 'synced',
      checkedAt: '2026-07-20T00:00:00.000Z',
      accountUpdatedAt: '2026-07-20T00:00:00.000Z',
      lastSyncedAt: '2026-07-20T00:00:00.000Z',
      requiredAction: 'none',
      reason: 'runtime account is synchronized'
    }
  }],
  status: 'active',
  subscriptionPath: '/internal/v1/user-center/users/usr_partner_alice/oversea/subscription.yaml',
  createdBy: 'internal-admin',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedBy: 'internal-admin',
  updatedAt: '2026-07-20T00:00:00.000Z'
};

export const mxLauncherApiDocument: ApiDocsDocument = {
  openapi: '3.1.0',
  info: {
    title: 'MX Launcher Integration API',
    version: '2.0.2-shadow',
    description: 'Internal-authoritative integration contract for MX-H2I, User Center, Permission Center, Release Center and the SDK Gateway.'
  },
  servers: [
    { url: 'http://localhost:18090', description: 'Local or port-forwarded Internal API' },
    { url: 'http://10.88.88.88:18090', description: 'Internal service peer through the Domestic relay' }
  ],
  tags: [
    { name: 'Discovery', description: 'Gateway discovery and route registry.' },
    { name: 'Authentication', description: 'OAuth-compatible token issuance and identity resolution.' },
    { name: 'User Center', description: 'Stable SDK-facing roles, users and service accounts.' },
    { name: 'App Center Admin', description: 'Ops-token protected application provisioning and product-scoped Release Publisher issuance.' },
    { name: 'Permission Center', description: 'AppCenter-aware permission grant evaluation.' },
    { name: 'Release Consumer', description: 'Installed applications check, download, and report sanitized Release Center decisions.' },
    { name: 'Release Publisher', description: 'Product-scoped CI and developer APIs for artifact upload, gated release creation, and approval.' },
    { name: 'Internal User Operations', description: 'Trusted Internal operations for import, Oversea entitlement and H2O runtime state.' },
    { name: 'Oversea Subscriptions', description: 'Subscription surfaces for H2O and for third-party clients such as Clash. The two use different credential classes.' },
    { name: 'Launcher Network', description: 'Product network bootstrap that clients read before they can reach Internal.' }
  ],
  paths: {
    '/healthz': {
      get: operation({
        tag: 'Discovery',
        summary: '存活探针',
        description: '唯一在公网 edge 上放行的无认证路径，接入方可以用它确认到 Internal 的链路是通的。'
          + '它返回 200 不代表 /internal/v1/* 可达——那些走 WG 或 edge allowlist。',
        operationId: 'healthz',
        auth: 'public',
        response: {
          ok: true,
          service: 'mx-launcher-server',
          framework: 'nestjs',
          ts: '2026-07-20T00:00:00.000Z'
        }
      })
    },
    '/internal/v1/launcher-network/products/{productId}': {
      get: operation({
        tag: 'Launcher Network',
        summary: '读取产品网络配置',
        description: '客户端 bootstrap 的第一跳：拿到 DNS、网关和默认站点后才能连进 Internal。'
          + '这条 GET 在 Domestic edge 的 allowlist 里，所以公网可读；同名 POST 只在 Internal 内可用。',
        operationId: 'getLauncherProductNetwork',
        auth: 'public',
        pathParams: ['productId'],
        response: {
          product: {
            productId: 'mx-h2i',
            mode: 'embed',
            productIndex: 1,
            dnsServer: '10.88.88.88',
            domesticGatewayIp: '10.88.0.1',
            serviceVip: '10.88.88.88',
            userCidr: '10.88.1.0/24',
            defaultDomesticSiteId: 'domestic-main',
            defaultOverseaSiteId: 'mx-oversea-hk01',
            enabled: true,
            updatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/sdk/gateway/manifest': {
      get: operation({
        tag: 'Discovery',
        summary: '读取 SDK Gateway 路由清单',
        description: '返回可发现的 routeId、路径、受理 audience 以及文档下载地址。集成方应先读取该清单，不要依赖 Internal 数据表。',
        operationId: 'getSdkGatewayManifest',
        routeId: 'sdk.gateway.manifest',
        auth: 'public',
        response: {
          gateway: {
            gatewayId: 'sdk-gateway:internal-main',
            environment: 'production',
            siteId: 'internal-main',
            authority: 'sdk-gateway',
            authAuthority: 'user-center',
            basePath: '/internal/v1/sdk',
            routes: [{
              routeId: 'sdk.users.list',
              path: '/internal/v1/sdk/users',
              upstreamModule: 'user-center',
              audience: 'mx-sdk',
              authRequired: true,
              description: 'Lists User Center users for trusted peer systems.'
            }],
            sdk: {
              audience: 'mx-sdk',
              documentationUrl: '/docs/api/',
              openApiUrl: '/docs/api/openapi.json',
              markdownUrl: '/docs/api/mx-launcher-api.md'
            }
          }
        }
      })
    },
    '/internal/v1/app-center/apps': {
      post: operation({
        tag: 'App Center Admin',
        summary: '创建 AppCenter 应用并签发 Release Publisher',
        description: 'Internal ops 管理接口，要求 x-mx-ops-token。packageName 必须是应用构建元数据中的真实稳定值，并且在 AppCenter 唯一；重复值返回 409，避免用户端解析到错误发布产品。创建 enabled 应用时，平台自动 ensure 仅绑定该 appId 的 Release Publisher service account；账号尚无 credential 时只在本次响应返回一次明文 clientSecret。相同应用的幂等重试不会查询或轮换旧 secret，publisher.credential 返回 null。',
        operationId: 'createAppCenterAppWithPublisher',
        scopes: [],
        auth: 'ops-token',
        curl: [
          'curl -sS -X POST "$BASE/internal/v1/app-center/apps" \\',
          '  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \\',
          '  -H "content-type: application/json" \\',
          '  --data \'{"appId":"luopan","displayName":"Luopan","packageName":"@qpjoy/luopan-demo","launcherMode":"standalone","enabled":true,"requestedBy":"internal-release-admin"}\''
        ].join('\n'),
        request: {
          appId: 'luopan',
          displayName: 'Luopan',
          packageName: '@qpjoy/luopan-demo',
          launcherMode: 'standalone',
          enabled: true,
          requestedBy: 'internal-release-admin'
        },
        required: ['appId'],
        responseSchema: appCenterUpsertResponseSchema,
        response: appCenterUpsertResponseExample
      })
    },
    '/internal/v1/app-center/apps/{appId}': {
      post: operation({
        tag: 'App Center Admin',
        summary: '幂等更新应用并补齐 Release Publisher credential',
        description: 'Internal ops 管理接口，要求 x-mx-ops-token。appId 取自路径；packageName 必须与应用构建元数据一致且全局唯一。新应用或尚无 credential 的旧应用会得到一次性 publisher.credential；已有 credential 的幂等更新保留数据库 verifier，并在同一响应结构中返回 publisher.credential=null。一次性响应丢失时必须调用 credential rotate 接口，不能查询旧值。',
        operationId: 'upsertAppCenterAppWithPublisher',
        scopes: [],
        auth: 'ops-token',
        pathParams: ['appId'],
        curl: [
          'curl -sS -X POST "$BASE/internal/v1/app-center/apps/luopan" \\',
          '  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \\',
          '  -H "content-type: application/json" \\',
          '  --data \'{"displayName":"Luopan","packageName":"@qpjoy/luopan-demo","launcherMode":"standalone","enabled":true,"requestedBy":"internal-release-admin"}\''
        ].join('\n'),
        request: {
          displayName: 'Luopan',
          packageName: '@qpjoy/luopan-demo',
          launcherMode: 'standalone',
          enabled: true,
          requestedBy: 'internal-release-admin'
        },
        responseSchema: appCenterUpsertResponseSchema,
        response: appCenterUpsertResponseExample
      }),
      delete: operation({
        tag: 'App Center Admin',
        summary: '删除应用并撤销自动 Release Publisher',
        description: 'Internal ops 管理接口。删除非内置应用时会在同一数据库事务内禁用自动 Publisher、撤销其 active token 并删除 credential verifier；以后重建同一 appId 会签发全新的 secret，旧 secret 与旧 token 都不会恢复。',
        operationId: 'deleteAppCenterAppAndPublisher',
        scopes: [],
        auth: 'ops-token',
        pathParams: ['appId'],
        curl: [
          'curl -sS -X DELETE "$BASE/internal/v1/app-center/apps/luopan" \\',
          '  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"'
        ].join('\n'),
        response: {
          deleted: true
        }
      })
    },
    '/internal/v1/sdk/oauth/token': {
      post: operation({
        tag: 'Authentication',
        summary: '获取用户或服务账号 token',
        description: '支持 password 与 client_credentials。password access token 默认且最长有效 7 天，并可经可信 HTTPS bootstrap 调用；client_credentials 默认有效 1 小时且仅允许 Internal 控制面调用，经 Domestic edge 的请求会在 secret 比较前拒绝。开发者服务账号使用数据库中的 scrypt verifier 校验账号独立 client secret；明文只在创建或轮换时返回一次。全局 Internal ops token 仅保留给内置 svc_sdk_gateway 的迁移兼容，禁止分发。两种 grant 都在凭据校验前执行 PostgreSQL 原子限速。',
        operationId: 'issueSdkToken',
        routeId: 'sdk.oauth.token',
        auth: 'public',
        request: {
          grant_type: 'password',
          username: 'partner-alice',
          password: '<password>',
          scope: 'sdk.identity.read sdk.user.read permission.request',
          audience: 'mx-sdk',
          requestId: 'partner-login-001'
        },
        required: ['grant_type', 'username', 'password'],
        response: {
          token: {
            access_token: '<access-token>',
            token_type: 'Bearer',
            issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            expires_in: 604800,
            scope: 'sdk.identity.read sdk.user.read permission.request',
            issuer: 'mx-user-center:production',
            audience: 'mx-sdk',
            subject: 'user:usr_partner_alice',
            principal: { kind: 'user', userId: 'usr_partner_alice', roles: ['mx-user'] },
            expires_at: '2026-07-27T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/sdk/oauth/feishu/config': {
      get: operation({
        tag: 'Authentication',
        summary: '读取飞书登录公开配置',
        description: '只返回 Electron 发起登录所需的公开配置与启用状态；不会返回 App Secret 或允许租户列表。enabled=false 时客户端应保持账号密码和访客登录可用。',
        operationId: 'getFeishuOAuthConfig',
        routeId: 'sdk.oauth.feishu.config',
        auth: 'public',
        response: {
          config: {
            enabled: true,
            appId: 'cli_xxxxxxxxxxxxxxxx',
            authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
            redirectUris: ['http://127.0.0.1:17891/oauth/feishu/callback'],
            autoProvision: true,
            pkce: {
              required: true,
              codeChallengeMethod: 'S256',
              localExchangeBinding: true,
              providerVerification: 'requires-real-tenant-validation'
            }
          }
        }
      })
    },
    '/internal/v1/sdk/oauth/feishu/authorize': {
      post: operation({
        tag: 'Authentication',
        summary: '生成飞书授权地址',
        description: 'Internal 对 redirectUri 做精确 allowlist 校验，把客户端生成的 state 与 PKCE S256 challenge 写入飞书授权地址，并创建五分钟有效的 exchangeHandle。新版客户端可传 exchangeHandleVersion=mxfx2 请求服务端签名 handle；未传时保持 mxfx1 兼容。Internal 仍优先在共享 store 中原子消费，用于挡重放，store 临时不可见时可用签名 handle 完成本地 redirect/PKCE/过期校验。客户端仍必须在 loopback 回调时校验 state。',
        operationId: 'createFeishuAuthorizationUrl',
        routeId: 'sdk.oauth.feishu.authorize',
        auth: 'public',
        request: {
          redirectUri: 'http://127.0.0.1:17891/oauth/feishu/callback',
          state: '<random-state>',
          codeChallenge: '<base64url-sha256-code-verifier>',
          exchangeHandleVersion: 'mxfx2'
        },
        required: ['redirectUri', 'state', 'codeChallenge'],
        response: {
          authorizationUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?...',
          exchangeHandle: 'mxfx2.<signed-payload>.<signature>'
        }
      })
    },
    '/internal/v1/sdk/oauth/feishu/token': {
      post: operation({
        tag: 'Authentication',
        summary: '用飞书授权码换取 MX token',
        description: 'Internal 先尝试原子消费 exchangeHandle 的共享 store 记录，并校验其绑定的 redirect URI 与 PKCE verifier；如果记录在部署/路由切换期间不可见，则校验新版签名 handle 中的 redirect、challenge 与过期时间。随后使用 App Secret 和授权码向飞书换票，读取用户身份并校验 tenant allowlist。响应只返回 MX User Center token；飞书 access/refresh token 不返回且不持久化。飞书当前公开 v2 token 文档未明确声明 PKCE 字段，生产启用前仍须用真实租户证明错误 verifier 会被飞书上游拒绝。',
        operationId: 'exchangeFeishuAuthorizationCode',
        routeId: 'sdk.oauth.feishu.token',
        auth: 'public',
        request: {
          code: '<one-time-authorization-code>',
          redirectUri: 'http://127.0.0.1:17891/oauth/feishu/callback',
          codeVerifier: '<pkce-code-verifier>',
          exchangeHandle: 'mxfx2.<signed-payload>.<signature>',
          audience: 'mx-sdk',
          scope: 'auth.read appcenter.read network.dns.policy oversea.subscription.ensure',
          requestId: 'mx-h2i-feishu-001'
        },
        required: ['code', 'redirectUri', 'codeVerifier', 'exchangeHandle'],
        response: {
          token: {
            access_token: '<mx-access-token>',
            token_type: 'Bearer',
            issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
            expires_in: 604800,
            scope: 'auth.read appcenter.read network.dns.policy oversea.subscription.ensure',
            issuer: 'mx-user-center:production',
            audience: 'mx-sdk',
            subject: 'user:usr_feishu_<deterministic-hash>',
            principal: {
              kind: 'user',
              userId: 'usr_feishu_<deterministic-hash>',
              roles: ['mx-user']
            },
            auth_provider: 'feishu',
            expires_at: '2026-07-27T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/sdk/identity/introspect': {
      post: operation({
        tag: 'Authentication',
        summary: '校验 token 并返回主体',
        description: 'token 通过 JSON body 传入。active=false 时读取 reason；不要仅凭 token 字符串格式判断身份。',
        operationId: 'introspectSdkToken',
        routeId: 'sdk.identity.introspect',
        scopes: ['sdk.identity.read', 'auth.read'],
        auth: 'token-body',
        request: { token: '<access-token>', audience: 'mx-sdk', requestId: 'introspect-001' },
        required: ['token'],
        response: {
          introspection: {
            active: true,
            tokenKind: 'jwt',
            issuer: 'mx-user-center:production',
            audience: 'mx-sdk',
            subject: 'user:usr_partner_alice',
            principal: { kind: 'user', userId: 'usr_partner_alice', roles: ['mx-user'], scopes: ['auth.read'] },
            scopes: ['auth.read'],
            expiresAt: '2026-07-20T01:00:00.000Z',
            reason: 'token accepted by User Center V1 record'
          }
        }
      })
    },
    '/internal/v1/sdk/identity/context': {
      post: operation({
        tag: 'Authentication',
        summary: '解析完整 Principal Context',
        description: '把 token、用户、服务账号或匿名安装解析为统一主体，并返回 install/device 绑定和允许访问的 Gateway routes。',
        operationId: 'resolvePrincipalContext',
        routeId: 'sdk.identity.context',
        scopes: ['sdk.identity.read', 'auth.read'],
        auth: 'token-body',
        request: { token: '<access-token>', audience: 'mx-sdk', installId: 'inst_mxh2i_001', requestId: 'context-001' },
        response: {
          context: {
            principal: { principalId: 'user:usr_partner_alice', kind: 'user', userId: 'usr_partner_alice', roles: ['mx-user'], scopes: ['auth.read'] },
            auth: { active: true, tokenKind: 'jwt', audience: 'mx-sdk' },
            bindings: { installId: 'inst_mxh2i_001', deviceId: 'dev_001', anonymousPrincipalId: null, linkedUserId: 'usr_partner_alice' },
            gateway: { authority: 'sdk-gateway', canUseSdkGateway: true, allowedRoutes: ['sdk.identity.context'] },
            source: 'token'
          }
        }
      })
    },
    '/internal/v1/sdk/gateway/access/evaluate': {
      post: operation({
        tag: 'Authentication',
        summary: '评估 routeId 与 AppCenter 访问权',
        description: '先校验 route scope；传 appId 时再叠加 AppCenter accessPolicy。allowed=true 才表示该主体满足当前契约。',
        operationId: 'evaluateSdkGatewayAccess',
        routeId: 'sdk.gateway.access.evaluate',
        scopes: ['sdk.identity.read'],
        auth: 'token-body',
        request: {
          token: '<access-token>',
          audience: 'mx-sdk',
          routeId: 'sdk.users.list',
          appId: 'h2o',
          sourceAppId: 'mx-h2i',
          requestId: 'access-001'
        },
        required: ['token', 'routeId'],
        response: {
          decision: {
            routeId: 'sdk.users.list',
            allowed: true,
            matchedScopes: ['sdk.user.read'],
            missingScopes: [],
            appAccess: { appId: 'h2o', allowed: true, reason: 'app access policy allows the principal' },
            reason: 'principal has a scope accepted by SDK Gateway route'
          }
        }
      })
    },
    '/internal/v1/sdk/roles': {
      get: operation({
        tag: 'User Center',
        summary: '列出角色及 scopes',
        description: '角色是 scope 的集合。内置角色包括 mx-admin、mx-user、mx-service-account 和 mx-guest。',
        operationId: 'listSdkRoles',
        routeId: 'sdk.roles.list',
        scopes: ['sdk.user.read', 'rbac.manage'],
        auth: 'bearer',
        response: { roles: [roleExample] }
      })
    },
    '/internal/v1/sdk/users': {
      get: operation({
        tag: 'User Center',
        summary: '列出 User Center 用户',
        description: '返回 profile、credential 摘要和 appAccess；不会返回密码哈希或明文密码。',
        operationId: 'listSdkUsers',
        routeId: 'sdk.users.list',
        scopes: ['sdk.user.read', 'rbac.manage'],
        auth: 'bearer',
        response: { users: [userExample] }
      }),
      post: operation({
        tag: 'User Center',
        summary: '创建或更新用户',
        description: 'account 或 email 至少提供一个。roleIds/orgIds/appAccess 均由 Internal 保存为权威配置。',
        operationId: 'createSdkUser',
        routeId: 'sdk.users.create',
        scopes: ['sdk.user.write', 'rbac.manage'],
        auth: 'bearer',
        request: {
          account: 'partner-alice',
          email: 'alice@example.com',
          displayName: 'Alice',
          password: '<initial-password>',
          roleIds: ['mx-user'],
          orgIds: ['org_default'],
          profile: {
            department: 'Partner',
            location: 'remote',
            attributes: { sourceSystem: 'partner-portal' },
            externalIds: { partner: 'alice-001' }
          },
          homeAppId: 'mx-h2i',
          registeredByAppId: 'partner-portal',
          allowedAppIds: ['mx-h2i', 'appcenter', 'h2o'],
          requestId: 'user-create-001'
        },
        required: ['account'],
        response: { user: userExample }
      })
    },
    '/internal/v1/sdk/users/me/password': {
      post: operation({
        tag: 'User Center',
        summary: '当前登录用户修改自己的密码',
        description: '登录用户自助改密接口。服务端从 active mx-sdk Bearer 解析 userId，校验 currentPassword 后更新本地密码并撤销该用户全部 active token；不能指定或修改其他用户。',
        operationId: 'updateOwnSdkUserPassword',
        routeId: 'sdk.users.password.self',
        scopes: ['auth.read'],
        auth: 'bearer',
        request: {
          currentPassword: '<current-password>',
          newPassword: '<new-password>',
          requestId: 'user-password-change-001'
        },
        required: ['currentPassword', 'newPassword'],
        response: {
          password: {
            user: userExample,
            tokensRevoked: 1,
            updatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/sdk/users/{userId}/password': {
      post: operation({
        tag: 'User Center',
        summary: '通过 SDK Gateway 更新用户密码',
        description: '供可信外部系统调用的稳定改密接口。调用方必须持有 active mx-sdk Bearer，并具备 sdk.user.write 或 rbac.manage；User Center 会重新生成 local-password credential，并撤销目标用户全部 active token。调用方身份从 token principal 写入审计，不接受 request body 冒充 requestedBy。',
        operationId: 'updateSdkUserPassword',
        routeId: 'sdk.users.password.update',
        scopes: ['sdk.user.write', 'rbac.manage'],
        auth: 'bearer',
        pathParams: ['userId'],
        request: {
          password: '<new-password>',
          requestId: 'partner-password-update-001'
        },
        required: ['password'],
        response: {
          password: {
            user: userExample,
            tokensRevoked: 2,
            updatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/sdk/service-accounts': {
      get: operation({
        tag: 'User Center',
        summary: '列出服务账号',
        description: 'Internal ops 管理接口，要求 x-mx-ops-token；响应只包含账号元数据、scopes 和产品范围，不包含 secret。',
        operationId: 'listSdkServiceAccounts',
        scopes: [],
        auth: 'ops-token',
        curl: 'curl -sS "$BASE/internal/v1/sdk/service-accounts" -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"',
        response: {
          serviceAccounts: [serviceAccountExample],
          credentials: [serviceAccountCredentialStatusExample]
        }
      }),
      post: operation({
        tag: 'User Center',
        summary: '创建服务账号',
        description: 'Internal ops 管理接口，要求 x-mx-ops-token。仅授予集成实际需要的最小 scopes 与 allowedProductIds。账号没有 credential 时会自动签发，并且明文 clientSecret 只在本次响应返回；幂等重试不会回显或轮换已有 secret。',
        operationId: 'createSdkServiceAccount',
        scopes: [],
        auth: 'ops-token',
        curl: [
          'curl -sS -X POST "$BASE/internal/v1/sdk/service-accounts" \\',
          '  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \\',
          '  -H "content-type: application/json" \\',
          '  --data \'{"serviceAccountId":"svc_partner_portal","displayName":"Partner Portal","roleIds":["mx-service-account"],"scopes":["sdk.identity.read"],"allowedProductIds":[],"requestId":"service-account-create-001"}\''
        ].join('\n'),
        request: {
          serviceAccountId: 'svc_partner_portal',
          displayName: 'Partner Portal',
          roleIds: ['mx-service-account'],
          scopes: ['sdk.identity.read', 'sdk.user.read', 'sdk.permission.request'],
          allowedProductIds: [],
          requestId: 'service-account-create-001'
        },
        required: ['serviceAccountId'],
        response: {
          serviceAccount: serviceAccountExample,
          credential: issuedServiceAccountCredentialExample
        }
      })
    },
    '/internal/v1/sdk/service-accounts/{serviceAccountId}/credentials/rotate': {
      post: operation({
        tag: 'User Center',
        summary: '轮换服务账号 client secret',
        description: 'Internal ops 管理接口。生成新 secret、覆盖数据库中的 verifier，并只在本次响应返回明文；旧 secret 立即不能再换取 token。调用方必须同步更新对应应用的 CI/Vault。',
        operationId: 'rotateSdkServiceAccountCredential',
        scopes: [],
        auth: 'ops-token',
        pathParams: ['serviceAccountId'],
        curl: [
          'curl -sS -X POST "$BASE/internal/v1/sdk/service-accounts/svc_partner_portal/credentials/rotate" \\',
          '  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \\',
          '  -H "content-type: application/json" \\',
          '  --data \'{"requestId":"service-account-rotate-001"}\''
        ].join('\n'),
        request: {
          requestId: 'service-account-rotate-001'
        },
        response: {
          credential: {
            ...issuedServiceAccountCredentialExample,
            credential: {
              ...serviceAccountCredentialStatusExample,
              version: 2
            }
          }
        }
      })
    },
    '/internal/v1/sdk/permissions/requests': {
      post: operation({
        tag: 'Permission Center',
        summary: '申请应用或安装级权限',
        description: 'Permission Center 先评估 AppCenter accessPolicy，再把请求 scopes 与应用 manifest.permissions 取交集，返回 granted、partial 或 denied。一次响应就是当前评估结果，不等同于永久放权。',
        operationId: 'requestSdkPermission',
        routeId: 'sdk.permissions.request',
        scopes: ['sdk.permission.request', 'permission.request'],
        auth: 'bearer',
        request: {
          appId: 'h2o',
          installId: 'inst_mxh2i_001',
          userId: 'usr_partner_alice',
          sourceAppId: 'mx-h2i',
          scopes: ['network.proxy.app', 'network.dns.policy'],
          requestedBy: 'partner-portal',
          requestId: 'permission-001'
        },
        required: ['appId', 'scopes'],
        response: {
          grant: {
            grantId: 'grant_001',
            appId: 'h2o',
            scopes: ['network.proxy.app', 'network.dns.policy'],
            allowedScopes: ['network.proxy.app', 'network.dns.policy'],
            deniedScopes: [],
            decision: 'granted',
            requestedBy: 'partner-portal',
            installId: 'inst_mxh2i_001',
            userId: 'usr_partner_alice',
            sourceAppId: 'mx-h2i',
            accessAllowed: true,
            accessReason: 'app access policy allows the principal',
            createdAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/user-center/users': {
      get: operation({
        tag: 'Internal User Operations',
        summary: '列出 User Center 用户',
        description: 'Internal 管理面读取接口，返回权威用户目录。对外集成请用 `/internal/v1/sdk/users`，它有 scope 边界。',
        operationId: 'listInternalUserCenterUsers',
        auth: 'ops-token',
        response: { users: [userExample] }
      }),
      post: operation({
        tag: 'Internal User Operations',
        summary: '创建 User Center 用户',
        description: '创建主体、本地登录凭据和可选的 Oversea 授权。'
          + '`defaultOverseaSiteIds` 省略时由平台默认站点决定（可在 admin 后台改，不再写死 oversea-main）。',
        operationId: 'createInternalUserCenterUser',
        auth: 'ops-token',
        request: {
          account: 'partner-alice',
          displayName: 'Alice',
          email: 'alice@example.com',
          roleIds: ['mx-user'],
          password: '<初始口令>',
          provisionOversea: true,
          defaultOverseaSiteIds: ['mx-oversea-hk01'],
          requestedBy: 'internal-admin',
          requestId: 'user-create-001'
        },
        required: ['account'],
        response: { user: userExample }
      })
    },
    '/internal/v1/user-center/system-subscriptions': {
      get: operation({
        tag: 'Oversea Subscriptions',
        summary: '列出置顶的系统订阅目录',
        description: 'ops-token 管理接口。返回不可登录、不可删除的 subscriptions 虚拟系统账号和脱敏的 Direct-IP channel。'
          + 'GET 永不返回 Hysteria2 token 或 Basic 密码；ready 还要求最新 Oversea 部署证据晚于账号变更。',
        operationId: 'listSystemSubscriptions',
        auth: 'ops-token',
        response: {
          catalog: {
            account: { accountId: 'subscriptions', kind: 'system-subscription-catalog', loginAllowed: false, immutable: true, pinnedRank: 0 },
            summary: { total: 1, ready: 1, pending: 0, blocked: 0 },
            subscriptions: [{
              subscriptionId: 'oversea-direct:mx-oversea-hk01',
              siteId: 'mx-oversea-hk01',
              status: 'ready',
              delivery: { kind: 'oversea-direct-ip-http-basic', host: '203.0.113.21', port: 3434, urlMasked: 'http://subscriptions:***@203.0.113.21:3434/peer_mx-oversea-hk01-subscriptions.mihomo.yaml' },
              client: { mixedPort: 7788, explicitUseOnly: true },
              trafficPolicy: { mode: 'unlimited', maxBytes: null, resetPeriod: null, expiresAt: null },
              bandwidthHint: { down: '50 Mbps', up: '50 Mbps' }
            }]
          }
        }
      })
    },
    '/internal/v1/user-center/system-subscriptions/ensure': {
      post: operation({
        tag: 'Oversea Subscriptions',
        summary: '确保系统订阅运行账号',
        description: '只在 Internal 幂等创建非登录的 site access account，不执行远端部署。'
          + '随后必须走普通 Oversea Install/Sync；这个边界确保现有用户 OAuth、7788 和 ensure-subscription 不被隐式修改。',
        operationId: 'ensureSystemSubscriptions',
        auth: 'ops-token',
        request: { siteIds: ['mx-oversea-hk01'], requestedBy: 'desktop-admin', requestId: 'system-subscriptions-ensure-001' },
        response: {
          ensure: {
            status: 'ensured',
            accounts: [{ siteId: 'mx-oversea-hk01', accountId: 'slotacct_mx-oversea-hk01_mx-oversea-hk01-subscriptions', username: 'mx-oversea-hk01-subscriptions', status: 'active' }],
            missingSiteIds: [],
            nextAction: 'Run Oversea Install/Sync for each pending site before revealing its direct-IP URL.'
          }
        }
      })
    },
    '/internal/v1/user-center/system-subscriptions/sites/{siteId}/reveal': {
      post: operation({
        tag: 'Oversea Subscriptions',
        summary: '临时显示 Direct-IP 系统订阅凭据',
        description: 'ops-token + no-store。只允许 ready channel；仅在本次响应返回明文 URL，不生成本地安装命令。'
          + '调用方手工把 URL 添加到自行选择的应用；MX 不安装或管理 7788/7890 本地实例，禁止把响应写入审计或日志。',
        operationId: 'revealSystemSubscription',
        auth: 'ops-token',
        pathParams: ['siteId'],
        response: {
          subscription: {
            subscriptionId: 'oversea-direct:mx-oversea-hk01',
            siteId: 'mx-oversea-hk01',
            url: 'http://subscriptions:<secret>@203.0.113.21:3434/peer_mx-oversea-hk01-subscriptions.mihomo.yaml',
            note: 'Copy the URL into the operator-chosen application; MX does not install or manage a local proxy instance.'
          }
        }
      })
    },
    '/internal/v1/user-center/users/import': {
      post: operation({
        tag: 'Internal User Operations',
        summary: '批量导入旧 HDO 或外部用户',
        description: 'Internal 运维接口。支持 legacy account/password/user_name，并可同时配置默认角色、应用访问和 Oversea entitlement。匹配已有账号时，显式 password 会覆盖 credential，省略则保留。不要经 Domestic 公网入口开放。',
        operationId: 'importInternalUsers',
        auth: 'internal',
        request: {
          users: [{
            account: 'legacy-user',
            password: '<existing-password>',
            user_name: 'Legacy User',
            attributes: { sourceSystem: 'hdo-v1' },
            externalIds: { hdo: 'legacy-001' }
          }],
          defaultRoleIds: ['mx-user'],
          defaultOrgIds: ['org_default'],
          defaultHomeAppId: 'mx-h2i',
          defaultRegisteredByAppId: 'mx-h2i',
          defaultAllowedAppIds: ['mx-h2i', 'appcenter', 'h2o'],
          defaultOverseaSiteIds: ['oversea-main'],
          provisionOversea: true,
          requestId: 'legacy-import-001'
        },
        required: ['users'],
        response: {
          import: {
            imported: 1,
            updated: 0,
            failed: 0,
            users: [userExample],
            entitlements: [entitlementExample],
            failures: [],
            generatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/user-center/users/{userId}/password': {
      post: operation({
        tag: 'Internal User Operations',
        summary: '更新用户本地密码',
        description: 'Internal 管理操作。重新生成 local-password credential，并撤销该用户尚未撤销的 token；不会修改用户 profile、角色或应用权限。',
        operationId: 'updateInternalUserPassword',
        auth: 'internal',
        pathParams: ['userId'],
        request: {
          password: '<new-password>',
          requestedBy: 'internal-admin',
          requestId: 'user-password-update-001'
        },
        required: ['password'],
        response: {
          password: {
            user: userExample,
            tokensRevoked: 2,
            updatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/user-center/users/{userId}': {
      delete: operation({
        tag: 'Internal User Operations',
        summary: '安全删除用户',
        description: '删除本地 credential、token、disabled Oversea entitlement、H2O profile、用户应用安装和 permission grant，并写入删除墓碑，避免历史 seed 在 Bootstrap 时复活。内置用户、最后一个 active mx-admin、仍有关联设备/活动 lease 或 active Oversea access 的用户会被拒绝。',
        operationId: 'deleteInternalUser',
        auth: 'internal',
        pathParams: ['userId'],
        request: {
          requestedBy: 'internal-admin',
          requestId: 'user-delete-001'
        },
        response: {
          deletion: {
            deleted: true,
            userId: 'usr_partner_alice',
            account: 'partner-alice',
            deletedRecords: {
              credential: 1,
              tokens: 2,
              overseaEntitlements: 1,
              h2oRuntimeProfiles: 1,
              appInstallations: 1,
              permissionGrants: 1
            },
            deletedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/user-center/oversea-entitlements': {
      get: operation({
        tag: 'Internal User Operations',
        summary: '列出 Oversea entitlement',
        description: 'Internal 管理面读取接口，返回用户到 Oversea site/access account 的权威映射。',
        operationId: 'listInternalOverseaEntitlements',
        auth: 'internal',
        response: { entitlements: [entitlementExample] }
      })
    },
    '/internal/v1/user-center/oversea-entitlements/migrate': {
      post: operation({
        tag: 'Internal User Operations',
        summary: '批量迁移用户的 Oversea 站点',
        description: '站点退役/改用途时把存量用户从 fromSiteId 搬到 toSiteId。'
          + '不带 confirm 是 dry-run，只返回将要变更的名单；confirm=true 才写入。'
          + 'mode=replace 换掉原站点，mode=add 只追加。目标站点必须仍在役。',
        operationId: 'migrateInternalUserOverseaEntitlements',
        auth: 'internal',
        request: {
          fromSiteId: 'oversea-main',
          toSiteId: 'mx-oversea-hk01',
          mode: 'replace',
          confirm: false,
          requestedBy: 'desktop-admin',
          requestId: 'oversea-migration-001'
        },
        required: ['fromSiteId', 'toSiteId'],
        response: {
          migration: {
            fromSiteId: 'oversea-main',
            toSiteId: 'mx-oversea-hk01',
            mode: 'replace',
            applied: false,
            scanned: 42,
            matched: 12,
            changed: 0,
            failed: 0,
            changes: [{
              userId: 'usr_demo_user',
              account: 'demo.user',
              before: ['oversea-main'],
              after: ['mx-oversea-hk01'],
              status: 'planned'
            }],
            generatedAt: '2026-08-09T09:16:05.000Z'
          }
        }
      })
    },
    '/internal/v1/user-center/users/{userId}/oversea': {
      get: operation({
        tag: 'Internal User Operations',
        summary: '读取单个用户的 Oversea entitlement',
        description: 'userId 使用 User Center 的稳定用户标识。',
        operationId: 'getInternalUserOverseaEntitlement',
        auth: 'internal',
        pathParams: ['userId'],
        response: { entitlement: entitlementExample }
      }),
      post: operation({
        tag: 'Internal User Operations',
        summary: '创建或更新 Oversea entitlement',
        description: 'Internal 根据 siteIds 生成或更新用户的 access account 与订阅引用。',
        operationId: 'upsertInternalUserOverseaEntitlement',
        auth: 'internal',
        pathParams: ['userId'],
        request: {
          siteIds: ['oversea-main'],
          requestedBy: 'internal-admin',
          requestId: 'oversea-entitlement-001'
        },
        required: ['siteIds'],
        response: { entitlement: entitlementExample }
      })
    },
    '/internal/v1/user-center/users/{userId}/oversea/ensure-subscription': {
      post: operation({
        tag: 'Internal User Operations',
        summary: '确保用户订阅与运行态就绪',
        description: '真实 Bearer 鉴权接口。普通用户只能操作 token subject 对应的 userId，且需要 oversea.subscription.ensure；跨用户管理需要同时具备 site-slot.manage 与 site-slot.execute。',
        operationId: 'ensureUserOverseaSubscription',
        scopes: ['oversea.subscription.ensure'],
        auth: 'internal-bearer',
        pathParams: ['userId'],
        request: {
          siteIds: ['oversea-main'],
          syncRuntime: true,
          includeYaml: false,
          requestedBy: 'mx-h2i',
          requestId: 'ensure-subscription-001'
        },
        response: {
          ensure: {
            ready: true,
            status: 'ready',
            reason: 'User Oversea subscription is ready.',
            generatedAt: '2026-07-20T00:00:00.000Z'
          },
          entitlement: entitlementExample,
          sync: { status: 'passed', reports: [], generatedAt: '2026-07-20T00:00:00.000Z' },
          subscription: {
            path: entitlementExample.subscriptionPath,
            contentType: 'text/yaml',
            generatedAt: '2026-07-20T00:00:00.000Z',
            yamlBytes: 2048
          }
        }
      })
    },
    '/internal/v1/user-center/users/{userId}/oversea/subscription.yaml': {
      get: operation({
        tag: 'Internal User Operations',
        summary: '下载当前用户的 mihomo YAML',
        description: '返回 text/yaml。普通用户只能下载自己的订阅；跨用户读取需要 Internal Admin scopes。禁止记录或转发 YAML 中的访问凭据。',
        operationId: 'downloadUserOverseaSubscription',
        scopes: ['oversea.subscription.ensure'],
        auth: 'internal-bearer',
        pathParams: ['userId'],
        response: 'mixed-port: 7788\nproxies:\n  - name: oversea-main\n    type: hysteria2\n    server: oversea.example.com'
      })
    },
    '/internal/v1/user-center/users/{userId}/oversea/sync-runtime': {
      post: operation({
        tag: 'Internal User Operations',
        summary: '把用户账号同步到远端 Oversea 主机',
        description: 'Internal 生成 entitlement 之后，目标主机上的 hysteria2 还不认这个账号，必须跑一次同步。'
          + '需要该站点有 active 的 oversea SSH profile、`SITE_SLOT_WORKER_REMOTE_SSH=1` 和 `confirmRemoteExecution: true`；'
          + '任一不满足会返回 status=blocked 并在 diagnosis.gateFailures 里列出原因，而不是静默失败。'
          + '`siteIds` 省略表示同步该用户的全部 active 站点。',
        operationId: 'syncUserOverseaRuntime',
        scopes: ['oversea.subscription.ensure'],
        auth: 'internal',
        pathParams: ['userId'],
        request: {
          siteIds: ['mx-oversea-hk01'],
          confirmRemoteExecution: true,
          requestedBy: 'desktop-admin',
          requestId: 'user-oversea-sync-001'
        },
        response: {
          sync: {
            status: 'passed',
            generatedAt: '2026-07-20T00:00:00.000Z',
            reports: [{
              reportId: 'useroverseasync_0001',
              userId: 'usr_partner_alice',
              siteId: 'mx-oversea-hk01',
              username: 'mx-oversea-hk01-alice',
              status: 'passed',
              exitCode: 0
            }]
          },
          entitlement: entitlementExample
        }
      })
    },
    '/internal/v1/user-center/users/{userId}/oversea/subscription-link': {
      post: operation({
        tag: 'Oversea Subscriptions',
        summary: '签发或轮换公开订阅链接',
        description: 'Clash 这类第三方客户端发不了 Bearer，所以给它一条 token 在路径里的只读地址。'
          + '**明文 token 只在本次响应返回**，之后只能读到元数据。轮换会立即吊销上一条链接。'
          + '返回的 path 需要自己拼域名：内网用 Internal origin，外网用公网 bootstrap 域名（裸 IP 的 https 在 Domestic ingress 上握手必失败）。',
        operationId: 'issueUserOverseaSubscriptionLink',
        scopes: ['oversea.subscription.ensure'],
        auth: 'internal',
        pathParams: ['userId'],
        request: { requestedBy: 'desktop-admin', requestId: 'oversea-link-001' },
        response: {
          link: {
            path: '/internal/v1/oversea-subscriptions/mx-v1-<token>.yaml',
            token: 'mx-v1-<仅本次响应返回的随机值>',
            tokenId: 'tok_0123456789abcdef',
            issuedAt: '2026-07-20T00:00:00.000Z',
            expiresAt: '2026-10-18T00:00:00.000Z',
            note: 'Copy this URL now; only its metadata is retrievable afterwards.'
          }
        }
      }),
      get: operation({
        tag: 'Oversea Subscriptions',
        summary: '查看公开链接的元数据',
        description: '只返回签发时间和过期时间，永远不会返回明文 token。没有链接时返回 null。',
        operationId: 'describeUserOverseaSubscriptionLink',
        scopes: ['oversea.subscription.ensure'],
        auth: 'internal',
        pathParams: ['userId'],
        response: { link: { issuedAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-10-18T00:00:00.000Z' } }
      }),
      delete: operation({
        tag: 'Oversea Subscriptions',
        summary: '吊销公开链接',
        description: '立即失效，使用该 URL 的第三方客户端会停止更新。H2O 走 Bearer，不受影响。',
        operationId: 'revokeUserOverseaSubscriptionLink',
        scopes: ['oversea.subscription.ensure'],
        auth: 'internal',
        pathParams: ['userId'],
        response: { revoked: 1 }
      })
    },
    '/internal/v1/oversea-subscriptions/{token}.yaml': {
      get: operation({
        tag: 'Oversea Subscriptions',
        summary: '公开的聚合订阅（Clash 直接粘这条）',
        description: '**URL 本身就是凭据**：路径里的 token 可吊销、只能读自己那份订阅，且不含 userId。'
          + '返回和 H2O 相同的多节点 YAML——`Oversea` 是 select 组，默认走列表第一个节点（平台默认站点），其余可手动切换。'
          + '这是唯一在公网 edge 放行的用户订阅形态；Bearer 保护的 user-center 订阅永远不会开到公网。'
          + '无效、过期或已吊销的 token 一律返回 404，不区分——避免探测出 token 是否存在过。',
        operationId: 'getPublicOverseaSubscription',
        auth: 'public',
        pathParams: ['token'],
        responseContentType: 'text/yaml',
        response: 'proxies:\n  - name: "mx-oversea-hk01-hysteria2"\n    type: hysteria2\nproxy-groups:\n  - name: Oversea\n    type: select\n    proxies:\n      - "mx-oversea-hk01-hysteria2"\n      - "oversea-main-hysteria2"\n      - DIRECT\nrules:\n  - MATCH,Oversea'
      })
    },
    '/internal/v1/site-slots/{siteId}/subscriptions/hysteria2/{username}.yaml': {
      get: operation({
        tag: 'Oversea Subscriptions',
        summary: '单站点单账号订阅',
        description: 'URL 即凭据的单节点订阅，用于只想连某一台机器的场景。'
          + '想要多节点和可切换，用上面的聚合链接；这条不会随 entitlement 增减节点而变化。'
          + '该历史路由只服务普通 access account；`*-subscriptions` 系统账号固定返回 404，必须走 ops-token + no-store reveal 后消费 Oversea Direct-IP URL。',
        operationId: 'getSiteSlotHysteria2Subscription',
        auth: 'public',
        pathParams: ['siteId', 'username'],
        responseContentType: 'text/yaml',
        response: 'proxies:\n  - name: "mx-oversea-hk01-hysteria2"\n    type: hysteria2\n    server: hk01.example.com'
      })
    },
    '/internal/v1/user-center/users/{userId}/h2o/runtime-profile': {
      get: operation({
        tag: 'Internal User Operations',
        summary: '读取 H2O 用户运行配置',
        description: 'H2O 运行配置属于 Internal 用户域，不应落到 Domestic 作为权威数据。',
        operationId: 'getUserH2oRuntimeProfile',
        auth: 'internal',
        pathParams: ['userId'],
        response: {
          profile: {
            profileId: 'h2oprof_partner_alice',
            userId: 'usr_partner_alice',
            appId: 'h2o',
            mode: 'rule',
            activeSubscriptionId: 'oversea-main',
            subscriptions: [],
            ports: { mixed: 7890, socks: 7891 },
            rules: [],
            updatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      }),
      post: operation({
        tag: 'Internal User Operations',
        summary: '保存 H2O 用户运行配置',
        description: '保存 mode、当前订阅、端口和规则。用户口令、token 等敏感字段不应写入 rules 或 attributes。',
        operationId: 'upsertUserH2oRuntimeProfile',
        auth: 'internal',
        pathParams: ['userId'],
        request: {
          mode: 'rule',
          activeSubscriptionId: 'oversea-main',
          ports: { mixed: 7890, socks: 7891 },
          rules: [{ type: 'domain-suffix', value: 'internal.mx', action: 'DIRECT' }],
          requestedBy: 'mx-h2i',
          requestId: 'h2o-profile-001'
        },
        response: {
          profile: {
            profileId: 'h2oprof_partner_alice',
            userId: 'usr_partner_alice',
            appId: 'h2o',
            mode: 'rule',
            activeSubscriptionId: 'oversea-main',
            ports: { mixed: 7890, socks: 7891 },
            rules: [{ type: 'domain-suffix', value: 'internal.mx', action: 'DIRECT' }],
            updatedAt: '2026-07-20T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/releases/products/resolve': {
      get: operation({
        tag: 'Release Consumer',
        summary: '按安装包身份解析发布产品',
        description: '用户端从自身 package.json 读取 packageName，并用它取得服务端登记的 productId、组件命名空间与可用 channel。不要列出所有应用后猜测，也不要从 Luopan 示例复制 productId。旧客户端继续显式发送 productId；两条路径兼容共存。packageName 未登记/产品停用返回 404，重复登记返回 409，避免误领其他应用版本。',
        operationId: 'resolveReleaseProduct',
        routeId: 'release.product.resolve',
        auth: 'internal-consumer',
        parameters: [
          queryParameter('packageName', '@qpjoy/luopan-demo', true, { maxLength: 240 }),
          queryParameter('channel', 'shadow', false, { pattern: '^[a-z0-9][a-z0-9._-]*$', maxLength: 64 })
        ],
        curl: 'curl -sS -G "$BASE/internal/v1/releases/products/resolve" --data-urlencode "packageName=@qpjoy/luopan-demo" --data-urlencode "channel=shadow"',
        response: {
          identity: {
            appId: 'luopan',
            productId: 'luopan',
            packageName: '@qpjoy/luopan-demo',
            launcherMode: 'standalone',
            networkProductId: 'luopan',
            componentId: 'luopan',
            rendererComponentId: 'luopan-renderer',
            channel: 'shadow',
            channels: ['shadow', 'beta', 'stable']
          }
        }
      })
    },
    '/internal/v1/release/check': {
      post: operation({
        tag: 'Release Consumer',
        summary: '检查当前安装可见的更新',
        description: '应用运行时的稳定入口。服务端按 productId、installId/userId、channel、platform、arch、可选 artifactKinds、gate 与灰度规则返回单安装决策，不暴露完整发布计划。artifactKinds 允许新客户端在同一 product component 上选择 app-asar 或 app-installer；旧客户端省略时保持历史匹配。外部产品必须传由 packageName 解析或旧版本地声明得到的 productId，避免派生组件名与其他产品碰撞。该接口用于登录前检查，因此不要求开发者 Bearer；installId/userId 是 rollout selector，不是安全身份，且只能经已建立的 Internal 产品网络访问。',
        operationId: 'checkReleaseUpdate',
        routeId: 'release.check',
        auth: 'internal-consumer',
        request: {
          installId: 'install_luopan_01',
          userId: 'usr_alice',
          productId: 'luopan',
          channel: 'shadow',
          platform: 'darwin',
          arch: 'arm64',
          artifactKinds: ['app-asar'],
          components: {
            luopan: '0.1.0',
            'luopan-renderer': '0.1.0'
          }
        },
        required: ['installId', 'productId', 'components'],
        response: {
          status: 'update-available',
          reason: 'matched a gated release',
          planId: 'relplan_luopan_020_canary',
          releaseId: 'luopan-installer-0.2.0',
          decision: {
            componentId: 'luopan',
            currentVersion: '0.1.0',
            targetVersion: '0.2.0',
            updateMode: 'mandatory'
          },
          artifacts: [{
            artifactId: 'artifact_luopan_020',
            componentId: 'luopan',
            version: '0.2.0',
            kind: 'app-installer',
            url: '/internal/v1/release-artifacts/artifact_luopan_020/download/Luopan-0.2.0-arm64.dmg',
            digest: 'sha256:<digest>',
            sizeBytes: 104857600,
            platform: 'darwin',
            arch: 'arm64',
            activation: 'installer-manual'
          }],
          rollout: { matchedBy: 'target-list', bucket: 7 },
          deliveryMode: 'prompt-download-restart',
          signedAt: '2026-07-28T00:00:00.000Z',
          signature: {
            algorithm: 'hmac-sha256',
            keyId: 'release-decision-v1',
            value: '<server-hmac>'
          }
        }
      })
    },
    '/internal/v1/releases/history': {
      get: operation({
        tag: 'Release Consumer',
        summary: '读取已通过 gate 的全量版本历史',
        description: '只返回指定组件、通道、平台与架构下已经 gate=passed 且 rollout=100 的公开版本；不返回 canary audience 或未发布计划。',
        operationId: 'listReleaseHistory',
        routeId: 'release.history',
        auth: 'internal-consumer',
        parameters: [
          queryParameter('componentId', 'luopan', true),
          queryParameter('channel', 'shadow', false),
          queryParameter('platform', 'darwin', false),
          queryParameter('arch', 'arm64', false),
          queryParameter('limit', 8, false)
        ],
        curl: 'curl -sS "$BASE/internal/v1/releases/history?componentId=luopan&channel=shadow&platform=darwin&arch=arm64&limit=8"',
        response: {
          releases: [{
            releaseId: 'luopan-installer-0.2.0',
            productId: 'luopan',
            version: '0.2.0',
            channel: 'shadow',
            status: 'ready',
            artifactKind: 'app-installer',
            deliveryMode: 'prompt-download-restart',
            platform: 'darwin',
            arch: 'arm64',
            artifactDigest: 'sha256:<digest>',
            gate: 'passed'
          }]
        }
      })
    },
    '/internal/v1/release/reports': {
      post: operation({
        tag: 'Release Consumer',
        summary: '上报更新执行结果',
        description: '客户端在 downloaded、staged、installer-opened、installer-completed、failed 或 rollback 等阶段写入遥测。报告未绑定已认证身份，必须视为不可信 telemetry，不能单独作为审批证据；不得在 metadata 中放 token、密码或上游订阅。',
        operationId: 'reportReleaseExecution',
        routeId: 'release.report',
        auth: 'internal-consumer',
        request: {
          installId: 'install_luopan_01',
          status: 'installer-completed',
          metadata: {
            releaseId: 'luopan-installer-0.2.0',
            componentId: 'luopan',
            version: '0.2.0'
          }
        },
        required: ['installId', 'status'],
        response: {
          auditEvent: {
            eventId: 'audit_release_001',
            eventType: 'release.report.received',
            installId: 'install_luopan_01',
            createdAt: '2026-07-28T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/release-artifacts/{artifactId}/download/{fileName}': {
      get: operation({
        tag: 'Release Consumer',
        summary: '下载并校验发布制品',
        description: '使用 release/check 返回的 URL 下载。Internal PVC 返回二进制；私有 OSS 返回 302 到短期签名 URL。客户端必须同时校验 Content-Length/sizeBytes 与 sha256 digest。',
        operationId: 'downloadReleaseArtifact',
        routeId: 'release.artifact.download',
        auth: 'internal-consumer',
        pathParams: ['artifactId', 'fileName'],
        response: '<binary artifact>',
        responseContentType: 'application/octet-stream',
        responseSchema: { type: 'string', format: 'binary' }
      })
    },
    '/internal/v1/sdk/releases/artifacts': {
      post: operation({
        tag: 'Release Publisher',
        summary: '上传产品发布制品',
        description: '仅 product-scoped service account 可调用。body 是原始二进制；app-installer/app-asar 的 componentId 必须精确等于 productId，renderer-ui 必须精确等于 productId-renderer。app-asar 必须使用 .asar 文件并携带 platform/arch，激活方式固定为 restart-auto。productId 不能以保留后缀 -renderer/-config 结尾，且两个派生组件名不能与已启用 AppCenter 产品冲突。storage 由平台配置决定，调用方不能选择；OSS 对象按完整 SHA-256 内容寻址。当前稳定开发者契约支持 app-installer、app-asar 与 renderer-ui。',
        operationId: 'uploadSdkReleaseArtifact',
        routeId: 'sdk.release_artifacts.upload',
        scopes: ['sdk.release.publish', 'release.manage'],
        auth: 'internal-bearer',
        parameters: [
          queryParameter('productId', 'luopan', true, { pattern: '^[a-z0-9][a-z0-9._-]*$', maxLength: 120 }),
          queryParameter('releaseId', 'luopan-installer-0.2.0', true, { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', maxLength: 160 }),
          queryParameter('componentId', 'luopan', true),
          queryParameter('kind', 'app-installer', true),
          queryParameter('version', '0.2.0', true),
          queryParameter('channel', 'shadow', false, { pattern: '^[a-z0-9][a-z0-9._-]*$', maxLength: 64 }),
          queryParameter('platform', 'darwin', false),
          queryParameter('arch', 'arm64', false),
          queryParameter('fileName', 'Luopan-0.2.0-arm64.dmg', true),
          queryParameter('digest', 'sha256:<digest>', true)
        ],
        request: '<binary artifact>',
        requestContentType: 'application/octet-stream',
        requestSchema: { type: 'string', format: 'binary' },
        curl: [
          'curl -sS -X POST "$BASE/internal/v1/sdk/releases/artifacts?productId=luopan&releaseId=luopan-installer-0.2.0&componentId=luopan&kind=app-installer&version=0.2.0&channel=shadow&platform=darwin&arch=arm64&fileName=Luopan-0.2.0-arm64.dmg&digest=sha256:$SHA256" \\',
          '  -H "Authorization: Bearer $TOKEN" \\',
          '  -H "content-type: application/octet-stream" \\',
          '  --data-binary "@$ARTIFACT"'
        ].join('\n'),
        response: {
          artifact: {
            artifactId: 'artifact_luopan_app-installer_0.2.0_<identity>_<sha256hex>',
            releaseId: 'luopan-installer-0.2.0',
            productId: 'luopan',
            componentId: 'luopan',
            kind: 'app-installer',
            version: '0.2.0',
            digest: 'sha256:<digest>',
            sizeBytes: 104857600,
            platform: 'darwin',
            arch: 'arm64',
            fileName: 'Luopan-0.2.0-arm64.dmg',
            storage: 'oss',
            url: '/internal/v1/release-artifacts/<artifactId>/download/Luopan-0.2.0-arm64.dmg'
          }
        }
      })
    },
    '/internal/v1/sdk/releases/artifacts/{artifactId}': {
      get: operation({
        tag: 'Release Publisher',
        summary: '读取已上传制品元数据',
        description: '只允许读取服务账号 allowedProductIds 中的制品。返回服务端登记的 digest、size、platform、arch 与下载引用。',
        operationId: 'getSdkReleaseArtifact',
        routeId: 'sdk.release_artifacts.get',
        scopes: ['sdk.release.read', 'sdk.release.publish', 'sdk.release.approve', 'release.manage'],
        auth: 'internal-bearer',
        pathParams: ['artifactId'],
        response: {
          artifact: {
            artifactId: 'artifact_luopan_020',
            productId: 'luopan',
            componentId: 'luopan',
            version: '0.2.0',
            digest: 'sha256:<digest>',
            sizeBytes: 104857600,
            platform: 'darwin',
            arch: 'arm64'
          }
        }
      })
    },
    '/internal/v1/sdk/releases': {
      get: operation({
        tag: 'Release Publisher',
        summary: '列出当前产品发布计划',
        description: 'productId 必填；服务端按 allowedProductIds 过滤，Luopan 发布者无法读取 MX-H2I 计划。',
        operationId: 'listSdkReleases',
        routeId: 'sdk.releases.list',
        scopes: ['sdk.release.read', 'sdk.release.publish', 'sdk.release.approve', 'release.manage'],
        auth: 'internal-bearer',
        parameters: [queryParameter('productId', 'luopan', true)],
        curl: 'curl -sS "$BASE/internal/v1/sdk/releases?productId=luopan" -H "Authorization: Bearer $TOKEN"',
        response: {
          plans: [{
            planId: 'relplan_luopan_020_canary',
            releaseId: 'luopan-installer-0.2.0',
            productId: 'luopan',
            channel: 'shadow',
            requestId: 'luopan-0.2.0-canary-001',
            rollout: { strategy: 'manual-ring', percentage: 0, audience: { installIds: ['install_canary'] } },
            test: { gate: { verdict: 'blocked' } }
          }]
        }
      }),
      post: operation({
        tag: 'Release Publisher',
        summary: '从已上传制品创建 gated 发布',
        description: '只接受平台 artifactId；releaseId、product、component、URL、digest、size、platform、arch 与 createdBy 均由服务端派生。deliveryMode 可选 prompt-download-restart（弹窗要求立即处理）、manual-download（仅红点/更新卡片，用户手动下载）、silent-download-next-start（仅 ASAR 静默下载，下次启动生效）；安装包不允许 silent。requestId 必填并作为幂等键：相同请求返回原计划，内容变化返回 400。同一 artifactId 可用新的 requestId 创建 canary 与全量计划。新计划的 E2E run 为 running，对外 gate verdict 为 blocked，审批通过后才可消费。',
        operationId: 'createSdkRelease',
        routeId: 'sdk.releases.create',
        scopes: ['sdk.release.publish', 'release.manage'],
        auth: 'internal-bearer',
        request: {
          artifactId: 'artifact_luopan_020',
          currentVersion: '0.1.0',
          channel: 'shadow',
          rolloutStrategy: 'manual-ring',
          rolloutPercentage: 0,
          targetInstallIds: ['install_canary'],
          deliveryMode: 'prompt-download-restart',
          releaseNotes: 'Luopan 0.2.0 canary',
          requestId: 'luopan-0.2.0-canary-001'
        },
        required: ['artifactId', 'currentVersion', 'requestId'],
        response: {
          plan: {
            planId: 'relplan_luopan_020_canary',
            releaseId: 'luopan-installer-0.2.0',
            productId: 'luopan',
            channel: 'shadow',
            createdBy: 'service-account:svc_release_luopan',
            requestId: 'luopan-0.2.0-canary-001',
            deliveryMode: 'prompt-download-restart',
            artifacts: [{ componentId: 'luopan', digest: 'sha256:<digest>', activation: 'installer-manual' }],
            test: { gate: { verdict: 'blocked' } }
          },
          idempotent: false
        }
      })
    },
    '/internal/v1/release-management/plans/{planId}': {
      patch: operation({
        tag: 'Release Publisher',
        summary: 'Admin 修改发布说明、应用方式与灰度参数',
        description: 'Internal ops 管理接口；不允许修改 artifact 身份、digest、平台、架构或目标版本。可更新 releaseNotes、channel、deliveryMode、rollout strategy/percentage/rings、featureKeys 与目标 user/install。旧计划没有 deliveryMode 时按 prompt-download-restart；installer 计划可以 prompt 或 manual，但请求 silent 会强制为 prompt。',
        operationId: 'updateReleaseManagementPlan',
        routeId: 'release.management_plan.update',
        auth: 'internal',
        pathParams: ['planId'],
        request: {
          releaseNotes: '修复 Windows PAC 并改善首次启动',
          deliveryMode: 'manual-download',
          rolloutStrategy: 'gray',
          rolloutPercentage: 10,
          rolloutRings: ['internal-dogfood', 'canary', 'stable'],
          featureKeys: ['luopan.release.app-asar'],
          targetUserIds: [],
          targetInstallIds: [],
          updatedBy: 'desktop-admin',
          requestId: 'release-edit-001'
        },
        response: {
          plan: {
            planId: 'relplan_luopan_020_canary',
            releaseId: 'luopan-asar-0.2.0',
            productId: 'luopan',
            deliveryMode: 'manual-download',
            updatedBy: 'desktop-admin',
            updatedAt: '2026-07-30T00:00:00.000Z'
          }
        }
      })
    },
    '/internal/v1/sdk/releases/{planId}': {
      get: operation({
        tag: 'Release Publisher',
        summary: '读取单个发布计划',
        description: '读取完整 gate、rollout、artifact 与决策证据；仍按服务账号 allowedProductIds 做产品隔离。',
        operationId: 'getSdkRelease',
        routeId: 'sdk.releases.get',
        scopes: ['sdk.release.read', 'sdk.release.publish', 'sdk.release.approve', 'release.manage'],
        auth: 'internal-bearer',
        pathParams: ['planId'],
        response: {
          plan: {
            planId: 'relplan_luopan_020_canary',
            releaseId: 'luopan-installer-0.2.0',
            productId: 'luopan',
            test: { gate: { verdict: 'blocked' } },
            decisions: { readyToPromote: false, requiresApproval: true }
          }
        }
      })
    },
    '/internal/v1/sdk/releases/{planId}/gate': {
      post: operation({
        tag: 'Release Publisher',
        summary: '完成发布验证 gate',
        description: '需要独立 approve scope；status 只接受 passed、failed 或 blocked。requestedBy 不能由调用方伪造，服务端使用 Bearer principal。evidence 最大 32 KiB、嵌套最多 4 层，禁止 secret/token/password/credential 等敏感字段，也不要提交环境转储或原始日志。passed/failed 是终态，显式 blocked 也终止本次验证；相同终态重试返回原 plan，改变结果必须新建 plan。Postgres 按 plan 与 test run 事务串行审批。建议先以受控 CI/人工验证证据完成定向真机验证，再 passed；全量计划使用同一 artifactId 和新的 requestId 创建。',
        operationId: 'completeSdkReleaseGate',
        routeId: 'sdk.releases.gate',
        scopes: ['sdk.release.approve', 'release.manage'],
        auth: 'internal-bearer',
        pathParams: ['planId'],
        request: {
          status: 'passed',
          message: 'macOS arm64 canary passed',
          evidence: {
            installId: 'install_canary',
            installerCompleted: true
          },
          requestId: 'luopan-0.2.0-canary-gate-001'
        },
        required: ['status', 'requestId'],
        response: {
          plan: {
            planId: 'relplan_luopan_020_canary',
            productId: 'luopan',
            test: { gate: { verdict: 'passed' } },
            decisions: { readyToPromote: true, requiresApproval: true }
          }
        }
      })
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'MX access token',
        description: 'MX token returned by password/client_credentials or Feishu OAuth exchange; never use a Feishu upstream token here.'
      }
    }
  },
  'x-mx-context': {
    authority: 'V2 MX-H2I uses Internal as the control-plane authority for users, permissions, DNS and configuration.',
    compatibility: 'V1 HDO remains online through electron-server and /api/v1/hdo/*; it is a compatibility surface, not the target integration contract.',
    publicBoundary: 'Port 18090 is an Internal/Domestic-relay surface. Do not publish it directly to the public Internet. '
      + 'Only a strict allowlist reaches the public edge: /healthz, the OAuth bootstrap routes, GET launcher-network/products/{id}, '
      + 'and the two URL-is-the-credential subscription shapes (oversea-subscriptions/{token}.yaml and site-slots/.../hysteria2/{user}.yaml). '
      + 'The Bearer-guarded user-center subscription must never be added to that allowlist.',
    onlinePath: '/docs/api/',
    openApiPath: '/docs/api/openapi.json',
    markdownPath: '/docs/api/mx-launcher-api.md'
  }
};

interface OperationInput {
  tag: string;
  summary: string;
  description: string;
  operationId: string;
  routeId?: string;
  scopes?: string[];
  auth: AuthMode;
  request?: unknown;
  requestContentType?: string;
  requestSchema?: JsonRecord;
  required?: string[];
  pathParams?: string[];
  parameters?: JsonRecord[];
  responseContentType?: string;
  responseSchema?: JsonRecord;
  curl?: string;
  response: unknown;
}

function operation(input: OperationInput): ApiOperation {
  const result: ApiOperation = {
    tags: [input.tag],
    summary: input.summary,
    description: input.description,
    operationId: input.operationId,
    security: input.auth === 'bearer' || input.auth === 'internal-bearer'
      ? [{ bearerAuth: [] }]
      : [],
    responses: {
      '200': responseContent(input.response, input.responseContentType, input.responseSchema),
      '400': {
        description: 'Invalid request',
        content: {
          'application/json': {
            schema: schemaFromExample({ statusCode: 400, message: 'Invalid request', error: 'Bad Request' })
          }
        }
      }
    },
    'x-accepted-scopes': input.scopes ?? [],
    'x-mx-auth': authDescription(input.auth)
  };
  if (input.routeId) result['x-route-id'] = input.routeId;
  if (input.curl) result['x-mx-curl'] = input.curl;
  const pathParameters = (input.pathParams ?? []).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' }
  }));
  const parameters = [...pathParameters, ...(input.parameters ?? [])];
  if (parameters.length > 0) result.parameters = parameters;
  if (input.request !== undefined) {
    const contentType = input.requestContentType ?? 'application/json';
    result.requestBody = {
      required: true,
      content: {
        [contentType]: {
          schema: input.requestSchema ?? schemaFromExample(input.request, input.required),
          ...(contentType === 'application/octet-stream' ? {} : { example: input.request })
        }
      }
    };
  }
  return result;
}

function queryParameter(
  name: string,
  example: string | number,
  required: boolean,
  constraints: JsonRecord = {}
): JsonRecord {
  return {
    name,
    in: 'query',
    required,
    schema: {
      type: typeof example === 'number' ? 'integer' : 'string',
      example,
      ...constraints
    }
  };
}

function responseContent(example: unknown, explicitContentType?: string, explicitSchema?: JsonRecord): JsonRecord {
  const contentType = explicitContentType ?? (typeof example === 'string' ? 'text/yaml' : 'application/json');
  return {
    description: 'Successful response',
    content: {
      [contentType]: {
        schema: explicitSchema ?? schemaFromExample(example),
        ...(contentType === 'application/octet-stream' ? {} : { example })
      }
    }
  };
}

function schemaFromExample(value: unknown, required?: string[]): JsonRecord {
  if (value === null) return { type: ['null', 'object'] };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items: value.length > 0 ? schemaFromExample(value[0]) : {}
    };
  }
  if (typeof value === 'object') {
    const properties = Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, item]) => [key, schemaFromExample(item)])
    );
    return {
      type: 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {})
    };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function authDescription(auth: AuthMode): string {
  if (auth === 'public') return '公开发现或登录入口；仍只应部署在受控网络。';
  if (auth === 'internal-consumer') return '无需 Publisher 凭据；仅允许应用经已建立的 Internal 产品网络调用。';
  if (auth === 'token-body') return '在 JSON body 中传 token，接口会对 token 做实际校验。';
  if (auth === 'bearer') return '契约要求 Bearer 与 route scopes；V1 shadow 尚未对所有 SDK route 强制 header guard。';
  if (auth === 'internal-bearer') return 'Internal 网络 + 实际 Bearer 校验。';
  if (auth === 'ops-token') return 'Internal 网络 + x-mx-ops-token；缺少或错误 token 会被拒绝。';
  return '仅 Internal/ops 网络；当前依赖网络隔离，禁止发布到公网。';
}

const httpMethods = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface CollectedOperation {
  method: string;
  path: string;
  operation: ApiOperation;
}

function collectOperations(document: ApiDocsDocument): CollectedOperation[] {
  const operations: CollectedOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of httpMethods) {
      const item = pathItem[method];
      if (item) operations.push({ method: method.toUpperCase(), path, operation: item });
    }
  }
  return operations;
}

export function renderApiDocsHtml(document: ApiDocsDocument): string {
  const operations = collectOperations(document);
  const tagSections = document.tags.map((tag) => {
    const tagged = operations.filter((item) => item.operation.tags.includes(tag.name));
    if (tagged.length === 0) return '';
    return [
      '<section class="tag-section" id="' + htmlId(tag.name) + '">',
      '<div class="section-heading"><div><span class="eyebrow">API GROUP</span><h2>' + escapeHtml(tag.name) + '</h2></div><p>' + escapeHtml(tag.description) + '</p></div>',
      tagged.map(renderOperationCard).join(''),
      '</section>'
    ].join('');
  }).join('');
  const navigation = document.tags.map((tag) => {
    const count = operations.filter((item) => item.operation.tags.includes(tag.name)).length;
    return count > 0
      ? '<a href="#' + htmlId(tag.name) + '"><span>' + escapeHtml(tag.name) + '</span><b>' + count + '</b></a>'
      : '';
  }).join('');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(document.info.title) + '</title>',
    '<style>' + apiDocsCss() + '</style></head><body>',
    '<header class="hero"><div class="hero-inner"><div class="brand">MX<span>H2I</span></div>',
    '<div class="hero-copy"><div class="badges"><span>V2 · Internal authority</span><span>OpenAPI ' + escapeHtml(document.openapi) + '</span><span>port 18090</span></div>',
    '<h1>MX Launcher<br>Integration API</h1>',
    '<p>面向第三方系统的用户中心、权限中心、Release Center 与 SDK Gateway 交付文档。V2 配置和身份真相均在 Internal。</p>',
    '<div class="actions"><a class="primary" href="/docs/api/openapi.json" download>导出 OpenAPI JSON</a>',
    '<a href="/docs/api/mx-launcher-api.md">导出 Markdown</a><button type="button" id="print-doc">打印 / PDF</button></div></div></div></header>',
    '<div class="layout"><aside><label for="api-search">搜索 API</label><input id="api-search" type="search" placeholder="路径、用途、scope…">',
    '<nav>' + navigation + '</nav><div class="aside-note"><b>Base URL</b><code id="base-url">http://&lt;internal-host&gt;:18090</code></div></aside>',
    '<main><section class="overview">',
    '<article><span>01 · Authority</span><h3>V2 以 Internal 为中心</h3><p>用户、RBAC、权限、DNS 与 H2O 配置由 mx-launcher/server 管理。Domestic 只做代理、relay、缓存和观测转发。</p></article>',
    '<article><span>02 · Integration</span><h3>第三方优先走 SDK Gateway</h3><p>稳定入口是 <code>/internal/v1/sdk/*</code>，包括产品隔离的 Release Publisher；<code>/internal/v1/user-center/*</code> 是受信任的运维面。</p></article>',
    '<article><span>03 · Compatibility</span><h3>V1 HDO 保持在线</h3><p><code>electron-server /api/v1/hdo/*</code> 是兼容面，不应成为新系统依赖的目标契约。</p></article>',
    '</section>',
    '<section class="warning"><strong>部署边界</strong><p>18090 只能位于 Internal 网络或 Domestic relay 后。V1 shadow 尚未对全部 SDK route 强制 Bearer header guard；生产接入必须同时使用网络隔离，并在调用前按 routeId 做 access evaluate。</p></section>',
    '<section class="quickstart"><div class="section-heading"><div><span class="eyebrow">QUICK START</span><h2>推荐调用顺序</h2></div></div>',
    '<ol><li><b>发现</b><span>读取 gateway manifest 与 routeId。</span></li><li><b>登录</b><span>password 或 client_credentials 获取 mx-sdk token。</span></li><li><b>授权</b><span>用 access/evaluate 校验 route scope 与 AppCenter policy。</span></li><li><b>调用</b><span>通过 SDK route 访问用户或权限能力。</span></li></ol></section>',
    '<div id="api-empty" hidden>没有匹配的 API。</div>',
    tagSections,
    '</main></div>',
    '<footer><span>MX Launcher · API contract ' + escapeHtml(document.info.version) + '</span><span>源代码随构建交付，不依赖外部 CDN。</span></footer>',
    '<script>' + apiDocsScript() + '</script></body></html>'
  ].join('');
}

function renderOperationCard(item: CollectedOperation): string {
  const operation = item.operation;
  const requestExample = operation.requestBody
    ? contentExample((operation.requestBody.content as JsonRecord) ?? {})
    : undefined;
  const response = operation.responses['200'];
  const responseExample = response ? contentExample((response.content as JsonRecord) ?? {}) : undefined;
  const scopes = operation['x-accepted-scopes'];
  const search = [
    item.method,
    item.path,
    operation.summary,
    operation.description,
    operation['x-route-id'] ?? '',
    ...scopes
  ].join(' ').toLowerCase();
  const curl = curlExample(item.method, item.path, operation, requestExample);
  return [
    '<article class="operation" data-search="' + escapeHtml(search) + '">',
    '<div class="op-head"><span class="method ' + item.method.toLowerCase() + '">' + item.method + '</span>',
    '<code class="path">' + escapeHtml(item.path) + '</code>',
    '<button class="copy" type="button" data-copy="' + encoded(curl) + '">复制 curl</button></div>',
    '<div class="op-body"><h3>' + escapeHtml(operation.summary) + '</h3><p>' + escapeHtml(operation.description) + '</p>',
    '<div class="meta">',
    operation['x-route-id'] ? '<span><b>routeId</b> ' + escapeHtml(operation['x-route-id']) + '</span>' : '',
    scopes.length > 0 ? '<span><b>scopes 任一</b> ' + scopes.map(escapeHtml).join(' · ') + '</span>' : '',
    '<span><b>鉴权</b> ' + escapeHtml(operation['x-mx-auth']) + '</span>',
    '</div>',
    '<details><summary>调用示例</summary><div class="examples">',
    '<div><div class="code-title">curl</div><pre><code>' + escapeHtml(curl) + '</code></pre></div>',
    requestExample !== undefined ? '<div><div class="code-title">Request JSON</div><pre><code>' + escapeHtml(pretty(requestExample)) + '</code></pre></div>' : '',
    '<div><div class="code-title">200 Response</div><pre><code>' + escapeHtml(pretty(responseExample)) + '</code></pre></div>',
    '</div></details></div></article>'
  ].join('');
}

function contentExample(content: JsonRecord): unknown {
  const entry = Object.values(content)[0] as JsonRecord | undefined;
  return entry?.example;
}

function curlExample(method: string, path: string, operation: ApiOperation, request: unknown): string {
  if (operation['x-mx-curl']) return operation['x-mx-curl'];
  const lines = ['curl -sS -X ' + method + ' \"$BASE' + path + '\"'];
  if (operation.security.length > 0) lines.push('  -H \"Authorization: Bearer $TOKEN\"');
  if (request !== undefined) {
    const requestContentType = Object.keys((operation.requestBody?.content as JsonRecord | undefined) ?? {})[0]
      ?? 'application/json';
    lines.push('  -H \"content-type: ' + requestContentType + '\"');
    if (requestContentType === 'application/octet-stream') lines.push('  --data-binary \"@$ARTIFACT\"');
    else lines.push('  --data ' + shellQuote(pretty(request)));
  }
  return lines.join(' \\\n');
}

function shellQuote(value: string): string {
  return '\'' + value.replace(/'/g, '\'\"\'\"\'') + '\'';
}

function pretty(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function apiDocsCss(): string {
  return [
    ':root{--ink:#14211d;--muted:#60716a;--paper:#f5f2ea;--card:#fffdfa;--line:#d8ddd4;--green:#0f6b4f;--green2:#15a475;--orange:#f08a4b;--navy:#17324d;--code:#10221b;color-scheme:light}',
    '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    'code,pre{font-family:"SFMono-Regular",Consolas,monospace}.hero{background:radial-gradient(circle at 78% 20%,#244d42 0,transparent 30%),linear-gradient(125deg,#10221b,#17382d 62%,#142b35);color:white;border-bottom:5px solid var(--orange)}',
    '.hero-inner{max-width:1420px;margin:auto;padding:58px 44px 64px;display:grid;grid-template-columns:220px 1fr;gap:52px}.brand{font-weight:900;font-size:24px;letter-spacing:-1px}.brand span{color:#6ee7b7}.badges{display:flex;gap:9px;flex-wrap:wrap}.badges span{border:1px solid #ffffff35;border-radius:999px;padding:5px 10px;color:#d7f6e9;font-size:12px}',
    'h1{font-size:clamp(42px,7vw,86px);line-height:.93;letter-spacing:-5px;margin:25px 0 23px;max-width:820px}.hero-copy>p{max-width:730px;color:#c6d7d0;font-size:18px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}.actions a,.actions button{appearance:none;border:1px solid #ffffff48;background:#ffffff0d;color:white;padding:11px 15px;border-radius:8px;text-decoration:none;font:inherit;cursor:pointer}.actions .primary{background:#6ee7b7;color:#10221b;border-color:#6ee7b7;font-weight:700}',
    '.layout{max-width:1420px;margin:0 auto;display:grid;grid-template-columns:260px minmax(0,1fr);gap:46px;padding:42px 44px 80px}aside{position:sticky;top:0;align-self:start;padding-top:8px}aside label{display:block;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}aside input{width:100%;border:1px solid var(--line);border-radius:8px;background:white;padding:12px 13px;font:inherit;outline:none}aside input:focus{border-color:var(--green2);box-shadow:0 0 0 3px #15a47520}nav{display:grid;margin:22px 0;border-top:1px solid var(--line)}nav a{display:flex;justify-content:space-between;color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line);padding:12px 3px}nav b{font-size:12px;background:#dfe7e1;border-radius:20px;padding:1px 8px}.aside-note{font-size:12px;color:var(--muted)}.aside-note b,.aside-note code{display:block}.aside-note code{margin-top:5px;word-break:break-all;color:var(--green)}',
    'main{min-width:0}.overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.overview article{min-width:0;background:var(--card);border:1px solid var(--line);padding:22px;border-radius:12px}.overview span,.eyebrow{font-size:11px;letter-spacing:.12em;color:var(--green);font-weight:800}.overview h3{margin:8px 0;font-size:18px}.overview p{margin:0;color:var(--muted)}.warning{background:#fff7ed;border:1px solid #fed7aa;border-left:5px solid var(--orange);padding:18px 20px;margin:22px 0;border-radius:8px}.warning p{margin:4px 0 0;color:#7c4b2c}',
    '.section-heading{display:flex;justify-content:space-between;align-items:end;gap:30px;margin:54px 0 18px;border-bottom:2px solid var(--ink);padding-bottom:13px}.section-heading h2{font-size:30px;letter-spacing:-1px;margin:4px 0 0}.section-heading>p{max-width:540px;margin:0;color:var(--muted)}.quickstart ol{list-style:none;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}.quickstart li{min-width:0;background:var(--card);padding:17px}.quickstart b,.quickstart span{display:block}.quickstart span{color:var(--muted);font-size:13px;margin-top:4px}',
    '.operation{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:11px;margin:12px 0;overflow:hidden;box-shadow:0 8px 30px #13231c08}.op-head{display:flex;align-items:center;gap:12px;padding:12px 15px;border-bottom:1px solid var(--line);background:#fbfaf6}.method{min-width:66px;text-align:center;padding:4px 8px;border-radius:5px;color:white;font:bold 12px/1.4 monospace}.method.get{background:var(--green)}.method.post{background:var(--navy)}.method.put,.method.patch{background:#8b5b18}.method.delete{background:#9f3030}.path{font-size:14px;overflow-wrap:anywhere;color:var(--ink)}.copy{margin-left:auto;border:0;background:transparent;color:var(--green);cursor:pointer;font-weight:700}.op-body{min-width:0;padding:20px}.op-body h3{margin:0 0 6px;font-size:20px}.op-body>p{margin:0;color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.meta span{background:#edf1ed;border-radius:5px;padding:5px 8px;font-size:12px}.meta b{color:var(--green)}details{min-width:0;margin-top:17px;border-top:1px solid var(--line);padding-top:13px}summary{cursor:pointer;font-weight:700;color:var(--green)}.examples{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin-top:12px}.examples>div{min-width:0}.code-title{background:#183127;color:#b9d8ca;padding:6px 11px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;border-radius:8px 8px 0 0}pre{max-width:100%;margin:0;background:var(--code);color:#d8f6e8;padding:15px;overflow:auto;border-radius:0 0 8px 8px;font-size:12px;line-height:1.55}',
    '#api-empty{padding:40px;text-align:center;color:var(--muted)}footer{border-top:1px solid var(--line);padding:25px 44px;display:flex;justify-content:space-between;color:var(--muted);font-size:12px}',
    '@media(max-width:900px){.hero-inner{grid-template-columns:minmax(0,1fr)}.layout{grid-template-columns:minmax(0,1fr)}aside{position:static}.overview{grid-template-columns:minmax(0,1fr)}.quickstart ol{grid-template-columns:repeat(2,minmax(0,1fr))}.section-heading{align-items:start;flex-direction:column}.brand{display:none}}',
    '@media(max-width:560px){.hero-inner,.layout{padding-left:20px;padding-right:20px}h1{letter-spacing:-3px}.quickstart ol{grid-template-columns:minmax(0,1fr)}.op-head{align-items:flex-start;flex-wrap:wrap}.copy{margin-left:0}.path{width:calc(100% - 82px)}footer{padding:20px;display:grid;gap:5px}}',
    '@media print{aside,.actions,.copy,.warning{display:none!important}.hero{background:white;color:var(--ink);border-bottom:2px solid var(--ink)}.hero-inner{display:block;padding:20px}.hero-copy>p{color:var(--muted)}.layout{display:block;padding:20px}.overview{grid-template-columns:repeat(3,1fr)}details{display:block}details>summary{display:none}details>.examples{display:grid}.operation{break-inside:avoid;box-shadow:none}pre{white-space:pre-wrap;color:#111;background:#eee}.tag-section{break-before:page}footer{padding:20px}}'
  ].join('');
}

function apiDocsScript(): string {
  return [
    'const search=document.getElementById("api-search");',
    'const cards=[...document.querySelectorAll(".operation")];',
    'const empty=document.getElementById("api-empty");',
    'function filter(){const q=search.value.trim().toLowerCase();let visible=0;cards.forEach(card=>{const show=!q||card.dataset.search.includes(q);card.hidden=!show;if(show)visible+=1});document.querySelectorAll(".tag-section").forEach(section=>{section.hidden=![...section.querySelectorAll(".operation")].some(card=>!card.hidden)});empty.hidden=visible!==0}',
    'search.addEventListener("input",filter);',
    'document.getElementById("print-doc").addEventListener("click",()=>window.print());',
    'document.getElementById("base-url").textContent=window.location.origin;',
    'document.querySelectorAll("[data-copy]").forEach(button=>button.addEventListener("click",async()=>{const value=new TextDecoder().decode(Uint8Array.from(atob(button.dataset.copy),c=>c.charCodeAt(0))).replaceAll("$BASE",window.location.origin);await navigator.clipboard.writeText(value);const old=button.textContent;button.textContent="已复制";setTimeout(()=>button.textContent=old,1200)}));'
  ].join('');
}

export function renderApiDocsMarkdown(document: ApiDocsDocument): string {
  const operations = collectOperations(document);
  const tick = String.fromCharCode(96);
  const fence = tick + tick + tick;
  const lines = [
    '# ' + document.info.title,
    '',
    '> Contract version: ' + document.info.version + ' · OpenAPI ' + document.openapi,
    '',
    '## 交付入口',
    '',
    '- 在线文档：' + tick + document['x-mx-context'].onlinePath + tick,
    '- OpenAPI JSON：' + tick + document['x-mx-context'].openApiPath + tick,
    '- Markdown：' + tick + document['x-mx-context'].markdownPath + tick,
    '- Base URL：' + tick + 'http://<internal-host>:18090' + tick,
    '',
    '## 架构与边界',
    '',
    '- ' + document['x-mx-context'].authority,
    '- ' + document['x-mx-context'].compatibility,
    '- ' + document['x-mx-context'].publicBoundary,
    '- 第三方系统优先使用 ' + tick + '/internal/v1/sdk/*' + tick + '；Internal 运维才使用 ' + tick + '/internal/v1/user-center/*' + tick + '。',
    '- V1 shadow 尚未对全部 SDK route 强制 Bearer header guard；生产接入必须保留网络隔离，并先调用 access evaluate。',
    '',
    '## 推荐流程',
    '',
    '1. 读取 ' + tick + '/internal/v1/sdk/gateway/manifest' + tick + '。',
    '2. 调用 ' + tick + '/internal/v1/sdk/oauth/token' + tick + ' 获取 mx-sdk token。',
    '3. 使用 ' + tick + '/internal/v1/sdk/gateway/access/evaluate' + tick + ' 校验 routeId 与 AppCenter policy。',
    '4. 调用用户中心或权限中心 SDK route。',
    '',
    '## API 索引',
    '',
    '| Method | Path | 用途 | routeId |',
    '| --- | --- | --- | --- |',
    ...operations.map((item) => '| ' + item.method + ' | ' + tick + item.path + tick + ' | ' + markdownCell(item.operation.summary) + ' | ' + (item.operation['x-route-id'] ? tick + item.operation['x-route-id'] + tick : 'Internal') + ' |'),
    ''
  ];
  for (const tag of document.tags) {
    const tagged = operations.filter((item) => item.operation.tags.includes(tag.name));
    if (tagged.length === 0) continue;
    lines.push('## ' + tag.name, '', tag.description, '');
    for (const item of tagged) {
      const operation = item.operation;
      const request = operation.requestBody
        ? contentExample((operation.requestBody.content as JsonRecord) ?? {})
        : undefined;
      const response = contentExample((operation.responses['200'].content as JsonRecord) ?? {});
      lines.push(
        '### ' + item.method + ' ' + item.path,
        '',
        operation.summary + '。',
        '',
        operation.description,
        '',
        '- 鉴权：' + operation['x-mx-auth'],
        ...(operation['x-route-id'] ? ['- routeId：' + tick + operation['x-route-id'] + tick] : []),
        ...(operation['x-accepted-scopes'].length > 0 ? ['- 接受任一 scope：' + operation['x-accepted-scopes'].map((scope) => tick + scope + tick).join('、')] : []),
        '',
        fence + 'bash',
        curlExample(item.method, item.path, operation, request),
        fence,
        ''
      );
      if (request !== undefined) {
        lines.push('Request example:', '', fence + 'json', pretty(request), fence, '');
      }
      lines.push('Response example:', '', fence + (typeof response === 'string' ? 'yaml' : 'json'), pretty(response), fence, '');
    }
  }
  return lines.join('\n') + '\n';
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
