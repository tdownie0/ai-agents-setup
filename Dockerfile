# --- STAGE 1: Base ---
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
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
# Install tools needed for db:reset and scripts
RUN apk add --no-cache postgresql-client git curl tar

# IMPORTANT: Install dependencies so concurrently and other tools exist
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --recursive

# Mount the rest of the source code at runtime via docker-compose
CMD ["pnpm", "dev"]
