FROM node:22-alpine AS build
WORKDIR /app
ARG MX_SHADOW_NPM_REGISTRY=https://registry.npmmirror.com
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV COREPACK_NPM_REGISTRY=${MX_SHADOW_NPM_REGISTRY} \
    NPM_CONFIG_REGISTRY=${MX_SHADOW_NPM_REGISTRY}
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN mkdir -p artifacts/site-slots
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
LABEL dev.qpjoy.mx-launcher.project="mx-launcher" \
      dev.qpjoy.mx-launcher.component="server" \
      dev.qpjoy.mx-launcher.image="shadow"
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
