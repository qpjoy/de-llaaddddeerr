-- Payment-owned authorization/control data. No Launcher/Hub database dependency.
CREATE SCHEMA pay_control;
CREATE TABLE pay_control.meta (id text PRIMARY KEY, value text NOT NULL);
CREATE TABLE pay_control.members (
 id text PRIMARY KEY, identity jsonb NOT NULL, grants jsonb NOT NULL DEFAULT '[]',
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pay_control.channels (
 id text PRIMARY KEY, draft text NOT NULL, published text, revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pay_control.apps (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE pay_control.credentials (
 id text PRIMARY KEY, app_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('test','live')),
 scopes jsonb NOT NULL, hash text NOT NULL UNIQUE, revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pay_control.invitations (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, issuer text NOT NULL, client_id text NOT NULL,
 grants jsonb NOT NULL, expires_at timestamptz NOT NULL, used_by text, revoked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pay_control.audit (
 id uuid PRIMARY KEY, actor jsonb NOT NULL, action text NOT NULL, target text NOT NULL,
 details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_control_audit_time ON pay_control.audit(created_at DESC,id);
CREATE TRIGGER pay_control_audit_immutable BEFORE UPDATE OR DELETE ON pay_control.audit
 FOR EACH ROW EXECUTE FUNCTION pay.immutable_record();
CREATE INDEX pay_customer_orders ON pay.orders(app_id,environment,(document->>'customerRef'),created_at DESC);
