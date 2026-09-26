/**
 * Pure unit tests for CLI argument parsing.
 */

import { describe, expect, it } from "vitest";
import { CliArgError, parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("parses the full option set", () => {
    const opts = parseCliArgs([
      "--round",
      "round-2026-09-24",
      "--capital",
      "250000",
      "--agents",
      "dr-value,dr-momentum",
      "--window",
      "monthly,weekly",
      "--out",
      "./data",
      "--max-parallel",
      "5",
    ]);
    expect(opts).toEqual({
      round: "round-2026-09-24",
      capital: 250000,
      agents: ["dr-value", "dr-momentum"],
      window: ["monthly", "weekly"],
      out: "./data",
      maxParallel: 5,
      replicates: 3,
    });
  });

  it("applies defaults", () => {
    const opts = parseCliArgs(["--round", "r1"]);
    expect(opts).toEqual({
      round: "r1",
      capital: 100000,
      agents: "all",
      window: "all",
      out: "./rounds",
      maxParallel: 3,
      replicates: 3,
    });
  });

  it("treats --window all as the every-window sentinel", () => {
    expect(parseCliArgs(["--round", "r1", "--window", "all"])).toMatchObject({ window: "all" });
  });

  it("trims and drops empty entries in --window", () => {
    const opts = parseCliArgs(["--round", "r1", "--window", " daily , , monthly "]);
    expect(opts).toMatchObject({ window: ["daily", "monthly"] });
  });

  it("throws on an empty --window list", () => {
    expect(() => parseCliArgs(["--round", "r1", "--window", ""])).toThrow(
      /at least one window/,
    );
  });

  it("throws on a missing value for --window", () => {
    expect(() => parseCliArgs(["--round", "r1", "--window"])).toThrow(/missing value for --window/);
  });

  it("supports --flag=value syntax", () => {
    const opts = parseCliArgs(["--round=r1", "--capital=50000", "--agents=all"]);
    expect(opts).toMatchObject({ round: "r1", capital: 50000, agents: "all" });
  });

  it("parses --replicate-of and --replicates", () => {
    const opts = parseCliArgs(["--round", "r1", "--replicate-of", "dr-value", "--replicates", "5"]);
    expect(opts).toMatchObject({ replicateOf: "dr-value", replicates: 5 });
  });

  it("returns help for --help and -h", () => {
    expect(parseCliArgs(["--help"])).toEqual({ help: true });
    expect(parseCliArgs(["-h"])).toEqual({ help: true });
  });

  it("throws when --round is missing", () => {
    expect(() => parseCliArgs(["--capital", "100"])).toThrow(CliArgError);
    expect(() => parseCliArgs(["--capital", "100"])).toThrow(/--round/);
  });

  it("ignores a bare '--' separator forwarded by pnpm", () => {
    const opts = parseCliArgs(["--", "--round", "r1", "--agents", "dr-value"]);
    expect(opts).toMatchObject({ round: "r1", agents: ["dr-value"] });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseCliArgs(["--round", "r1", "--bogus"])).toThrow(/unknown flag/);
  });

  it("throws on a non-numeric --capital", () => {
    expect(() => parseCliArgs(["--round", "r1", "--capital", "abc"])).toThrow(
      /invalid value for --capital/,
    );
  });

  it("throws on a missing value for --agents", () => {
    expect(() => parseCliArgs(["--round", "r1", "--agents"])).toThrow(/missing value for --agents/);
  });

  it("throws on an empty --agents list", () => {
    expect(() => parseCliArgs(["--round", "r1", "--agents", ""])).toThrow(
      /at least one persona key/,
    );
  });
});
