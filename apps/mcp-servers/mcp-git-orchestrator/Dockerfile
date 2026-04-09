FROM golang:alpine AS beads-builder
RUN apk add --no-cache curl tar

RUN curl -fsSL https://github.com/gastownhall/beads/archive/refs/heads/main.tar.gz -o /tmp/beads.tar.gz && \
    tar -xzf /tmp/beads.tar.gz -C /tmp && \
    cd /tmp/beads-main && \
    CGO_ENABLED=0 go build -o /usr/local/bin/bd ./cmd/bd

RUN curl -fsSL https://github.com/dolthub/dolt/releases/download/v1.85.0/dolt-linux-amd64.tar.gz -o /tmp/dolt.tar.gz && \
    tar -xzf /tmp/dolt.tar.gz -C /tmp && \
    mv /tmp/dolt-linux-amd64/bin/dolt /usr/local/bin/dolt

FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    ca-certificates \
    gnupg \
    libssl-dev \
    libcurl4-gnutls-dev \
    libexpat1-dev \
    gettext \
    zlib1g-dev \
    procps \
    lsof \
    && \
    # Add Docker's official GPG key and repository
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    # Install Docker CLI and the plugin
    apt-get update && apt-get install -y \
    docker-ce-cli \
    docker-compose-plugin && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Build Git from source
RUN curl -L https://github.com/git/git/archive/refs/tags/v2.48.1.tar.gz | tar -xz && \
    cd git-2.48.1 && \
    make prefix=/usr/local all && \
    make prefix=/usr/local install && \
    cd .. && rm -rf git-2.48.1

COPY --from=beads-builder /usr/local/bin/bd /usr/local/bin/bd
COPY --from=beads-builder /usr/local/bin/dolt /usr/local/bin/dolt

RUN npm install -g pnpm && \
    mkdir -p /usr/local/lib/node_modules && \
    chown -R 1000:1000 /usr/local/lib/node_modules

# 1. Setup User and Docker Group alignment
ARG USER_ID=1000
RUN groupadd -g 1000 devgroup && \
    useradd -u $USER_ID -g devgroup -m devuser && \
    # Create the docker group with the GID found on your host (1001)
    groupadd -g 1001 docker && \
    usermod -aG docker devuser

# 2. Setup Directories
WORKDIR /opt/orchestrator
RUN mkdir -p /app && chown -R devuser:devgroup /opt/orchestrator /app

USER devuser

RUN git config --global user.email "orchestrator@model-md.local" && \
    git config --global user.name "Git Orchestrator"

# Final Setup
ENV PATH="/usr/local/bin:${PATH}"
ENV PYTHONUNBUFFERED=1
ENV WORKSPACE_ROOT=/app

# Copy Requirements and Code
COPY --chown=devuser:devgroup apps/mcp-servers/mcp-git-orchestrator/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=devuser:devgroup apps/mcp-servers/mcp-git-orchestrator/ .

CMD ["python", "-u", "/opt/orchestrator/main.py"]
