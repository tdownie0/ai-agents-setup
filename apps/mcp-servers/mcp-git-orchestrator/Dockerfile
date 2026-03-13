FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    ca-certificates \
    libssl-dev \
    libcurl4-gnutls-dev \
    libexpat1-dev \
    gettext \
    zlib1g-dev \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/git/git/archive/refs/tags/v2.48.1.tar.gz | tar -xz && \
    cd git-2.48.1 && \
    make prefix=/usr/local all && \
    make prefix=/usr/local install && \
    cd .. && rm -rf git-2.48.1

RUN npm install -g pnpm && \
    mkdir -p /usr/local/lib/node_modules && \
    chown -R 1000:1000 /usr/local/lib/node_modules

ARG USER_ID=1000
RUN groupadd -g 1000 devgroup && \
    useradd -u $USER_ID -g devgroup -m devuser

WORKDIR /opt/orchestrator
RUN chown -R 1000:1000 /opt/orchestrator

RUN mkdir -p /app && chown -R 1000:1000 /app

USER devuser

RUN pnpm config set store-dir /home/devuser/.pnpm-store
RUN git config --global user.email "orchestrator@model-md.local" && \
    git config --global user.name "Git Orchestrator"

COPY --chown=1000:1000 apps/mcp-servers/mcp-git-orchestrator/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=1000:1000 apps/mcp-servers/mcp-git-orchestrator/ .

ENV PYTHONUNBUFFERED=1
ENV WORKSPACE_ROOT=/app

CMD ["python", "-u", "/opt/orchestrator/main.py"]
