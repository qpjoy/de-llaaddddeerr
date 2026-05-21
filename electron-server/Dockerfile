# Multi-stage build for the QPJoy marketplace server.
#
# The image bundles:
#   - the compiled Fastify server (dist/)
#   - the SQL migration files (db/migrations/)  → run by pg pool at boot
#   - the prebuilt admin SPA            (/app/spa-dist/)  → served at /admin/
#
# The SPA lives in a sibling workspace (electron-plugin/packages/admin-ui).
# `scripts/manage.sh build` copies its dist into ./data/spa-dist before
# running `docker compose build` so the file is in the Docker build context.

FROM node:22-alpine AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
WORKDIR /app
RUN apk add --no-cache bash curl docker-cli \
  && (apk add --no-cache docker-cli-compose || apk add --no-cache docker-compose)
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV SPA_DIST=/app/spa-dist

# Runtime deps only (no devDeps, no source).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist          ./dist
# Migration loader resolves relative to its own JS file:
#   dist/src/data/pg/pool.js  →  dist/db/migrations
# so the SQL files need to be inside dist/ at this exact relative spot.
COPY --from=build /app/db/migrations ./dist/db/migrations
COPY --from=build /app/package.json  ./package.json
# SPA bundle (may be empty if not built yet — server logs a warning and
# falls back to JSON API only). Keep this outside /app/data because that path
# is a runtime volume in docker-compose.
COPY --from=build /app/data/spa-dist ./spa-dist

VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# tsc rootDir is the repo root → emit lands under dist/src/.
CMD ["node", "dist/src/index.js"]
