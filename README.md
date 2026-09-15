# AI-Agents-Setup

## Introduction

This repository was created with the aim of being a helpful development bootstrap for developers
that would like to harness AI tools while working on software development tasks. Specifically in
this case, the application included in the repository is a web application. This does not mean
that this structure can only be used for web application purposes, rather it is more of a blueprint
for workflow automation with AI. To demonstrate this end, the custom MCP servers included in
`apps/mcp-servers` serve as examples of the extension capabilities with this setup, relying on
Docker's `mcp-gateway` MCP toolkit to bring these additional tools in. Once these MCP servers are
included, they can be incorporated in multiple applications, as long as they work with
`mcp-gateway` (Docker's MCP orchestrator), or directly with the MCP toolkit. Such examples could be
CLI tools like Pi AI coding tool, or even GUI frontends like Claude Desktop.

With those details out of the way, we can move on to the installation phase. Really, once Docker
is configured correctly, this application should work out of the box, allowing users to spin up
an available AI coding agent container, and begin having it develop features in isolated environments.

### Installation

This structure requires access to the parent directory of wherever the main project will live.
In order to facilitate creating separate worktrees under a `worktrees/` directory inside the
parent, this structure is required.

Currently, `go-task` is used for much of the installation, and can be installed from here: [`Taskfile`](https://taskfile.dev/).

> ⚠️ **Privilege model**: The following install uses `sudo` for docker related tasks, assuming the user
> may not be included in the docker group. This is due to being able to mount arbitrary volumes
> on the system and such related manipulations with docker control. Using **password-gated sudo**
> provides a human-presence check an agent cannot pass. The Taskfile detects `SUDO_UID`/`SUDO_GID`
> and uses `${HOST_HOME}` (set in `.env`) instead of `~`, so the stack runs with the right
> identity and the right config paths even under sudo. Tasks that only write host files (`mcp:setup`,
> `db:install-supabase-cli`) must **not** be run with sudo.

The first Taskfile command will build these MCP servers as docker images so we can use their
containers.

```bash
sudo go-task mcp:build-servers
```

Next we will generate a local MCP configuration files to be added to whichever path the machine's
Docker catalogs are set in the `.env`:

```bash
go-task mcp:setup
```

Running this generates the local catalog into `$LOCAL_MCP_REGISTRY` — an **absolute**
path inside the parent workspace (`.docker/mcp`).

Now, the supabase CLI can be installed to interact with the main project directory, and have
access to the GUI for the database. This is installed separate due to not working as a node_module
with pnpm:

```bash
go-task db:install-supabase-cli
```

Once this is done, these commands can be used to interact with the service (which provides the
auth for the application):

```bash
sudo go-task db:up

sudo go-task db:down
```

Additionally, we will need this volume created for the application — this also
creates the user-owned `worktrees/` directory, which lives in the parent directory,
and the agents write feature code into:

```bash
sudo go-task build:docker-assets
```

After this, the stack can be built using this Docker command:

```bash
sudo go-task up P=agent-core -- --build
```

From here you may choose any of the currently available AI CLI tools in the current
infra/docker-compose.yml file, or add your own. Currently the options are Antigravity, OpenCode,
and Pi. They can be selected through their assigned profiles, their names are currently all
lowercase.

For example:

```bash
sudo go-task up P="agent-core antigravity" -- --build
```

These AI CLIs can also be individiually brought up and down from the main stack like so:

```bash
sudo go-task ai:up P=antigravity

sudo go-task ai:down P=antigravity
```

The AI CLI containers are fully isolated from your host profile: they never mount
(or write to) your real `~/.config/opencode`, `~/.pi`, `~/.config/antigravity`, etc.
Instead, each container's configuration is seeded **from the configs this project
ships** (`opencode.json`, `.pi/`) into a project-local copy in the parent workspace
(`${PROJECT_PARENT_PATH}/.docker/<tool>/`), which is then bind-mounted into the
container. The container's baseline is exactly what this repo establishes — the
`mcp-gateway` connection and agent rules — never your personal host settings.
Before starting a tool for the first time (or to re-seed after a config change in
this repo), run the setup — this must **not** be run with sudo:

```bash
# One tool, several, or all (same usage as profiles)
go-task ai:setup P=opencode
go-task ai:setup P="pi antigravity"
go-task ai:setup
```

Copy semantics: **config only, never state and never credentials.** Files the tool
writes at runtime (opencode.db, snapshots, logs, caches) are only ever created inside
the container's bind-mounted directory — they never touch the host. `auth.json`,
tokens, and keys are excluded; API keys flow exclusively through `.env` ->
container environment variables. Re-running `ai:setup` only fills gaps (no-clobber),
so edits you make inside `${PROJECT_PARENT_PATH}/.docker/<tool>/` are preserved; to
force a full refresh from the project config, delete that tool's directory and re-run.
User-level personalization (extra models, custom skills, personal provider keys)
is a future opt-in overlay; today the containers are 100% project-derived by design.

### Host-Side AI CLIs (no container, no docker network)

You can also run an AI CLI **directly on your host** and still use this project's
MCP toolchain. The stack's `mcp-gateway` publishes `127.0.0.1:8811` on the host
loopback, so a host-side agent just points its MCP client at
`http://127.0.0.1:8811/mcp` — **no need to join any docker network**.

Recommended for host-side usage (see `opencode.json` / `.pi/mcp.json` for the shape):

```jsonc
{
  "mcp": {
    "model_md": {
      "type": "remote",
      "url": "http://127.0.0.1:8811/mcp",
      "headers": { "Authorization": "Bearer ${MCP_GATEWAY_AUTH_TOKEN}" }
    }
  }
}
```

Notes and caveats:

- The gateway is only reachable this way while the stack is up
  (`sudo go-task up P=agent-core`). The auth token comes from `.env`
  (`MCP_GATEWAY_AUTH_TOKEN`).
- **Sandbox tradeoff**: a host-side agent has your host's filesystem and shell
  permissions. The containerized agents are deliberately restricted (read-only
  project mount, isolated `agent-network`, worktree-only writes); running locally
  bypasses those boundaries, so only do this on your own machine with your own
  credentials.
- The git-orchestrator and ast-explorer MCP servers are designed around the
  worktree layout; the worktree creation flow (`initialize_worktree`) works the
  same from a local client as from a container.

Once this is completed, for anyone that would like to log into the demonstration site and create a
user to interact with it, they can visit `http://localhost:54323/project/default`. From here,
the `Authentication` menu option should be located and clicked upon. After doing so, there
should be a green button for `Add user` on the screen. This can be toggled, and
`Create new user` selected. At this point, any email and password can be
selected for a testing account. The option `Auto Confirm User?` can be left selected so the
account is automatically verified for authentication.

From here, we should be able to login to the site and see the Users page load. To use the user we
just created in the authentication process, we can populate the `.env` variable `TEST_USER_ID` with
the UID that should now be on the Supabase page.

Since an environment variable has been updated, we will have to run these commands specifically
for the backend to update the value:

```bash
sudo go-task app:down -- backend

sudo go-task app:up
```

The Users model can be seeded with data so that users can appear in the table. To do so, we run
the following commands:

```bash
sudo go-task db:migrate

sudo go-task db:seed
```

If this does not cause the current logged in user to have notifications, or if the database needs
to be reset, this following command can be ran, which will reset the database and run migrations.
The database can be seeded again as well.

```bash
sudo go-task db:reset

sudo go-task db:seed
```

The agent-core profile includes the mcp-gateway, the orchestrator-worker, and a cache. Agents
do **not** join the main `dev-network`: they run on a dedicated `agent-network` from which the
only reachable services are `mcp-gateway` (tool calls) and `dolt` (beads) — never the Docker
socket proxy or the database/cache. The parent workspace is mounted **read-only** into the AI
CLI containers; the only writable bind is `worktrees/` (feature code) plus the main repo's
`.git` for the git-orchestrator server. The AI CLI can be selected by the user. In this case
we will use Pi as an example, assuming this is spun up for an AI CLI container. Once this
is all up, Pi can be interacted with like so (also similarly for the other options):

```bash
sudo docker exec -it pi_agent pi
sudo docker exec -it opencode_agent opencode
```

With the Pi AI Coding tool, this setup is currently implemented to use the /subagent orchestration
skill. Examples are provided in the samples/ directory. OpenCode is currently configured to use
the /ulw-loop from oh-my-openagent for its orchestration. The file, session-ses_auth_sample,
includes a run that builds the registration page, along with the prompt used to get the agents to
do so. In particular, if similar prompts are used along with the MCPs, the ast-explorer and
git-orchestrator should assist in building a feature, creating it in a separate worktree, as well
as analyzing the structure of the code files included.

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
it cannot just call any git command. This contrasts in comparison to an AI agent installed locally
running through a CLI, which would have access to any tools provided by the shell based on the permissions
granted to the user running the process.
