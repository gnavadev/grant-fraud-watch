# syntax=docker/dockerfile:1
# Multi-stage: Vite client + compiled Express API (no tsx at runtime).
# Free-tier friendly: Render, Railway, Fly, Koyeb, Cloud Run, etc.

# ── Client build ──────────────────────────────────────────────
FROM node:22-alpine AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Server compile ────────────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci

COPY server/ ./server/
RUN npm run build:server

# ── Production runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p /app/.cache && chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
