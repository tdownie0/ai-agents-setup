/**
 * Repo-map prefix caching plugin.
 *
 * Injects a deterministic, git-SHA-versioned repository map into the system
 * prompt of every main request, anchored as its own system element right after
 * the core instructions. Auxiliary assemblies (title generation, `small=true`)
 * are skipped via a minimum system-length gate so the block never rides along
 * on a request that does not need it.
 *
 * Why: hosted inference endpoints that implement prefix/KV caching can only
 * reuse tokens whose byte-identical prefix has already been computed. When the
 * repo map is fetched mid-conversation at agent discretion, it sits behind a
 * variable prefix (agent reasoning, tool-call IDs) and is never cacheable
 * across sessions. Anchoring a stable block at the end of the system prompt
 * makes the map shareable across every request for the same code state —
 * cutting input-token cost and time-to-first-token for the whole model pool.
 *
 * Sources, in priority order (see LOAD steps below):
 *   1. `scripts/generate-repo-map.mjs` output  `.opencode/cache/repo-map.<sha>.txt`
 *   2. On-demand generation when missing: in-process fetch of `get_repo_map`
 *      through the mcp-gateway (same source as MCP_DOCKER_get_repo_map),
 *      cached to `.opencode/cache/repo-map.<sha>.txt` when writable
 *   3. Deterministic bounded tree walk (no external dependencies)
 *
 * Generation happens in-process (no spawned script) so the plugin never
 * depends on a local JS interpreter — agent containers often lack `node`
 * while the gateway stays reachable. The standalone
 * `scripts/generate-repo-map.mjs` remains the ops/CI pre-warm tool.
 *
 * Config (env):
 *   OPENCODE_REPO_MAP            "off" disables injection (default: on)
 *   OPENCODE_REPO_MAP_MAX_CHARS  cap for the injected block (default: 60000)
 *   OPENCODE_REPO_MAP_FILE       explicit map file path (default: auto-resolve)
 *   OPENCODE_REPO_MAP_TELEMETRY  JSONL telemetry path
 *                                (default: <os.tmpdir()>/opencode-repo-map-telemetry.jsonl)
 *
 * Fail-open: every failure path skips injection and records a telemetry line.
 * A broken map must never break chat.
 */

import { appendFileSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config (read once at plugin init; env is static per process)
// ---------------------------------------------------------------------------

const DISABLED = process.env.OPENCODE_REPO_MAP === "off";
const MAX_CHARS = Number.parseInt(process.env.OPENCODE_REPO_MAP_MAX_CHARS ?? "60000", 10) || 60000;
/**
 * Minimum total system-prompt length (chars) for the block to be injected.
 * Auxiliary assemblies (title generation, `small=true`) build a tiny system
 * array (~2K chars vs ~81K for a real request) — gating on length keeps the
 * block off those calls and, crucially, out of a slot that would otherwise
 * be consumed before the main request assembly runs.
 */
const MIN_SYSTEM_CHARS = 10_000;
const EXPLICIT_FILE = (process.env.OPENCODE_REPO_MAP_FILE ?? "").trim();
const TELEMETRY_PATH =
  (process.env.OPENCODE_REPO_MAP_TELEMETRY ?? "").trim() ||
  path.join(tmpdir(), "opencode-repo-map-telemetry.jsonl");

const HEADER = "## Repo Map (code structure)";
/**
 * Substring that only exists inside an injected block (see wrap()) — used for
 * dedup instead of HEADER, which can legitimately appear in user/system text
 * (e.g. this feature's own AGENTS.md documents the header literal).
 */
const BLOCK_MARKER = "Usage note: this repository map is injected automatically.";
const TRUNCATE_NOTICE = `\n\n...[truncated at ${MAX_CHARS} chars; raise OPENCODE_REPO_MAP_MAX_CHARS for more]`;
const GENERATE_TIMEOUT_MS =
  Number.parseInt(process.env.OPENCODE_REPO_MAP_TIMEOUT_MS ?? "30000", 10) || 30_000;
const DEBUG = process.env.OPENCODE_REPO_MAP_DEBUG === "1";

// Directory names that never contribute to the fallback tree.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".dolt",
  ".beads",
  ".pi",
  ".opencode",
  ".cache",
  ".pnpm-store",
  ".turbo",
  ".next",
  ".data",
  ".venv",
  "dist",
  "out",
  "build",
  "coverage",
  "__pycache__",
]);

// Extensions that contribute to the fallback tree (byte-stable sort, no timestamps).
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".sql",
  ".sh",
  ".css",
  ".html",
  ".toml",
]);

// ---------------------------------------------------------------------------
// Telemetry (append-only JSONL; never throws)
// ---------------------------------------------------------------------------

type TelemetryEvent = {
  ts: string;
  sha?: string;
  kind?: "file" | "generated" | "builtin";
  chars?: number;
  model?: string;
  sessionID?: string;
  event: string;
  detail?: string;
};

function telemetry(event: TelemetryEvent) {
  try {
    appendFileSync(TELEMETRY_PATH, `${JSON.stringify(event)}\n`);
  } catch {
    // no-op: telemetry must never break chat
  }
}

function debugTelemetry(event: TelemetryEvent) {
  if (!DEBUG) return;
  telemetry(event);
}

// ---------------------------------------------------------------------------
// Map loading
// ---------------------------------------------------------------------------

type MapBlock = {
  sha: string;
  kind: "file" | "generated" | "builtin";
  chars: number;
  text: string;
};

let blockPromise: Promise<MapBlock | null> | null = null;

/**
 * git SHA for the project root, read from the filesystem — no git binary
 * required (agent containers mock git). Resolves plain repos, `gitdir:`
 * worktree links, `commondir`-relative refs, and packed refs.
 * Empty string when unavailable.
 */
async function currentSha(root: string): Promise<string> {
  const HEX40 = /^[0-9a-f]{40}$/i;

  let gitDir: string | null = null;
  try {
    const stat = await lstat(path.join(root, ".git"));
    gitDir = stat.isDirectory() ? path.join(root, ".git") : null;
    if (!gitDir) {
      const link = (await readFile(path.join(root, ".git"), "utf8")).trim();
      const m = link.match(/^gitdir:\s*(.+)$/);
      if (m) gitDir = path.isAbsolute(m[1].trim()) ? m[1].trim() : path.join(root, m[1].trim());
    }
  } catch {
    gitDir = null;
  }
  if (!gitDir) return "";

  const readRef = async (p: string): Promise<string> => {
    try {
      const text = (await readFile(p, "utf8")).trim();
      return HEX40.test(text) ? text.toLowerCase() : "";
    } catch {
      return "";
    }
  };

  try {
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (HEX40.test(head)) return head.toLowerCase();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim();
    if (ref) {
      let common = gitDir;
      try {
        const c = (await readFile(path.join(gitDir, "commondir"), "utf8")).trim();
        common = path.resolve(gitDir, c);
      } catch {
        // plain repo: refs live in the git dir itself
      }
      const fromSelf = await readRef(path.join(gitDir, ref));
      if (fromSelf) return fromSelf;
      const fromCommon = await readRef(path.join(common, ref));
      if (fromCommon) return fromCommon;
      try {
        const packed = await readFile(path.join(common, "packed-refs"), "utf8");
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

async function fileBlock(
  file: string,
  sha: string,
  kind: "file" | "generated",
): Promise<MapBlock | null> {
  try {
    const text = await readFile(file, "utf8");
    if (!text.trim()) return null;
    const capped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}${TRUNCATE_NOTICE}` : text;
    return { sha, kind, chars: capped.length, text: capped };
  } catch {
    return null;
  }
}

function wrap(block: MapBlock): string {
  const shaLabel = block.sha ? ` — sha ${block.sha}` : "";
  return (
    `\n\n${HEADER}${shaLabel}\n\n` +
    block.text +
    `\n\nUsage note: this repository map is injected automatically. Prefer it over ` +
    `MCP_DOCKER_get_repo_map(); call the tool only for a refreshed or sub-directory-scoped map.\n`
  );
}

/**
 * Deterministic bounded tree walk — the zero-dependency fallback that
 * guarantees the block is always present. Entries are code-unit sorted,
 * symlinks are not followed, and output is capped by MAX_CHARS.
 */
async function builtinBlock(root: string, sha: string): Promise<MapBlock> {
  const { readdir, lstat } = await import("node:fs/promises");

  const lines: string[] = [];
  let chars = 0;

  const push = (line: string) => {
    const next = chars + line.length + 1;
    if (next > MAX_CHARS) return false;
    lines.push(line);
    chars = next;
    return true;
  };

  // Iterative DFS: deterministic, no stack overflow on deep trees.
  const queue: Array<{ rel: string; abs: string; depth: number }> = [
    { rel: "", abs: root, depth: 0 },
  ];

  while (queue.length > 0) {
    const { rel, abs, depth } = queue.pop()!;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (depth >= 8) continue;
        if (!push(`${relPath}/`)) return finish(lines, sha, chars);
        queue.push({ rel: relPath, abs: path.join(abs, entry.name), depth: depth + 1 });
      } else if (entry.isFile()) {
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        let size = 0;
        try {
          size = (await lstat(path.join(abs, entry.name))).size;
        } catch {
          continue;
        }
        if (!push(`  ${relPath} (${size} B)`)) return finish(lines, sha, chars);
      }
    }
  }

  return finish(lines, sha, chars);
}

function finish(lines: string[], sha: string, chars: number): MapBlock {
  const text =
    lines.length === 0
      ? "(no source files matched the fallback tree walk)"
      : `Repo tree (mode: builtin, deterministic fallback):\n${lines.join("\n")}`;
  return { sha, kind: "builtin", chars: Math.max(chars, text.length), text };
}

/**
 * Resolves a writable cache path for the map, preferring the project-local
 * `.opencode/cache` and falling back to the OS tmp dir for read-only mounts
 * (e.g. the main repo mounted read-only into agent containers). Returns null
 * when neither location is writable.
 */
async function writableCachePath(root: string, sha: string): Promise<string | null> {
  const candidates = [
    path.join(root, ".opencode", "cache"),
    path.join(tmpdir(), "opencode-repo-map"),
  ];
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      return path.join(dir, `repo-map.${sha}.txt`);
    } catch {
      // read-only or unwritable -> try the next location
    }
  }
  return null;
}

/**
 * Minimal MCP client (streamable HTTP) — mirrors scripts/generate-repo-map.mjs
 * so the plugin can materialize the rich map in-process through the
 * mcp-gateway without depending on a local JS interpreter.
 */
function parseSse(
  text: string,
): Array<{ id?: number; result?: unknown; error?: { message?: string } }> {
  const messages: Array<{ id?: number; result?: unknown; error?: { message?: string } }> = [];
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

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
}

function deriveAstPath(dir: string, wsRoot: string): string | null {
  const rel = path.relative(wsRoot, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

async function gatewayFetch(
  url: string,
  authToken: string,
  sessionId: string | null,
  payload: object,
): Promise<{ session: string | null; status: number; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  return {
    session: res.headers.get("mcp-session-id") ?? sessionId,
    status: res.status,
    text: await res.text(),
  };
}

async function initGatewaySession(url: string, authToken: string): Promise<string | null> {
  const attempt = async (protocolVersion: string): Promise<string | null> => {
    const { session, text } = await gatewayFetch(url, authToken, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "opencode-repo-map-plugin", version: "1.0.0" },
      },
    });
    const msg = parseSse(text).find((m) => m.id === 1);
    if (msg?.error ?? !msg?.result) return null;
    return session;
  };

  const session = (await attempt("2025-03-26")) ?? (await attempt("2024-11-05"));
  if (!session) return null;
  try {
    await gatewayFetch(url, authToken, session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  } catch {
    // notification failures are non-fatal
  }
  return session;
}

async function fetchRepoMapViaGateway(root: string): Promise<string | null> {
  const gateway = `http://${process.env.MCP_GATEWAY_HOST ?? "mcp-gateway"}:8811/mcp`;
  const token = process.env.MCP_GATEWAY_AUTH_TOKEN ?? "";
  const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? "/app");
  const astPath = deriveAstPath(root, workspaceRoot);
  debugTelemetry({
    ts: new Date().toISOString(),
    event: "fetch-enter",
    detail: `${gateway} astPath=${astPath}`,
  });
  if (!astPath) return null;

  let session = await initGatewaySession(gateway, token);
  debugTelemetry({
    ts: new Date().toISOString(),
    event: "fetch-session",
    detail: session ? `id=${session}` : "null",
  });
  if (!session) return null;

  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_repo_map", arguments: { path: astPath } },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      debugTelemetry({
        ts: new Date().toISOString(),
        event: "fetch-call",
        detail: `attempt=${attempt}`,
      });
      const {
        session: nextSession,
        status,
        text,
      } = await gatewayFetch(gateway, token, session, payload);
      session = nextSession ?? session;
      debugTelemetry({
        ts: new Date().toISOString(),
        event: "fetch-call-done",
        detail: `status=${status} bytes=${text.length}`,
      });
      const msg = parseSse(text).find((m) => m.id === 2);
      if (msg?.error) return null;
      const map = msg?.result ? contentText((msg.result as { content?: unknown }).content) : "";
      if (map) return map;
      // Retry once on a stale-session 404 (gateway restarted mid-flight).
      if (status === 404 && attempt === 0) {
        session = await initGatewaySession(gateway, token);
        if (session) continue;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Attempts to materialize the rich map in-process through the mcp-gateway and
 * cache it at the writable location. Returns null when the gateway is
 * unreachable, the tool fails, or no cache location is writable — callers fall
 * back to the deterministic tree walk.
 */
async function generateIfWritable(root: string, sha: string): Promise<MapBlock | null> {
  const out = await writableCachePath(root, sha);
  if (!out) return null;
  const mapText = await fetchRepoMapViaGateway(root);
  if (!mapText) return null;
  try {
    await writeFile(out, mapText);
  } catch {
    return null;
  }
  const capped =
    mapText.length > MAX_CHARS ? `${mapText.slice(0, MAX_CHARS)}${TRUNCATE_NOTICE}` : mapText;
  return { sha, kind: "generated", chars: capped.length, text: capped };
}

function buildBlock(root: string): Promise<MapBlock | null> {
  blockPromise ??= (async (): Promise<MapBlock | null> => {
    // Fast path: explicit file from env.
    debugTelemetry({ ts: new Date().toISOString(), event: "build-enter", detail: root });
    if (EXPLICIT_FILE) {
      const block = await fileBlock(EXPLICIT_FILE, "", "file");
      if (block) return block;
    }

    const sha = await currentSha(root);
    debugTelemetry({ ts: new Date().toISOString(), event: "build-sha", detail: sha || "<none>" });

    // Priority 1: sha-keyed generated file (skipped when git HEAD is unknown).
    if (sha) {
      const cacheFile = path.join(root, ".opencode", "cache", `repo-map.${sha}.txt`);
      const cached = await fileBlock(cacheFile, sha, "file");
      if (cached) return cached;
    }

    // Priority 2: generate once per code state (with tmp-dir fallback for
    // read-only roots). The hot path must never block on the network — the
    // gateway round-trip (~seconds) far exceeds opencode's system-prompt
    // assembly window. Race generation against a short deadline; if it loses,
    // keep it running in the background so the cache file materializes for
    // subsequent requests, and inject the deterministic fallback now.
    if (sha) {
      const attempt = generateIfWritable(root, sha);
      const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), 150));
      const generated = await Promise.race([attempt, deadline]);
      if (generated) return generated;
      attempt
        .then((late) => {
          if (late) {
            telemetry({
              ts: new Date().toISOString(),
              sha: late.sha,
              kind: late.kind,
              chars: late.chars,
              event: "generated-late",
            });
          }
        })
        .catch(() => {
          // background generation failure is non-fatal; builtin covers this request
        });
    }

    // Priority 3: deterministic fallback, always available.
    return builtinBlock(root, sha);
  })().catch((error) => {
    telemetry({ ts: new Date().toISOString(), event: "load-error", detail: String(error) });
    return null;
  });
  return blockPromise;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const RepoMapCaching = async ({
  directory,
  worktree,
}: {
  directory: string;
  worktree?: string;
}) => {
  const root = worktree || directory;
  // Auxiliary assemblies (title, `small=true`) and every real request each get
  // a fresh `system` array, so no session-level dedup is needed — the length
  // gate below keeps the block off aux calls, and the HEADER check prevents
  // double-append if opencode ever reuses an array.

  return {
    /**
     * Append the repo-map block to the system prompt of main requests.
     * The block is a separate `string[]` element, so the existing system
     * parts (and thus the common prefix across all requests) stay untouched.
     */
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: { modelID?: string } },
      output: { system: string[] },
    ) => {
      if (DISABLED) return;
      if (!Array.isArray(output.system)) return;

      const sessionID = input.sessionID ?? "anonymous";
      debugTelemetry({
        ts: new Date().toISOString(),
        event: "transform-call",
        sessionID,
        model: input.model?.modelID,
        detail: `systemParts=${output.system.length} lens=${output.system.map((p: string) => p.length).join(",")}`,
      });
      const systemChars = output.system.reduce((n, part) => n + part.length, 0);
      if (systemChars < MIN_SYSTEM_CHARS) {
        debugTelemetry({
          ts: new Date().toISOString(),
          event: "transform-skip-aux",
          sessionID,
          detail: `systemChars=${systemChars}`,
        });
        return;
      }
      if (output.system.some((part) => part.includes(BLOCK_MARKER))) return;

      debugTelemetry({ ts: new Date().toISOString(), event: "hook-enter", sessionID });
      const block = await buildBlock(root);
      debugTelemetry({
        ts: new Date().toISOString(),
        event: "hook-block-done",
        sessionID,
        detail: block ? `${block.kind} chars=${block.chars}` : "null",
      });
      if (!block) {
        telemetry({
          ts: new Date().toISOString(),
          sha: "",
          event: "skipped-no-map",
          sessionID,
          model: input.model?.modelID,
        });
        return;
      }

      output.system.push(wrap(block));
      debugTelemetry({
        ts: new Date().toISOString(),
        event: "transform-pushed",
        sessionID,
        detail: `systemParts=${output.system.length} lastLen=${wrap(block).length}`,
      });
      telemetry({
        ts: new Date().toISOString(),
        sha: block.sha,
        kind: block.kind,
        chars: block.chars,
        event: "injected",
        sessionID,
        model: input.model?.modelID,
      });
    },

    /**
     * Record every redundant live fetch of the map tool, for the before/after
     * validation dashboard (agents should rely on the injected block).
     */
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      _output: unknown,
    ) => {
      if (input.tool !== "MCP_DOCKER_get_repo_map") return;
      telemetry({
        ts: new Date().toISOString(),
        event: "get_repo_map-called",
        sessionID: input.sessionID,
        detail: input.callID,
      });
    },
  };
};

export default RepoMapCaching;
