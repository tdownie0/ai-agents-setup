# --- STAGE 1: Builder ---
FROM node:25-slim AS builder
RUN npm install -g pnpm
WORKDIR /app

# Layer 1: Dependencies (Cached unless lockfile changes)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/database/package.json ./packages/database/
COPY apps/mcp-servers/mcp-database-service/package.json ./apps/mcp-servers/mcp-database-service/

RUN pnpm install --frozen-lockfile

# Layer 2: Source Code
COPY packages/database ./packages/database
COPY apps/mcp-servers/mcp-database-service ./apps/mcp-servers/mcp-database-service

# Build
RUN pnpm --filter @model_md/mcp-database-service run build
# Debugging check
RUN ls -la /app/apps/mcp-servers/mcp-database-service/dist/index.js

# --- STAGE 2: Runner ---
FROM node:25-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# 1. Copy the workspace infrastructure
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# 2. Copy the specific app files
COPY --from=builder /app/apps/mcp-servers/mcp-database-service/package.json ./apps/mcp-servers/mcp-database-service/
COPY --from=builder /app/apps/mcp-servers/mcp-database-service/dist/index.js ./dist/index.js

# 3. Install prod dependencies
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile --filter @model_md/mcp-database-service
