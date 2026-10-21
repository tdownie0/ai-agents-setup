/**
 * Guard for infra/opencode.judge.json.
 *
 * The judge config is loaded by opencode inside the agent container, so a bad
 * permission entry only shows up at runtime as an opaque HTTP 403 from the
 * opencode.ai free tier ("OpenCode's free tier can only be used from within
 * OpenCode"). These assertions fail loudly at test time instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONFIG_PATH = fileURLToPath(
  new URL("../../../../infra/opencode.judge.json", import.meta.url),
);

interface JudgeConfig {
  model?: string;
  plugin?: unknown[];
  mcp?: Record<string, unknown>;
  agent?: Record<string, { mode?: string; steps?: number; permission?: Record<string, string> }>;
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as JudgeConfig;

describe("infra/opencode.judge.json", () => {
  it("denies the tools a blind judge must not use, without a wildcard", () => {
    const permission = config.agent?.judge?.permission ?? {};
    expect(Object.keys(permission)).not.toContain("*");
    for (const tool of ["edit", "glob", "grep", "list", "bash", "task", "webfetch"]) {
      expect(permission[tool]).toBe("deny");
    }
  });

  it("never denies read, which the opencode.ai free tier rejects with HTTP 403", () => {
    const permission = config.agent?.judge?.permission ?? {};
    expect(Object.keys(permission)).not.toContain("read");
  });

  it("runs the judge as a single-step primary agent without plugins or MCP", () => {
    expect(config.agent?.judge?.mode).toBe("primary");
    expect(config.agent?.judge?.steps).toBe(1);
    expect(config.plugin).toEqual([]);
    expect(config.mcp).toEqual({});
    expect(config.model).toBeTruthy();
  });
});
