# Repo Map Prefix Caching Feature

## Overview

The Repo Map Prefix Caching feature makes the repository's AST map a **deterministic, git-SHA-versioned
system-prompt element** instead of a mid-conversation tool result. Every opencode session for the same
code state receives the same byte-identical map block at the end of the system prompt. Hosted inference
endpoints that implement prefix / KV caching can reuse the already-computed prefix across every request
for that code state — cutting input-token cost and time-to-first-token across the whole model pool.

`MCP_DOCKER_get_repo_map` is demoted to the refresh / targeted path: it should only be called when the
injected map is stale (code changed mid-session) or a sub-directory-scoped map is needed.

**Status**: COMPLETED ✅
**Date**: 2026-09-21
**Feature Branch**: `feat-repo-map-caching`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        REPO MAP PREFIX CACHING FLOW                          │
└─────────────────────────────────────────────────────────────────────────────┘

  Session start (opencode, project root R)
           │
           ├─ 1. .opencode/plugins/repo-map.ts (auto-loaded plugin)
           │      │
           │      ├─ load 1: .opencode/cache/repo-map.<sha>.txt        (file)
           │      ├─ load 2: generate via scripts/generate-repo-map.mjs (generated)
           │      └─ load 3: deterministic bounded tree walk           (builtin)
           │
           ├─ 2. scripts/generate-repo-map.mjs
           │      └─ reads SHA from filesystem (no git binary; worktree-aware)
           │      └─ MCP JSON-RPC over HTTP → mcp-gateway:8811 → ast-explorer
           │             tools/call get_repo_map { path }   (workspace-relative)
           │      └─ writes .opencode/cache/repo-map.<sha>.txt
           │
           └─ 3. experimental.chat.system.transform hook
                  └─ appends "## Repo Map (code structure) — sha <sha>" block
                     once per session (byte-stable across requests)
```

### Key properties

- **Determinism**: map bytes are a pure function of the git HEAD SHA (and the ast-explorer index for
  that state). Same SHA → same block → maximal prefix reuse.
- **Fail-open**: every failure path (no git, read-only root, gateway down, generator timeout) skips
  injection and records a telemetry line. A broken map never breaks chat.
- **Source priority**: sha-keyed cache file → on-demand generation → zero-dependency tree walk.
- **Read-only roots**: the main repo is mounted read-only into agent containers; the plugin falls back
  to the OS tmp dir (`<os.tmpdir()>/opencode-repo-map/`) for the generated cache, and to the builtin
  tree walk if generation cannot run.
- **Session gating**: the block is injected once per session id (byte-stable per session); existing
  system elements are untouched.
- **No git binary**: the SHA is resolved from the filesystem (`.git/HEAD`, `gitdir:` worktree links,
  `commondir`, packed refs) because git is mocked/intercepted in agent containers.

---

## Files

| Path                            | Purpose                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `.opencode/plugins/repo-map.ts` | OpenCode plugin: injects the map block into the system prompt   |
| `scripts/generate-repo-map.mjs` | Generator: fetches `get_repo_map` via mcp-gateway, writes cache |
| `AGENTS.md`                     | Root protocol: injected-map policy, tool demotion               |
| `apps/backend/AGENTS.md`        | Backend spec: injected map first, ast-explorer for targeted use |
| `package.json`                  | `pnpm repo-map` script for on-demand regeneration               |

---

## Configuration (env)

| Variable                      | Default                                           | Effect                            |
| ----------------------------- | ------------------------------------------------- | --------------------------------- |
| `OPENCODE_REPO_MAP`           | `on`                                              | `off` disables injection          |
| `OPENCODE_REPO_MAP_MAX_CHARS` | `60000`                                           | cap for the injected block        |
| `OPENCODE_REPO_MAP_FILE`      | _(empty — auto-resolve)_                          | explicit map file path            |
| `OPENCODE_REPO_MAP_TELEMETRY` | `<os.tmpdir()>/opencode-repo-map-telemetry.jsonl` | JSONL event log                   |
| `MCP_GATEWAY_HOST`            | `mcp-gateway` (container default)                 | gateway URL used by the generator |
| `MCP_GATEWAY_AUTH_TOKEN`      | _(from `.env`)_                                   | gateway bearer token              |

Telemetry events: `injected` (with kind `file|generated|builtin` and char count),
`skipped-no-map`, `load-error`, `get_repo_map-called` — the last one feeds the before/after
validation dashboard (agents should rely on the injected block, not live tool calls).

---

## Ops Workflow

```bash
# Regenerate the current state's map on demand (host / orchestrator-worker with real env):
pnpm repo-map                                 # root of the repo
node scripts/generate-repo-map.mjs --root /app/worktrees/model_md-worktree-<slug> --out /tmp/map.txt

# Validate the gateway path derivation (no write):
node scripts/generate-repo-map.mjs --root /app/worktrees/model_md-worktree-<slug> --no-gateway

# Clear the cache when switching code states aggressively:
rm -rf .opencode/cache
```

Notes:

- The generator derives the ast-explorer path relative to `WORKSPACE_ROOT=/app`
  (`model_md` for the main repo, `worktrees/<slug>` for feature worktrees).
- No compose / lifecycle-action changes were made: the plugin's lazy generation is the runtime
  mechanism. Wiring a `repo-map` lifecycle action into `workflows.py` is a possible follow-up if
  operators want explicit post-merge regeneration.

---

## Verification

- `bun build --no-bundle .opencode/plugins/repo-map.ts` — clean transpile.
- `scripts/generate-repo-map.mjs` — deterministic filesystem SHA; gateway client handles
  protocol negotiation and session-invalidation retry (HTTP 404 → re-init), exits 0 only when
  a map was written.
- Workspace `verify` gate (tests + lint + format) — see lifecycle output in the worktree.
