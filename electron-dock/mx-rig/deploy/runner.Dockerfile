# A server-kind runner for docker compose: the platform's own mxt-runner in
# the Playwright image. Build context: mx-rig.
#
# Suites install their own dependencies at run time; the browsers come from
# this image. Keep PLAYWRIGHT_VERSION equal to the @playwright/test version
# your suites lock, or their first run will look for browsers that are not
# here.
ARG PLAYWRIGHT_VERSION=1.58.2
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mxt
COPY packages/test-platform/bin/mxt-runner.mjs ./mxt-runner.mjs
RUN mkdir -p /runner/config /runner/data && chown -R pwuser:pwuser /runner
USER pwuser
ENV CI=1 MXT_RUNNER_CONFIG_DIR=/runner/config MXT_RUNNER_DATA_DIR=/runner/data
CMD ["node", "/opt/mxt/mxt-runner.mjs", "watch"]
