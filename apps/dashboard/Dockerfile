# ---- Stage 1: Prune the monorepo for this workspace ----
FROM node:22-slim AS pruner
RUN npm i -g turbo@^2
WORKDIR /app
COPY . .
RUN turbo prune @talos/dashboard --docker

# ---- Stage 2: Install dependencies ----
FROM node:22-slim AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci

# ---- Stage 3: Build Next.js ----
FROM node:22-slim AS builder
RUN npm i -g turbo@^2
WORKDIR /app
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .

# Next.js collects telemetry — disable in CI/Docker
ENV NEXT_TELEMETRY_DISABLED=1

RUN turbo build --filter=@talos/dashboard

# ---- Stage 4: Production runtime ----
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 talos && \
    adduser --system --uid 1001 --ingroup talos talos

# Copy Next.js standalone output if available, otherwise copy full build
COPY --from=builder --chown=talos:talos /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=talos:talos /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=talos:talos /app/apps/dashboard/public ./apps/dashboard/public

USER talos

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

CMD ["node", "apps/dashboard/server.js"]
