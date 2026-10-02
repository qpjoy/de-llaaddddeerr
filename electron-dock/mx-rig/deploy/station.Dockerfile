# A procedure station (工位) for docker compose or any Linux host: `mx-rig
# station watch` in the Playwright image. Build context: mx-rig.
#
# It claims procedure regression batches from the Rig service and replays them
# with the browser in this image; the service itself never opens one. Only
# what the station imports is copied: contracts, the procedure player, the
# browser tools, and the station command of the CLI.
ARG PLAYWRIGHT_VERSION=1.58.2
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
WORKDIR /opt/mx-rig
COPY package.json package-lock.json ./
COPY packages/test-platform/package.json ./packages/test-platform/package.json
# The image's browsers are the ones this Playwright expects; nothing is
# downloaded at install time.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY packages/contracts ./packages/contracts
COPY packages/runtime/aria.mjs packages/runtime/browser.mjs packages/runtime/procedure.mjs packages/runtime/station.mjs ./packages/runtime/
COPY bin/mx-rig.mjs ./bin/mx-rig.mjs
COPY apps/terminal/station.mjs apps/terminal/launcher.mjs ./apps/terminal/
RUN mkdir -p /station && chown -R pwuser:pwuser /station
USER pwuser
ENV CI=1 MX_RIG_STATION_DIR=/station
CMD ["node", "/opt/mx-rig/bin/mx-rig.mjs", "station", "watch"]
