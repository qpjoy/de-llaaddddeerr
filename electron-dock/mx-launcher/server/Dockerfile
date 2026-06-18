FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN mkdir -p artifacts/site-slots
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=18090
RUN apk add --no-cache bash iproute2 iputils kmod openssh-client openresolv rsync sshpass sudo wireguard-tools wireguard-tools-wg-quick
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/scripts ./server/scripts
COPY --from=build /app/artifacts ./artifacts
EXPOSE 18090
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18090/healthz || exit 1
CMD ["node", "dist/src/index.js"]
