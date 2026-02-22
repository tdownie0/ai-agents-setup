# AI Assisted Code Development Workstation 🚀

A high-performance, containerized development environment designed for **Agent-Host Parity**. 
This project enables AI agents to operate within a Docker ecosystem while maintaining the ability to spawn parallel Git worktrees and access deep code intelligence via MCP.
Using this approach, MCP tools can be added through the Docker MCP toolkit, its catalogue, or direclty to opencode.

## 🏗 Architectural Overview

This system bridges the gap between a local host and AI agents using a modular, "Gateway-first" approach:

* **MCP Gateway:** Centralized communication hub using `mcp-gateway` to expose multiple tools to the AI via a single SSE (Server-Sent Events) endpoint.
* **Custom MCP Services:** Includes specialized tools like the `ast-mcp-service` (AST Explorer), which runs in its own container to provide the agent with deep semantic understanding of the codebase.
* **Unified Identity:** Synchronized UID/GID (1000) between the host and container to ensure seamless file permissions across the volume.

---

## ⚡ Key Features

### 1. Parallel Worktree Orchestration
The environment is optimized for **Git Worktrees**. This allows the AI agent to:
* Spawn a new "physical" folder for every feature branch.
* Work on multiple features in parallel without "context-bleeding."
* Maintain a clean `main` repository while experimentation happens in sibling directories.
* Use `--relative-paths` to ensure Git remains compatible across the Host/Container boundary.

### 2. Docker-Native MCP
Unlike traditional setups where MCP servers run on the host, this project treats tools as **services**:
* **ast-mcp-service:** Provides an `ast-explorer` to index and search code logic, not just text.
* **Scalability:** New tools (Database explorers, Browser controllers, etc.) can be added simply by updating the `docker-compose.yml` and the Gateway config.

---

## 🛠 Setup & Installation

### Prerequisites
* Docker & Docker Compose
* Git 2.41+ (On the host for worktree compatibility)

### Quick Start
1.  **Configure Environment:**
    ```bash
    cp .env.example .env
    # Ensure UID/GID are set to your local user
    export UID=$(id -u)
    export GID=$(id -g)
    ```

2.  **Launch the Factory:**
    ```bash
    docker-compose --profile agent up -d
    ```

---

## 📂 Project Structure

* `/model_md`: The primary repository/anchor for the AI agent.
* `/ast-mcp-service`: Source and Dockerfile for the AST-based MCP server.
* `.opencode/commands`: Contains the `worktree_orchestration.md` protocol—the agent's "SOP" for managing parallel work.
* `../.`: This setup assumes that the user will have access to the parent directory of the current application's directory.
  We do this in order to facilitate worktree functionality (mounted in docker-compose.yml for opencode in this case).

---

## 🧠 The AI Workflow
1.  **Request:** "Agent, build a login feature."
2.  **Orchestration:** The agent spawns `../model_md-login-feat` using a Git worktree.
3.  **Development:** The agent writes code and runs tests in isolation.
4.  **Review:** You inspect the sibling folder on your host.
5.  **Merge/Cleanup:** You merge the branch, and the agent removes the worktree.

---

## ⚠️ Troubleshooting: Git Versioning
If you see `fatal: NOT_A_GIT_REPOSITORY` errors on the host while the container is working, your host Git version is likely too old to read relative worktree paths.

**Fix (Ubuntu):**
```bash
sudo add-apt-repository ppa:git-core/ppa
sudo apt update
sudo apt install git
