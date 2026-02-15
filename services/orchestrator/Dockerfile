FROM node:24-alpine

# Install git and basic build tools in case the agent 
# needs to compile something or perform git operations
RUN apk add --no-cache git python3 make g++
WORKDIR /workspace

# If your orchestrator has its own package.json:
COPY services/orchestrator/package*.json ./
RUN npm install

COPY services/orchestrator/ .

CMD ["node", "index.js"]
