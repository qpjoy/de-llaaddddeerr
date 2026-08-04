# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build

WORKDIR /workspace/mx-insight-hub
COPY --from=ui_design . /workspace/mx-launcher/ui-design
RUN node /workspace/mx-launcher/ui-design/scripts/build.mjs \
    && test -s /workspace/mx-launcher/ui-design/dist/styles.css
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
USER node
EXPOSE 18150 18151 18180
CMD ["node", "server/index.mjs"]
