# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim
WORKDIR /app/mx-common
COPY --from=mx_common package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY --from=mx_common src ./src
WORKDIR /app/mx-base/mx-pay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY src ./src
COPY server ./server
COPY console ./console
COPY migrations ./migrations
USER node
EXPOSE 18230
CMD ["node", "server/index.mjs"]
