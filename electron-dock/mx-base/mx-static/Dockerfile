FROM node:24.21.0-bookworm-slim
WORKDIR /app
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund undici@7.29.1
# Shared, tested SSRF/DNS-pinning and image validation code only. No Hub runtime.
COPY mx-insight-hub/server/external-platforms/media.mjs mx-insight-hub/server/external-platforms/media.mjs
COPY mx-insight-hub/server/core/errors.mjs mx-insight-hub/server/core/errors.mjs
COPY mx-base/mx-static/src mx-base/mx-static/src
USER 1000:1000
EXPOSE 18200
CMD ["node", "mx-base/mx-static/src/index.mjs"]
