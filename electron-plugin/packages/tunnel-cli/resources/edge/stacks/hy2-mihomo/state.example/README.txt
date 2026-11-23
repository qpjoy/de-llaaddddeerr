hy2-mihomo state, pushed with
  qp-tunnel-cli edge push <host> --stack hy2-mihomo --state-dir <this dir>

hy2.env   the stack's .env (copied from docker/hysteria2-mihomo-stack/.env.example by --init).
          Required before the first push:
            HY2_SERVER_HOST           this host's public address
            HY2_EXPORT_BASE_URL       http://<public address>:<HY2_EXPORT_FALLBACK_PORT>
            HY2_EXPORT_PASSWORD_HASH  bcrypt hash in single quotes:
                                      docker run --rm caddy:2.11.9-alpine caddy hash-password --plaintext '<password>'
            HY2_USERS                 first users, comma-separated; added only while the user list is empty
          The stack keeps its own .env on the host and edits it (manage.sh). A push applies hy2.env
          again only when this file changed; the replaced .env is kept as .env.before-<revision>.

Keep this directory out of Git. On the host it lives under /opt/mx/state/<component>/ (mode 600).
Hosts that cannot pull from Docker Hub: pull and add --image tobyxdd/hysteria:v2.14.0 --image caddy:2.11.9-alpine (the pinned versions)
to the push (both must exist in the local docker first).
