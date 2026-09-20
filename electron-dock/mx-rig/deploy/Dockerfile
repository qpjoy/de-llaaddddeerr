# Build context: electron-dock. Never copies the historical automation products.
FROM node:22-bookworm-slim
WORKDIR /app
COPY mx-common/package.json ./mx-common/package.json
COPY mx-launcher/ui-design/ ./mx-launcher/ui-design/
RUN node mx-launcher/ui-design/scripts/build.mjs
COPY mx-rig/package.json mx-rig/package-lock.json ./mx-rig/
COPY mx-rig/packages/test-platform/package.json ./mx-rig/packages/test-platform/package.json
WORKDIR /app/mx-rig
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && ln -s /app/mx-rig/node_modules /app/node_modules
COPY mx-common/src /app/mx-common/src
COPY mx-rig/apps/server ./apps/server
COPY mx-rig/apps/web ./apps/web
COPY mx-rig/packages/runtime ./packages/runtime
COPY mx-rig/packages/graph ./packages/graph
COPY mx-rig/packages/contracts ./packages/contracts
COPY mx-rig/packages/mcp ./packages/mcp
COPY mx-rig/bin ./bin
# Materialize assets before switching to node and a read-only root filesystem.
COPY mx-rig/scripts/design-assets.mjs ./scripts/design-assets.mjs
RUN node scripts/design-assets.mjs --required
COPY mx-rig/packages/test-platform/server ./packages/test-platform/server
COPY mx-rig/packages/test-platform/web ./packages/test-platform/web
COPY mx-rig/packages/test-platform/bin ./packages/test-platform/bin
COPY mx-rig/packages/test-platform/contracts ./packages/test-platform/contracts
COPY mx-rig/packages/test-platform/migrations ./packages/test-platform/migrations
RUN mkdir -p /data/control /data/artifacts && chown -R node:node /data
USER node
ENV NODE_ENV=production MX_RIG_HOST=0.0.0.0 MX_RIG_PORT=8791 MX_RIG_STATE_DIR=/data/control MX_RIG_ARTIFACTS_DIR=/data/artifacts
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8791/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/server/index.mjs"]
