#!/usr/bin/env node
/**
 * generate-repo-map.mjs — materialize a deterministic, git-SHA-versioned
 * repository map for prefix-cache-friendly prompt injection.
 *
 * The map is fetched from the ast-explorer service through the mcp-gateway
 * (the same source the MCP_DOCKER_get_repo_map tool uses), then written to
 * `.opencode/cache/repo-map.<sha>.txt`. The opencode plugin
 * (`.opencode/plugins/repo-map.ts`) anchors that file into the system prompt
 * once per session, so hosted inference endpoints can reuse a shared
 * byte-identical prefix across every request for the same code state.
 *
 * The ast-explorer resolves paths relative to its WORKSPACE_ROOT (default
 * `/app`), so the project path is derived from `--root`'s location:
 *   /app/model_md                                    -> "model_md"
 *   /app/worktrees/model_md-worktree-feat-x          -> "worktrees/.../feat-x"
 * Pass `--path` to override (e.g., a sub-directory-scoped map).
 *
 * Exit codes:
 *   0  map written
 *   1  no map produced (gateway/auth/derivation failure; nothing written —
 *      the plugin falls back to its deterministic tree walk)
 *
 * Usage:
 *   node scripts/generate-repo-map.mjs [--root <path>] [--out <path>]
 *       [--gateway <url>] [--token <token>] [--path <ast-path>]
 *       [--workspace-root <path>] [--timeout-ms <ms>] [--no-gateway]
 *
 * Env: MCP_GATEWAY_HOST (default "mcp-gateway"), MCP_GATEWAY_AUTH_TOKEN.
 */

import { lstatSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number.parseInt(args["timeout-ms"] ?? "15000", 10) || 15000;
const workspaceRoot = path.resolve(args["workspace-root"] ?? "/app");
const root = path.resolve(args.root ?? process.cwd());
const gateway = args.gateway ?? `http://${process.env.MCP_GATEWAY_HOST ?? "mcp-gateway"}:8811/mcp`;
const token = args.token ?? process.env.MCP_GATEWAY_AUTH_TOKEN ?? "";

/**
 * git SHA for the project root, read from the filesystem — no git binary
 * required (agent containers mock git). Resolves plain repos, `gitdir:`
 * worktree links, `commondir`-relative refs, and packed refs.
 * Empty string when unavailable.
 */
function gitSha(dir) {
  const HEX40 = /^[0-9a-f]{40}$/i;

  let gitDir = null;
  try {
    const stat = lstatSync(path.join(dir, ".git"));
    gitDir = stat.isDirectory() ? path.join(dir, ".git") : null;
    if (!gitDir) {
      const link = readFileSync(path.join(dir, ".git"), "utf8").trim();
      const m = link.match(/^gitdir:\s*(.+)$/);
      if (m) gitDir = path.isAbsolute(m[1].trim()) ? m[1].trim() : path.join(dir, m[1].trim());
    }
  } catch {
    gitDir = null;
  }
  if (!gitDir) return "";

  const readRef = (p) => {
    try {
      const text = readFileSync(p, "utf8").trim();
      return HEX40.test(text) ? text.toLowerCase() : "";
    } catch {
      return "";
    }
  };

  try {
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (HEX40.test(head)) return head.toLowerCase();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
    if (ref) {
      let common = gitDir;
      try {
        const c = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
        common = path.resolve(gitDir, c);
      } catch {
        // plain repo: refs live in the git dir itself
      }
      const fromSelf = readRef(path.join(gitDir, ref));
      if (fromSelf) return fromSelf;
      const fromCommon = readRef(path.join(common, ref));
      if (fromCommon) return fromCommon;
      try {
        const packed = readFileSync(path.join(common, "packed-refs"), "utf8");
        const line = packed.split("\n").find((l) => l.trim().endsWith(` ${ref}`));
        if (line) return line.trim().split(" ")[0]?.toLowerCase() ?? "";
      } catch {
        // no packed refs
      }
    }
  } catch {
    // fall through to ""
  }
  return "";
}

const sha = gitSha(root);
const out = args.out
  ? path.resolve(args.out)
  : path.join(root, ".opencode", "cache", `repo-map.${sha}.txt`);

function deriveAstPath(dir, wsRoot) {
  const rel = path.relative(wsRoot, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

const astPath = args.path ?? deriveAstPath(root, workspaceRoot);

// ---------------------------------------------------------------------------
// MCP client (streamable HTTP, minimal — enough to call get_repo_map)
// ---------------------------------------------------------------------------

function parseSse(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      messages.push(JSON.parse(line.slice(5).trim()));
    } catch {
      // ignore keep-alives / non-JSON data frames
    }
  }
  return messages;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

class HttpError extends Error {
  constructor(status, ...rest) {
    super(...rest);
    this.status = status;
  }
}

async function mcpCall(url, authToken, sessionId, payload, ms) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ms),
  });
  const session = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) {
    const err = new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return { session, text };
}

/**
 * initialize + notifications/initialized, negotiating the protocol version.
 * Returns a usable session id.
 */
async function initSession(url, authToken, ms) {
  const clientInfo = { name: "generate-repo-map", version: "1.0.0" };
  const attempt = async (protocolVersion) => {
    const { session, text } = await mcpCall(
      url,
      authToken,
      null,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion, capabilities: {}, clientInfo },
      },
      ms,
    );
    const msg = parseSse(text).find((m) => m.id === 1);
    if (msg?.error) throw new Error(`initialize: ${msg.error.message ?? "server rejected"}`);
    if (!msg?.result) throw new Error("initialize: unreadable response");
    return session;
  };

  let session;
  try {
    session = await attempt("2025-03-26");
  } catch {
    session = await attempt("2024-11-05");
  }

  try {
    await mcpCall(
      url,
      authToken,
      session,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ms,
    );
  } catch {
    // notification failures are non-fatal
  }
  return session;
}

async function callGetRepoMap(url, authToken, astPathParam, ms, sessionProvider) {
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_repo_map", arguments: { path: astPathParam } },
  };

  let session = await sessionProvider();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { session: nextSession, text } = await mcpCall(url, authToken, session, payload, ms);
      session = nextSession;
      const msg = parseSse(text).find((m) => m.id === 2);
      if (msg?.error) throw new Error(`get_repo_map: ${msg.error.message ?? "tool failed"}`);
      if (msg?.result) return msg.result;
      throw new Error("get_repo_map: unreadable response");
    } catch (err) {
      const staleSession = err instanceof HttpError && err.status === 404;
      if (staleSession && attempt === 0) {
        // Gateway restarted since initialize: refresh the session and retry once.
        session = await sessionProvider();
        continue;
      }
      throw err;
    }
  }
  throw new Error("get_repo_map: retry budget exhausted");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!astPath) {
    console.error(
      `generate-repo-map: cannot derive ast path for root ${root} under workspace-root ${workspaceRoot}; pass --path`,
    );
    process.exit(1);
  }

  let mapText = "";
  if (!args["no-gateway"]) {
    try {
      const result = await callGetRepoMap(gateway, token, astPath, timeoutMs, () =>
        initSession(gateway, token, timeoutMs),
      );
      mapText = contentText(result?.content);
    } catch (err) {
      console.error(`generate-repo-map: gateway fetch failed: ${err.message}`);
    }
  }

  if (!mapText) {
    console.error("generate-repo-map: no map produced; nothing written (plugin falls back)");
    process.exit(1);
  }

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, mapText);
  console.log(`generate-repo-map: wrote ${mapText.length} chars to ${out} (sha ${sha})`);
}

main().catch((err) => {
  console.error(`generate-repo-map: ${err.message}`);
  process.exit(1);
});
