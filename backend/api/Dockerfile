# One image for every backend role. The compose file picks the role with
# `command`: src/server.js (API), src/publisher.js, src/worker.js,
# src/recovery.js, or src/database/migrate.js up (one-shot migrations).
#
# Debian slim (glibc) so argon2's prebuilt binary is used; no compiler needed.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
# 4000: API (PORT). 9464: ops server (OPS_PORT) for publisher/worker/recovery.
EXPOSE 4000 9464
# node runs as PID 1 and handles SIGTERM itself (graceful shutdown in each entry script).
CMD ["node", "src/server.js"]
