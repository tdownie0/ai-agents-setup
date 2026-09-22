#!/usr/bin/env bun
// Aggregates ab.sh results: per-level means of input/cache.read/cache.write/
// total/latency, then a verdict comparing treatment vs control cache prefix.
// Usage: analyze.mjs [results.jsonl]   (default: /tmp/opencode/ab-results.jsonl)
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "/tmp/opencode/ab-results.jsonl";
const rows = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const byLevel = new Map();
for (const r of rows) {
  if (!byLevel.has(r.level)) byLevel.set(r.level, []);
  byLevel.get(r.level).push(r);
}

const fmt = (n) => Math.round(n).toString().padStart(6);

function agg(key) {
  const out = {};
  for (const [level, rs] of byLevel) {
    const vals = rs.map((r) => r[key] ?? 0);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    out[level] = { mean, min: Math.min(...vals), max: Math.max(...vals), n: vals.length };
  }
  return out;
}

console.log(`results: ${file}\n`);
for (const key of ["input", "cache_read", "cache_write", "total", "latency_ms"]) {
  const a = agg(key);
  console.log(
    `${key.padEnd(11)} ` +
      [...byLevel.keys()]
        .map(
          (l) =>
            `${l.padEnd(9)} mean=${fmt(a[l].mean)} min=${fmt(a[l].min)} max=${fmt(a[l].max)} n=${a[l].n}`,
        )
        .join("  "),
  );
}

const control = byLevel.get("control") ?? [];
const treatment = byLevel.get("treatment") ?? [];
if (control.length && treatment.length) {
  const ctx = (key) => control.reduce((s, r) => s + (r[key] ?? 0), 0) / control.length;
  const txx = (key) => treatment.reduce((s, r) => s + (r[key] ?? 0), 0) / treatment.length;
  const shared = (a, b) => ((b - a) / (a || 1)) * 100;

  console.log("\nverdict:");
  console.log(
    `  cache.read  control=${fmt(ctx("cache_read"))}  treatment=${fmt(txx("cache_read"))}  Δ=${fmt(txx("cache_read") - ctx("cache_read"))}`,
  );
  console.log(
    `  input       control=${fmt(ctx("input"))}  treatment=${fmt(txx("input"))}  Δ=${fmt(txx("input") - ctx("input"))}`,
  );
  console.log(
    `  latency_ms  control=${fmt(ctx("latency_ms"))}  treatment=${fmt(txx("latency_ms"))}  Δ=${fmt(txx("latency_ms") - ctx("latency_ms"))}  (${shared(ctx("latency_ms"), txx("latency_ms")).toFixed(1)}%)`,
  );

  const delta = txx("cache_read") - ctx("cache_read");
  if (delta > 5000)
    console.log(`  PASS: map block joined the cached prefix (+${fmt(delta)} tokens cached)`);
  else if (delta > 0)
    console.log(`  WEAK: cache delta (+${fmt(delta)}) too small to confirm prefix reuse`);
  else console.log("  FAIL: treatment cache.read not above control");
}
