# --- STAGE 1: Builder ---
FROM node:26-slim AS builder
RUN npm install -g corepack@latest --force
RUN corepack enable
WORKDIR /app

# Layer 1: Dependencies (Cached unless lockfile changes)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/database/package.json ./packages/database/
COPY packages/market-data/package.json ./packages/market-data/
COPY packages/agent-orchestrator/package.json ./packages/agent-orchestrator/
COPY apps/mcp-servers/mcp-portfolio-orchestrator/package.json ./apps/mcp-servers/mcp-portfolio-orchestrator/

RUN pnpm install --frozen-lockfile

# Layer 2: Source Code
COPY packages/database ./packages/database
COPY packages/market-data ./packages/market-data
COPY packages/agent-orchestrator ./packages/agent-orchestrator
COPY apps/mcp-servers/mcp-portfolio-orchestrator ./apps/mcp-servers/mcp-portfolio-orchestrator

# Workspace deps must be built first — the server imports their dist at runtime.
RUN pnpm --filter @model_md/agent-orchestrator run build
RUN pnpm --filter @model_md/mcp-portfolio-orchestrator run build

# --- STAGE 2: Runner ---
FROM node:26-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# docker CLI so the server can `docker exec opencode_agent ...`
# through the mcp-socket-proxy (DOCKER_HOST passthrough).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/market-data ./packages/market-data
COPY --from=builder /app/packages/agent-orchestrator ./packages/agent-orchestrator
COPY --from=builder /app/apps/mcp-servers/mcp-portfolio-orchestrator ./apps/mcp-servers/mcp-portfolio-orchestrator

CMD ["node", "apps/mcp-servers/mcp-portfolio-orchestrator/dist/index.js"]