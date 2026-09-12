# --- Stage 0: beads CLI builder (mirrors infra/builds/Dockerfile.ai_cli) ---
FROM golang:bookworm AS beads-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl tar ca-certificates build-essential libicu-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/gastownhall/beads/archive/refs/heads/main.tar.gz -o /tmp/beads.tar.gz && \
    tar -xzf /tmp/beads.tar.gz -C /tmp && \
    cd /tmp/beads-main && \
    CGO_ENABLED=1 go build \
        -tags gms_pure_go \
        -ldflags '-linkmode external -extldflags "-static"' \
        -o /usr/local/bin/bd ./cmd/bd

# --- Stage 1: Base Image (The "Clean" Foundation) ---
FROM python:3.14-slim AS base

# Accept host UID/GID so container files match host ownership
ARG USER_ID=1000
ARG GROUP_ID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates procps gnupg lsof git && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# beads CLI: the worker runs `bd init --server` when provisioning worktrees
COPY --from=beads-builder /usr/local/bin/bd /usr/local/bin/bd

# 2. Setup User with host-matching UID/GID
RUN groupadd -g $GROUP_ID devgroup && \
    useradd -u $USER_ID -g devgroup -m devuser

WORKDIR /opt/orchestrator
RUN mkdir -p /app && chown -R devuser:devgroup /opt/orchestrator /app

# 3. Python Environment
COPY apps/mcp-servers/mcp-git-orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=devuser:devgroup apps/mcp-servers/mcp-git-orchestrator/ .

USER devuser
RUN git config --global user.email "orchestrator@model-md.local" && \
    git config --global user.name "Git Orchestrator" && \
    mkdir -p /home/devuser/.config/bd && \
    printf 'no-git-ops: true\njson: true\nrole: maintainer\n' > /home/devuser/.config/bd/config.yaml
USER root

# --- Stage 2: MCP Server ---
FROM base AS mcp-server
USER devuser
CMD ["python", "-u", "main.py"]

# --- Stage 3: Worker ---
FROM base AS worker
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && npm install -g pnpm && \
    rm -rf /var/lib/apt/lists/*

USER devuser
CMD ["python", "-u", "main.py", "--worker"]
