# ---- Stage 1: Prune the monorepo for this workspace ----
FROM node:22-slim AS pruner
RUN npm i -g turbo@^2
WORKDIR /app
COPY . .
RUN turbo prune @talos/api-server --docker

# ---- Stage 2: Install dependencies ----
FROM node:22-slim AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci --omit=dev

# ---- Stage 3: Build ----
FROM node:22-slim AS builder
RUN npm i -g turbo@^2
WORKDIR /app
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN turbo build --filter=@talos/api-server

# ---- Stage 4: Production runtime ----
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 talos && \
    adduser --system --uid 1001 --ingroup talos talos

# Copy built output and production node_modules
COPY --from=deps --chown=talos:talos /app/ .
COPY --from=builder --chown=talos:talos /app/apps/api-server/dist ./apps/api-server/dist
# Copy dist from internal packages that api-server depends on
COPY --from=builder --chown=talos:talos /app/packages/ ./packages/
COPY --from=builder --chown=talos:talos /app/agents/ ./agents/
COPY --from=builder --chown=talos:talos /app/connectors/ ./connectors/
COPY --from=builder --chown=talos:talos /app/services/ ./services/

USER talos

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

CMD ["node", "apps/api-server/dist/server.js"]
