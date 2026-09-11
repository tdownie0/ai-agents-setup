# --- STAGE 1: Base ---
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# --- STAGE 2: Builder ---
FROM base AS builder
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm exec tsc --build --verbose

# --- STAGE 3: Pruner/Deployer ---
FROM builder AS pruner
# 3. Create a production-only folder containing only backend runtime requirements
RUN pnpm --filter @model_md/backend --prod deploy /app/out

# --- STAGE 4: Runner ---
FROM node:24-alpine AS runner
WORKDIR /app

# 4. Copy only the pruned output
COPY --from=pruner /app/out/ .

CMD ["node", "index.js"]

# --- STAGE 5: Development ---
FROM base AS development
WORKDIR /app

ARG USER_ID=1000
ARG GROUP_ID=1000

# node:alpine ships a `node` user/group at uid/gid 1000, which matches the
# default host identity. For hosts with a different UID/GID, create a matching
# devuser so bind-mounted worktrees and volume copy-up stay host-owned instead
# of root-owned.
RUN if [ "${USER_ID}" != "1000" ] || [ "${GROUP_ID}" != "1000" ]; then \
        addgroup -g ${GROUP_ID} devgroup 2>/dev/null || true; \
        adduser -D -u ${USER_ID} -G devgroup -s /bin/sh -h /home/devuser devuser 2>/dev/null || true; \
        mkdir -p /home/devuser && \
        chown -R ${USER_ID}:${GROUP_ID} /home/devuser; \
    fi

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/database/package.json ./packages/database/
COPY apps/mcp-servers/mcp-database-service/package.json ./apps/mcp-servers/mcp-database-service/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/database ./packages/database

RUN pnpm --filter @model_md/database build

# Hand the image build outputs (workspace node_modules trees + dist) to the
# runtime identity: named/anonymous volumes copy-up from the image on first
# use, and this is what keeps that copy host-owned instead of root-owned.
RUN chown -R ${USER_ID}:${GROUP_ID} /app

USER ${USER_ID}:${GROUP_ID}

CMD ["pnpm", "dev"]
