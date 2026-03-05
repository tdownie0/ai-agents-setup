FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/database/package*.json ./packages/database/
COPY mcp-database-service/package*.json ./mcp-database-service/

RUN npm install

COPY packages/database ./packages/database
COPY mcp-database-service ./mcp-database-service

RUN npx tsc -b packages/database mcp-database-service

FROM node:24-alpine
WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/packages/database/package.json ./packages/database/package.json
COPY --from=builder /app/packages/database/dist ./packages/database/dist

COPY --from=builder /app/mcp-database-service/package.json ./mcp-database-service/package.json
COPY --from=builder /app/mcp-database-service/dist ./mcp-database-service/dist

CMD ["node", "/app/mcp-database-service/dist/index.js"]
