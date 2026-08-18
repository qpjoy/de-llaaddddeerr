# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
# Default to the China npm mirror so the build needs no oversea proxy.
# Override with --build-arg NPM_REGISTRY=https://registry.npmjs.org if desired.
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /workspace/mx-insight-hub
COPY --from=ui_design package.json /workspace/mx-launcher/ui-design/package.json
COPY --from=ui_design scripts /workspace/mx-launcher/ui-design/scripts
COPY --from=ui_design src /workspace/mx-launcher/ui-design/src
# `@qpjoy/mx-common` is a `file:` dependency, so npm needs the package present at
# the resolved relative path before install -- but only its manifest. Its `src`
# and `migrations` are copied *after* the install, because a linked package's
# sources are read at build and run time, never at install time, and copying
# them first made every edit to shared source re-run a ~70s network install.
COPY --from=mx_common package.json package-lock.json /workspace/mx-common/
COPY package.json package-lock.json ./
RUN npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=300000
COPY --from=mx_common src /workspace/mx-common/src
COPY --from=mx_common migrations /workspace/mx-common/migrations
COPY . ./
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
ARG NPM_REGISTRY=https://registry.npmmirror.com

# mx-common is a `file:` dependency, so npm links it rather than copying it, and
# Node resolves its imports from the package's own realpath. Its dependencies
# therefore have to live in /mx-common/node_modules -- hoisting them into
# /app/node_modules would leave `import 'pg'` unresolvable at runtime.
WORKDIR /mx-common
COPY --from=mx_common package.json package-lock.json ./
# Optional dependencies are installed on purpose. mx-common's default Chinese
# segmenter is @node-rs/jieba, declared optional so a platform without prebuilt
# binaries still installs; omitting it here would silently downgrade every
# deployment to the bigram fallback with only a log line to show for it.
#
# This install reads the lockfile and nothing else -- mx-common declares no
# install lifecycle scripts -- so the sources land afterwards. Ordering them
# first meant a one-line change to shared source invalidated the install and
# went back to the registry for every dependency, turning a seconds-long
# rebuild into a minutes-long one that can fail on its own.
# Retries and an explicit timeout are load-bearing, not cosmetic. A mirror that
# lacks one platform-specific optional package -- @node-rs/jieba ships prebuilt
# binaries per platform -- leaves npm waiting on a host this network cannot
# reach, and npm's own exit handler then fails with "Exit handler never called"
# instead of naming the package. A bounded fetch fails as a fetch.
RUN npm ci --omit=dev --registry="$NPM_REGISTRY" \
      --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=300000 \
 && npm cache clean --force
COPY --from=mx_common src ./src
COPY --from=mx_common migrations ./migrations

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="$NPM_REGISTRY" \
      --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=300000 \
 && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MX_INSIGHT_HOST=0.0.0.0 \
    MX_INSIGHT_PORT=18180
WORKDIR /app
# npm links a `file:` dependency as a symlink into node_modules, so the target
# must exist in the runtime stage at the same resolved path or every import of
# @qpjoy/mx-common fails at startup with a dangling link.
COPY --from=production-dependencies /mx-common /mx-common
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
