# Build context is electron-dock/: the V0 kernel has sibling file dependencies.
FROM node:22-alpine

WORKDIR /app

COPY mx-common/package.json ./mx-common/package.json
COPY mx-test-framework/package.json mx-test-framework/package-lock.json ./mx-test-framework/
COPY mx-launcher/ui-design/ ./mx-launcher/ui-design/
RUN node ./mx-launcher/ui-design/scripts/build.mjs

WORKDIR /app/mx-test-framework
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# @qpjoy/mx-common is a file link. Imports made from its real path must see the
# same dependency tree as the kernel.
RUN ln -s /app/mx-test-framework/node_modules /app/node_modules

COPY mx-common/ /app/mx-common/
COPY mx-test-framework/server/ ./server/
COPY mx-test-framework/web/ ./web/
COPY mx-test-framework/bin/ ./bin/
COPY mx-test-framework/migrations/ ./migrations/
COPY mx-test-framework/contracts/ ./contracts/

WORKDIR /app/mx-auto-server
COPY mx-auto-server/package.json ./package.json
COPY mx-auto-server/server/ ./server/

RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node

ENV NODE_ENV=production \
    MX_AUTO_KERNEL_ROOT=/app/mx-test-framework \
    MX_AUTO_PORT=8790
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8790/healthz || exit 1

CMD ["node", "server/index.mjs"]
