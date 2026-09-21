/**
 * Repo-map prefix caching plugin.
 *
 * Injects a deterministic, git-SHA-versioned repository map into the system
 * prompt of every conversation (once per session), anchored as its own system
 * element right after the core instructions.
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
 *   2. On-demand generation of that file when missing and the root is writable
 *   3. Deterministic bounded tree walk (no external dependencies)
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

import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config (read once at plugin init; env is static per process)
// ---------------------------------------------------------------------------

const DISABLED = process.env.OPENCODE_REPO_MAP === "off";
const MAX_CHARS = Number.parseInt(process.env.OPENCODE_REPO_MAP_MAX_CHARS ?? "60000", 10) || 60000;
const EXPLICIT_FILE = (process.env.OPENCODE_REPO_MAP_FILE ?? "").trim();
const TELEMETRY_PATH =
  (process.env.OPENCODE_REPO_MAP_TELEMETRY ?? "").trim() ||
  path.join(tmpdir(), "opencode-repo-map-telemetry.jsonl");

const HEADER = "## Repo Map (code structure)";
const TRUNCATE_NOTICE = `\n\n...[truncated at ${MAX_CHARS} chars; raise OPENCODE_REPO_MAP_MAX_CHARS for more]`;
const GENERATE_TIMEOUT_MS = 30_000;

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
  void appendFile(TELEMETRY_PATH, `${JSON.stringify(event)}\n`).catch(() => {});
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
 * Attempts to generate the rich map via scripts/generate-repo-map.mjs (it
 * fetches get_repo_map through the mcp-gateway). Silently skipped when no
 * cache location is writable or when the script is absent.
 */
async function generateIfWritable(root: string, sha: string): Promise<{ out: string } | null> {
  const out = await writableCachePath(root, sha);
  if (!out) return null;
  const script = path.join(root, "scripts", "generate-repo-map.mjs");
  try {
    await execFileAsync(
      process.execPath,
      [script, "--root", root, "--out", out, "--timeout-ms", String(GENERATE_TIMEOUT_MS - 5_000)],
      { timeout: GENERATE_TIMEOUT_MS },
    );
    return { out };
  } catch {
    return null;
  }
}

function buildBlock(root: string): Promise<MapBlock | null> {
  blockPromise ??= (async (): Promise<MapBlock | null> => {
    // Fast path: explicit file from env.
    if (EXPLICIT_FILE) {
      const block = await fileBlock(EXPLICIT_FILE, "", "file");
      if (block) return block;
    }

    const sha = await currentSha(root);

    // Priority 1: sha-keyed generated file (skipped when git HEAD is unknown).
    if (sha) {
      const cacheFile = path.join(root, ".opencode", "cache", `repo-map.${sha}.txt`);
      const cached = await fileBlock(cacheFile, sha, "file");
      if (cached) return cached;
    }

    // Priority 2: generate once per code state (with tmp-dir fallback for
    // read-only roots).
    const generated = sha ? await generateIfWritable(root, sha) : null;
    if (generated) {
      const fresh = await fileBlock(generated.out, sha, "generated");
      if (fresh) return fresh;
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
  // Which sessionIDs already received the block this process (byte-stable per session).
  const injected = new Set<string>();

  return {
    /**
     * Append the repo-map block to the system prompt, once per session.
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
      if (injected.has(sessionID)) return;
      if (output.system.some((part) => part.includes(HEADER))) {
        injected.add(sessionID);
        return;
      }

      const block = await buildBlock(root);
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
      injected.add(sessionID);
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
