# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
# Default to the China npm mirror so the build needs no oversea proxy.
# Override with --build-arg NPM_REGISTRY=https://registry.npmjs.org if desired.
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /workspace/mx-insight-hub
COPY --from=ui_design package.json /workspace/mx-launcher/ui-design/package.json
COPY --from=ui_design scripts /workspace/mx-launcher/ui-design/scripts
COPY --from=ui_design src /workspace/mx-launcher/ui-design/src
COPY package.json package-lock.json ./
RUN npm ci --registry="$NPM_REGISTRY"
COPY . ./
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="$NPM_REGISTRY" && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MX_INSIGHT_HOST=0.0.0.0 \
    MX_INSIGHT_PORT=18180
WORKDIR /app
COPY --from=build /workspace/mx-insight-hub/package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /workspace/mx-insight-hub/server ./server
COPY --from=build /workspace/mx-insight-hub/migrations ./migrations
COPY --from=build /workspace/mx-insight-hub/dist ./dist
COPY --from=build /workspace/mx-insight-hub/public ./public
# Use the numeric UID/GID of the base image's `node` user (1000:1000).
# Kubernetes `runAsNonRoot` cannot verify a non-numeric username, so a numeric
# USER here lets the image satisfy that check without relying on runAsUser.
USER 1000:1000
EXPOSE 18150 18151 18180
CMD ["node", "server/index.mjs"]
