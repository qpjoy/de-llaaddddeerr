# Build context is electron-dock/, not this directory: the image needs
# ../mx-common, which package.json depends on with a file: reference.
FROM node:22-alpine

WORKDIR /app

COPY mx-common/package.json ./mx-common/package.json
COPY mx-test-framework/package.json ./mx-test-framework/package.json
# The design system is a file: dependency, so its manifest must exist before
# install and its dist/ must be built before it is useful.
COPY mx-launcher/ui-design/ /app/mx-launcher/ui-design/
RUN node /app/mx-launcher/ui-design/scripts/build.mjs

WORKDIR /app/mx-test-framework
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

COPY mx-common/ /app/mx-common/
COPY mx-test-framework/server/ ./server/
COPY mx-test-framework/web/ ./web/
COPY mx-test-framework/bin/ ./bin/
COPY mx-test-framework/migrations/ ./migrations/
COPY mx-test-framework/contracts/ ./contracts/

# Artifacts live on a mounted PVC; create the mount point with the right owner
# so the container can run unprivileged with a read-only root filesystem.
RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node

ENV NODE_ENV=production MXT_PORT=8790
EXPOSE 8790
CMD ["node", "server/index.mjs"]
