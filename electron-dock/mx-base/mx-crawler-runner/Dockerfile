# syntax=docker/dockerfile:1.7
# mx-crawler-runner: Node 22 HTTP service + Python 3.13 environments for the
# reviewed packages in packages/. The build verifies every package tree
# against packages.json, installs each package's own requirements.lock.txt
# (identical lock files share one environment), installs the Google Play Node
# backend from its package-lock.json, and runs every package's offline adapter
# tests on Linux, then precompiles bytecode (the root filesystem is read-only at
# run time; __pycache__ is outside the hashed tree). No package code, command or
# interpreter comes from requests.
#
# China mirrors by default so the build needs no overseas proxy; override with
# --build-arg PIP_INDEX_URL=https://pypi.org/simple NPM_REGISTRY=https://registry.npmjs.org
FROM node:22-bookworm-slim AS node

FROM python:3.13-slim-bookworm AS build
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && node -e "if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22+ required')"
WORKDIR /opt/mx-crawler-runner
COPY package.json packages.json ./
COPY src ./src
COPY scripts ./scripts
COPY packages ./packages
COPY upstream ./upstream
COPY overrides ./overrides
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN node scripts/lock-packages.mjs \
 && node scripts/install-packages.mjs --python python3.13 --venvs /opt/mx-crawler-runner/.venvs \
      --index-url "$PIP_INDEX_URL" --npm-registry "$NPM_REGISTRY" \
 && rm -rf packages/*/.runtime/*/npm-cache /root/.npm \
 && python3.13 -m compileall -q --invalidation-mode checked-hash packages upstream \
 && node scripts/lock-packages.mjs

FROM python:3.13-slim-bookworm
# Node runs the service and the Google Play backend; npm is not shipped.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /opt/mx-crawler-runner /opt/mx-crawler-runner
WORKDIR /opt/mx-crawler-runner
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
ENTRYPOINT ["node", "src/main.mjs"]
