# AI-Agents-Setup

## Introduction

This repository was created with the aim of being a helpful development bootstrap for developers
that would like to harness AI tools while working on software development tasks. Specifically in
this case, the application included in the repository is a web application. This does not mean
that this structure can only be used for web application purposes, rather it is more of a blueprint
for workflow automation with AI. To demonstrate this end, the custom MCP servers included in
`apps/mcp-servers` serve as examples of the extension capabilities with this setup, relying on
Docker Desktop's MCP toolkit to bring these additional tools in. Once they are incorporated through
this medium, these MCPs can be incorporated in multiple applications, as long as they work with
mcp-gateway (Docker's MCP orchestrator), or directly with the MCP toolkit. Such examples could be
CLI tools like opencode, or even GUI frontends like Claude Desktop.

With those details out of the way, we can move on to the installation phase. Really, once Docker
is configured correctly, this application should work out of the box, allowing users to spin up the
Opencode container, and begin having it develop features in isolated environments.

### Installation

This structure requires access to the parent directory of wherever the main project will live.
In order to facilitate creating separate worktrees that are sibling directories to the main
directory, this structure is required. It also requires that the end user has Docker Desktop
installed on their machine (though users may be able to get away with another containerization
strategy as long as they can build the mcp-gateway and register MCP servers).

The first Taskfile command will build these MCP servers as docker images so we can use their
containers.

```bash
task build:mcp-servers
```

Next we will generate a local MCP configuration files to be added to whichever path the machine's
Docker Desktop installation happens to live:

```bash
task setup:mcp
```

Running this should generate output the instructs the user where these files should live. For this
to work properly, .env variables will have to be populated properly, and then the process should
be automated for generation. After this, the user will just have to move the files to the proper
locations, and then enable the MCP servers through docker mcp server.

Now, the supabase CLI can be installed to interact with the main project directory, and have
access to the GUI for the database. This is installed separate due to not working as a node_module
with pnpm:

```bash
task install:supabase-cli
```

Once this is done, these commands can be used to interact with the service (which provides the
auth for the application):

```bash
pnpm supabase:start

pnpm supabase:stop
```

Additionally, we will need this volume created for the application:

```bash
docker volume create pnpm_store
```

After this, the stack can be built using this Docker command:

```bash
docker compose --profile agent up --build
```

Once this is completed, for anyone that would like to log into the demonstration site and create a
user to interact with it, they can visit `http://localhost:54323/project/default`. From here, at
the top right of the screen is a menu toggle, and once this is selected, `Authentication` can be
clicked upon. After doing so, we should see a green button for `Add user` on the screen. This
can be toggled, and `Create new user` selected. At this point, any email and password can be
selected for a testing account. The option `Auto Confirm User?` can be left selected so the
account is automatically verified for authentication.

From here, we should be able to login to the site and see the Users page load. If we would like
to create data for this specific user, we can populate the `.env` variable `TEST_USER_ID` with
the UID that was created in the process, and that should now be on the Supabase page.

Since an environment variable has been updated, we will have to run these commands specifically
for the backend to update the value:

```bash
docker compose stop backend

docker compose up backend
```

The Users model can be seeded with data so that users can appear in the table. To do so, we run
the following commands:

```bash
docker compose exec backend pnpm db:migrate

docker compose exec backend pnpm db:seed
```

If this does not cause the current logged in user to have notifications, or if the database needs
to be reset, this following command can be ran, which will reset the database and run migrations.
The database can be seeded again as well.

```bash
docker compose exec backend pnpm db:reset

docker compose exec backend pnpm db:seed
```

The agent profile includes the mcp-gateway and the opencode container being spun up in addition
to the application. Once this is all up, opencode can be interacted with like so:

```bash
docker compose exec opencode opencode
```

This repository is intended to be used with multiple agents inside Opencode, in the past using
a setup that allowed for /task, and is now experimenting with /ulw. Examples are provided in the
samples/ directory. The file, session-ses_auth_sample, includes a run that builds the registration
page, along with the prompt used to get the agents to do so. In particular, if this prompt is used
along with the MCPs, the ast-explorer and git-orchestrator should assist in building a feature,
creating it in a separate worktree, as well as analyzing the structure of the code files included.

Both the of MCPs used in this example are tied to working with code, but both can be customized
in any manner by the end user. This allows for any tool to be refined further, improving their
implementations, or making them very specific to a subset of languages or particular workflows.
Both can be extended further in a similar manner to allow for more capabilities. They were designed
with the intention of demonstrating that this process can be reproduced to fit any particular need
of the end user.

Security wise, one of the biggest advantages with this Docker oriented setup is that volumes can
serve as a boundary for AI development tasks, which delegate which directories the agents can
interact with. This means that if an agent were to malfunction for some reason, there should be
some reasonable constraints already in place so that only the project could be destroyed, and not
the computer's entire file system.

Additionally, the MCPs themselves serve as an example of security boundaries. They are based on
Dockerfiles that define what technologies that MCP is able to use, and also these technologies
are gated behind the tool calls designed in the MCP. With this, even if an MCP has git installed,
it cannot just call any git command. This contrasts with an AI agent installed locally that would
have access to many of the tools installed natively, allowing it to try its
hand at calling them in the ways it desires.

Here comes the AI description:

# AI Assisted Code Development Workstation 🚀

A high-performance, containerized development environment designed for **Agent-Host Parity**.
This project enables AI agents to operate within a Docker ecosystem while maintaining the ability to spawn parallel Git worktrees and access deep code intelligence via MCP.
Using this approach, MCP tools can be added through the Docker MCP toolkit, its catalogue, or direclty to opencode.

## 🏗 Architectural Overview

This system bridges the gap between a local host and AI agents using a modular, "Gateway-first" approach:

- **MCP Gateway:** Centralized communication hub using `mcp-gateway` to expose multiple tools to the AI via a single SSE (Server-Sent Events) endpoint.
- **Custom MCP Services:** Includes specialized tools like the `ast-mcp-service` (AST Explorer), which runs in its own container to provide the agent with deep semantic understanding of the codebase.
- **Unified Identity:** Synchronized UID/GID (1000) between the host and container to ensure seamless file permissions across the volume.

---

## ⚡ Key Features

### 1. Parallel Worktree Orchestration

The environment is optimized for **Git Worktrees**. This allows the AI agent to:

- Spawn a new "physical" folder for every feature branch.
- Work on multiple features in parallel without "context-bleeding."
- Maintain a clean `main` repository while experimentation happens in sibling directories.
- Use `--relative-paths` to ensure Git remains compatible across the Host/Container boundary.

### 2. Docker-Native MCP

Unlike traditional setups where MCP servers run on the host, this project treats tools as **services**:

- **ast-mcp-service:** Provides an `ast-explorer` to index and search code logic, not just text.
- **Scalability:** New tools (Database explorers, Browser controllers, etc.) can be added simply by updating the `docker-compose.yml` and the Gateway config.

---

## 🛠 Setup & Installation

### Prerequisites

- Docker & Docker Compose
- Git 2.41+ (On the host for worktree compatibility)

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

- `/model_md`: The primary repository/anchor for the AI agent.
- `/ast-mcp-service`: Source and Dockerfile for the AST-based MCP server.
- `.opencode/commands`: Contains the `worktree_orchestration.md` protocol—the agent's "SOP" for managing parallel work.
- `../.`: This setup assumes that the user will have access to the parent directory of the current application's directory.
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
```
