# Authentication

QPJoy marketplace ships with three planned auth methods. Phase 5 wires up
**username/email + password**; the other two are scaffolded but require
provider integration.

| Method | Status | Notes |
| --- | --- | --- |
| `username + password` | ✅ wired | The MVP. Anyone can register. |
| `email + password` | ✅ wired | Email verification is optional in dev (set `REQUIRE_VERIFICATION=1` to enforce). Provider hookup deferred. |
| `phone + SMS code` | 🟡 scaffolded | `/api/v1/auth/code` exists; production needs an SMS provider (aliyun-sms / Twilio). Dev path logs the code to stdout. |

## Endpoints (Phase 5)

All under `/api/v1/auth/`. Public; rate-limit them at the reverse proxy in production.

| Method + Path | Body | Returns |
| --- | --- | --- |
| `POST /register` | `{username?, email?, phone?, password, displayName?, verificationCode?}` | `{user, tokens}` |
| `POST /login` | `{identifier, password}` | `{user, tokens}` |
| `POST /refresh` | `{refreshToken}` | `{accessToken, refreshToken, accessExpiresAt, refreshExpiresAt}` |
| `POST /logout` | `{refreshToken}` | `{ok: true}` |
| `POST /code` | `{channel: 'email'\|'sms', destination, purpose}` | `{delivered}` |
| `GET /me` | — (Bearer) | `PublicUser` |
| `DELETE /me` | — (Bearer) | `{ok: true}` — self-ban |

Admin-only (require `role: 'admin'` JWT):

| Path | Body | Purpose |
| --- | --- | --- |
| `GET /api/v1/admin/users` | — | list all users |
| `POST /api/v1/admin/users/:id/role` | `{role}` | promote / ban a user |
| `POST /api/v1/admin/users/:id/entitlements` | `{pluginId, kind, expiresAt?}` | grant a paid plugin |
| `GET /api/v1/admin/users/:id/entitlements` | — | inspect a user's grants |

## Tokens

- **Access**: JWT (HS256), 15 min TTL. Claims: `{sub, role, jti, iat, exp}`.
- **Refresh**: opaque 32-byte hex, stored as `sha256:` hash. 30 day TTL. Rotated on every use.
- **Secret**: `JWT_SECRET` env var. Dev fallback persists a random 96-char hex to `data/.jwt-secret` (gitignored) so restarts don't invalidate sessions.

## Bootstrap admin

The first user is auto-promoted to `admin` (the user table is empty at that
moment). For pre-populated test data, run:

```bash
pnpm admin:bootstrap -- --username root --password 'change-me-later'
```

## Visibility model

Marketplace entries carry a `visibility` field that the index endpoint
enforces:

| Visibility | Visible to |
| --- | --- |
| `public` | anyone (default) |
| `free` | any logged-in user |
| `paid` | logged-in user with an entitlement, or admin |
| `private` | admin only (creator + share-links later) |

The host's marketplace UI mirrors this with a 🔒 lock chip + "登录解锁"
button on cards the current session can't install yet.

## What's NOT included in Phase 5

- Real email delivery — use SES / Resend / Mailgun. Stub in `service.ts → issueDevCode`.
- Real SMS delivery — use Twilio / aliyun-sms / qcloud-sms.
- Magic-link login — design fits cleanly into `verification_codes` but the
  end-to-end flow lives in Phase 6.
- Rate limiting / brute-force protection — sit a CDN / reverse-proxy in front
  for now (`limit_req` in nginx, fastly TLS gateway, etc.).
- Audit log — the SQL table exists (`audit_logs`); writers are TODO.
