#!/usr/bin/env bun
// Emits one JSONL row for the given opencode session: token usage from the
// assistant message of an `opencode run`, plus level/rep/latency passed via env.
// Usage: LVL=... REP=... LATENCY_MS=... query-session.mjs <session-id>
import { Database } from "bun:sqlite";

const sid = process.argv[2];
if (!sid) process.exit(1);

const dbPath = process.env.OPENCODE_DB ?? "/home/devuser/.local/share/opencode/opencode.db";
const db = new Database(dbPath, { readonly: true });
const rows = db
  .query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created")
  .all(sid);

let tokens = null;
for (const r of rows) {
  const d = JSON.parse(r.data);
  if (d.role === "assistant" && d.tokens && typeof d.tokens.total === "number") tokens = d.tokens;
}

const row = {
  level: process.env.LVL ?? "",
  rep: Number(process.env.REP ?? 0),
  latency_ms: Number(process.env.LATENCY_MS ?? 0),
  session: sid,
  input: tokens?.input ?? 0,
  output: tokens?.output ?? 0,
  total: tokens?.total ?? 0,
  cache_read: tokens?.cache?.read ?? 0,
  cache_write: tokens?.cache?.write ?? 0,
};
if (!tokens) row.error = "no assistant tokens";
console.log(JSON.stringify(row));
