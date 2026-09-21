FROM node:24.21.0-bookworm-slim
LABEL org.opencontainers.image.title="mx-static"
WORKDIR /app
# No runtime dependencies: SSRF/DNS pinning, media signatures and the streaming
# fetcher are local modules on top of the Node standard library.
COPY src ./src
USER 1000:1000
EXPOSE 18200
CMD ["node", "src/index.mjs"]
