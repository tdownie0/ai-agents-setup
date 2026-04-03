# --- STAGE 1: Builder ---
FROM node:25-slim AS builder
RUN npm install -g corepack@latest --force
RUN corepack enable
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

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/apps/mcp-servers/mcp-database-service ./apps/mcp-servers/mcp-database-service

CMD ["node", "apps/mcp-servers/mcp-database-service/dist/index.js"]
