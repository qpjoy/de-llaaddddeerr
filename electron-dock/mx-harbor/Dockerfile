# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /workspace/mx-common
COPY --from=mx_common package.json ./
COPY --from=mx_common src ./src
WORKDIR /workspace/mx-harbor
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /workspace/mx-harbor
COPY --from=build --chown=node:node /workspace /workspace
USER node
EXPOSE 18220
CMD ["node","apps/server/index.mjs"]
