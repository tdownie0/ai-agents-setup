/**
 * `round_seq` NOT NULL contract (beads task 800.4, W4).
 *
 * The carryover fold is ordered by `round_seq` and `replace` re-derives a stream
 * from that order, so a NULL would silently sort a stream's history into an
 * arbitrary sequence instead of failing loudly. The constraint therefore has to
 * hold at three layers at once, and this test pins all three: the Drizzle
 * schema (the source of truth), the generated snapshot, and the generated
 * migration SQL. Asserting only the migration would pass even after someone
 * hand-edited it, and asserting only the schema would pass even if the migration
 * were never regenerated.
 */

import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentRuns } from "../schema/portfolio.js";
import { roundJobs } from "../schema/roundJobs.js";

const MIGRATION = "../../drizzle/0005_make_round_seq_not_null.sql";
const SNAPSHOT = "../../drizzle/meta/0005_snapshot.json";

const TABLES = [
  { table: agentRuns, key: "public.agent_runs" },
  { table: roundJobs, key: "public.round_jobs" },
] as const;

function readMigration(): string {
  return readFileSync(new URL(MIGRATION, import.meta.url), "utf8");
}

interface SnapshotColumn {
  name: string;
  notNull?: boolean;
}

interface Snapshot {
  tables: Record<string, { columns: Record<string, SnapshotColumn> }>;
}

function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(new URL(SNAPSHOT, import.meta.url), "utf8")) as Snapshot;
}

describe("round_seq is NOT NULL in the schema", () => {
  for (const { table } of TABLES) {
    it(`${getTableConfig(table).name}.round_seq rejects null`, () => {
      const column = getTableConfig(table).columns.find(
        (candidate) => candidate.name === "round_seq",
      );
      expect(column).toBeDefined();
      expect(column?.notNull).toBe(true);
    });
  }
});

describe("the generated migration enforces NOT NULL", () => {
  const sql = readMigration();

  for (const { table } of TABLES) {
    const name = getTableConfig(table).name;
    it(`alters ${name}`, () => {
      expect(sql).toContain(`ALTER TABLE "${name}" ALTER COLUMN "round_seq" SET NOT NULL;`);
    });
  }

  it("does not add a default that would mask a missing round_seq", () => {
    // A DEFAULT 0 or DEFAULT nextval(...) would satisfy the constraint while
    // inventing a chain position, so the migration must not introduce one.
    expect(sql).not.toMatch(/SET DEFAULT/i);
  });
});

describe("the generated snapshot records the constraint", () => {
  const snapshot = readSnapshot();

  for (const { key } of TABLES) {
    it(`${key}.round_seq is notNull`, () => {
      expect(snapshot.tables[key]?.columns["round_seq"]?.notNull).toBe(true);
    });
  }
});
