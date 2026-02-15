# Use the latest Active LTS
FROM node:24-alpine
WORKDIR /app

# 1. Copy workspace manifests first to leverage Docker cache
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# 2. Install dependencies for the whole workspace
# We use 'npm install' instead of 'npm ci' in dev to allow 
# the agent to add new packages if needed.

RUN npm install


# 3. Copy the rest of the source code
COPY . .

# No CMD here because 'docker-compose' overrides it with 'npm run dev'
