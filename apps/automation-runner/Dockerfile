# ---- Stage 1: Prune the monorepo for this workspace ----
FROM node:22-slim AS pruner
RUN npm i -g turbo@^2
WORKDIR /app
COPY . .
RUN turbo prune @talos/automation-runner --docker

# ---- Stage 2: Install Node dependencies ----
FROM node:22-slim AS deps
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci --omit=dev

# ---- Stage 3: Build TypeScript ----
FROM node:22-slim AS builder
RUN npm i -g turbo@^2
WORKDIR /app
COPY --from=deps /app/ .
COPY --from=pruner /app/out/full/ .
RUN turbo build --filter=@talos/automation-runner

# ---- Stage 4: Production runtime (Node + Python) ----
# Use the official Node image and add Python on top
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3003

# Install Python 3 and pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      # Playwright/Nova Act system dependencies
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies in a venv
RUN python3 -m venv /opt/nova-venv
COPY apps/automation-runner/python/requirements.txt /tmp/requirements.txt
RUN /opt/nova-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt
ENV PATH="/opt/nova-venv/bin:$PATH"

RUN addgroup --system --gid 1001 talos && \
    adduser --system --uid 1001 --ingroup talos talos

# Copy Node artifacts
COPY --from=deps --chown=talos:talos /app/ .
COPY --from=builder --chown=talos:talos /app/apps/automation-runner/dist ./apps/automation-runner/dist
COPY --from=builder --chown=talos:talos /app/packages/ ./packages/
COPY --from=builder --chown=talos:talos /app/agents/ ./agents/

# Copy the Python bridge script
COPY --chown=talos:talos apps/automation-runner/python/ ./apps/automation-runner/python/

USER talos

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3003/health').then(r=>{if(!r.ok)throw r.status}).catch(()=>process.exit(1))"

CMD ["node", "apps/automation-runner/dist/server.js"]
