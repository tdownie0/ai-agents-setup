# --- STAGE 1: Base Dependencies ---
FROM node:24-alpine AS base
WORKDIR /app
# Copy manifests to install deps
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
# Install all dependencies (Workspace aware)

RUN npm install

# --- STAGE 2: Development (Your current workflow) ---
FROM base AS development
WORKDIR /app
# Copy the rest of the source code
COPY . .
# The agent can now run 'npm install' inside this stage 
# and it won't affect the 'base' layer.
CMD ["npm", "run", "dev"]

# --- STAGE 3: Builder (For Production) ---
FROM base AS builder
WORKDIR /app
COPY . .
RUN npm run build

# --- STAGE 4: Production Runner ---
FROM node:24-alpine AS production
WORKDIR /app

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/node_modules ./node_modules
# Run only the production server
CMD ["node", "server/dist/index.js"]
