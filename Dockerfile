# --- STAGE 1: Base ---
FROM node:24-alpine AS base

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# --- STAGE 2: Pruner (Isolate dependencies) ---
FROM base AS pruner
# Copy only the files necessary to resolve dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json ./apps/backend/

COPY apps/frontend/package.json ./apps/frontend/
COPY packages/database/package.json ./packages/database/
# Install all deps (including devDependencies for building)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- STAGE 3: Builder ---
FROM pruner AS builder
COPY . .
# Build only what is needed for the target app
# For example, if building the backend:
RUN pnpm --filter @model_md/backend run build

# --- STAGE 5: Development ---
FROM base AS development
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY packages/database/package.json ./packages/database/

# 2. Now run the install
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# 3. Expose ports
EXPOSE 3000 5173

CMD ["node", "dist/index.js"]
