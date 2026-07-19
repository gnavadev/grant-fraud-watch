# syntax=docker/dockerfile:1
# Multi-stage image: Vite client + Express API (tsx).
# Free-tier friendly: Render, Railway, Fly, Koyeb, Cloud Run, etc.

# ── Client build ──────────────────────────────────────────────
FROM node:22-alpine AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Production runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
# tsx is a production dependency (runs TypeScript server without a separate compile step)
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY tsconfig.json ./
COPY --from=client-build /app/client/dist ./client/dist

# Writable cache for USAspending / FAC / SAM responses
RUN mkdir -p /app/.cache && chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=8s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/index.ts"]
