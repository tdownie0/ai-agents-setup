# --- Stage 1: Build Git 2.48.1 ---
FROM python:3.12-slim AS git-builder
RUN apt-get update && apt-get install -y \
    curl build-essential libssl-dev libcurl4-gnutls-dev libexpat1-dev gettext zlib1g-dev
RUN curl -L https://github.com/git/git/archive/refs/tags/v2.48.1.tar.gz | tar -xz && \
    cd git-2.48.1 && \
    make prefix=/usr/local all install

# --- Stage 2: Base Image (The "Clean" Foundation) ---
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates procps gnupg lsof && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# 1. Copy Git from git-builder
COPY --from=git-builder /usr/local/bin/git /usr/local/bin/git
COPY --from=git-builder /usr/local/share/git-core /usr/local/share/git-core

# 2. Install System Runtime Deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates procps gnupg lsof && \
    rm -rf /var/lib/apt/lists/*

# 3. Setup User
ARG USER_ID=1000
RUN groupadd -g 1000 devgroup && \
    useradd -u $USER_ID -g devgroup -m devuser

WORKDIR /opt/orchestrator
RUN mkdir -p /app && chown -R devuser:devgroup /opt/orchestrator /app

# 4. Python Environment
COPY apps/mcp-servers/mcp-git-orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=devuser:devgroup apps/mcp-servers/mcp-git-orchestrator/ .

USER devuser
RUN git config --global user.email "orchestrator@model-md.local" && \
    git config --global user.name "Git Orchestrator"
USER root
RUN groupadd -g 1001 docker && usermod -aG docker devuser

# --- Stage 4: MCP Server ---
FROM base AS mcp-server
USER devuser
CMD ["python", "-u", "main.py"]

# --- Stage 5: Worker ---
FROM base AS worker
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

USER devuser
CMD ["python", "-u", "main.py", "--worker"]
