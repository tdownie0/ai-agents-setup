/**
 * Unit tests for the run_prompt spawner (blind judge / prompt critic path).
 *
 * The exec is injected (never spawns docker): argv shape, NDJSON text
 * extraction, the one-retry loop (non-zero exit, missing JSON), the JSON-only
 * retry suffix, and the both-attempts-fail rejection are all pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  buildRunPromptArgs,
  containsJsonObject,
  DEFAULT_PROMPT_TIMEOUT_MS,
  JSON_ONLY_SUFFIX,
  runPromptWithExec,
} from "../src/runPrompt.js";
import type { RunPromptConfig } from "../src/runPrompt.js";
import type { DockerExecResult, ExecImpl } from "../src/spawnViaDocker.js";

const CFG: RunPromptConfig = {
  agentContainer: "opencode_agent",
  judgeConfigPath: "/app/worktrees/wt-sim/infra/opencode.judge.json",
  model: "opencode/big-pickle",
  timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
};

const ndjson = (text: string): string => `${JSON.stringify({ type: "text", part: { text } })}\n`;

const ok = (text: string): DockerExecResult => ({
  stdout: ndjson(text),
  stderr: "",
  code: 0,
});

interface RecordedCall {
  args: readonly string[];
  opts: { dockerHost?: string; timeoutMs: number };
}

function makeExec(results: readonly DockerExecResult[]): {
  exec: ExecImpl;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let next = 0;
  const exec: ExecImpl = async (args, opts) => {
    calls.push({ args: [...args], opts });
    const result = results[Math.min(next, results.length - 1)];
    next += 1;
    return result;
  };
  return { exec, calls };
}

describe("buildRunPromptArgs", () => {
  it("builds the docker exec argv with pure json run, judge config, and XDG isolation", () => {
    const argv = buildRunPromptArgs({
      agentContainer: "opencode_agent",
      judgeConfigPath: "/app/worktrees/wt-sim/infra/opencode.judge.json",
      model: "opencode/big-pickle",
      runKey: "run-123",
      prompt: "SYS\n\nUSER",
    });
    expect(argv).toEqual([
      "exec",
      "-e",
      "XDG_STATE_HOME=/home/devuser/.local/state/prompts/run-123",
      "-e",
      "XDG_CACHE_HOME=/home/devuser/.cache/prompts/run-123",
      "-e",
      "OPENCODE_CONFIG=/app/worktrees/wt-sim/infra/opencode.judge.json",
      "-w",
      "/tmp",
      "opencode_agent",
      "opencode",
      "run",
      "--pure",
      "--agent",
      "judge",
      "--format",
      "json",
      "-m",
      "opencode/big-pickle",
      "SYS\n\nUSER",
    ]);
    expect(argv).toContain("--pure");
    expect(argv).toContain("--format");
    expect(argv).toContain("-m");
    expect(argv).toContain("-w");
    expect(argv[argv.indexOf("-w") + 1]).toBe("/tmp");
    expect(argv[argv.indexOf("--agent") + 1]).toBe("judge");
    expect(argv.some((a) => a.startsWith("OPENCODE_CONFIG="))).toBe(true);
    expect(
      argv.some((a) => a.startsWith("XDG_STATE_HOME=/home/devuser/.local/state/prompts/")),
    ).toBe(true);
    expect(argv.some((a) => a.startsWith("XDG_CACHE_HOME=/home/devuser/.cache/prompts/"))).toBe(
      true,
    );
  });
});

describe("containsJsonObject", () => {
  it("detects a JSON object anywhere in the text", () => {
    expect(containsJsonObject('{"a":1}')).toBe(true);
    expect(containsJsonObject('prose then {"a":1} tail')).toBe(true);
    expect(containsJsonObject("no json here")).toBe(false);
    expect(containsJsonObject("just braces {} empty is still an object")).toBe(true);
  });
});

describe("runPromptWithExec", () => {
  it("returns the extracted text on the first successful attempt", async () => {
    const { exec, calls } = makeExec([ok("hello")]);
    const result = await runPromptWithExec(
      { system: "SYS", user: "USER", expectJson: false },
      CFG,
      exec,
    );
    expect(result).toEqual({ text: "hello", attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.timeoutMs).toBe(DEFAULT_PROMPT_TIMEOUT_MS);
    const argv = calls[0].args;
    const state = (argv.find((a) => a.startsWith("XDG_STATE_HOME=")) ?? "").replace(
      "XDG_STATE_HOME=",
      "",
    );
    const cache = (argv.find((a) => a.startsWith("XDG_CACHE_HOME=")) ?? "").replace(
      "XDG_CACHE_HOME=",
      "",
    );
    const runKey = state.replace("/home/devuser/.local/state/prompts/", "");
    expect(runKey).not.toBe("");
    expect(cache).toBe(`/home/devuser/.cache/prompts/${runKey}`);
    expect(argv[argv.length - 1]).toBe("SYS\n\nUSER");
  });

  it("honours model and timeoutMs overrides", async () => {
    const { exec, calls } = makeExec([ok('{"x":1}')]);
    await runPromptWithExec(
      { system: "S", user: "U", model: "custom/model", timeoutMs: 5000 },
      CFG,
      exec,
    );
    const argv = calls[0].args;
    expect(argv[argv.indexOf("-m") + 1]).toBe("custom/model");
    expect(calls[0].opts.timeoutMs).toBe(5000);
  });

  it("selects the tool-less judge agent and allows overriding it", async () => {
    const { exec, calls } = makeExec([ok("ok")]);
    await runPromptWithExec({ system: "S", user: "U", expectJson: false }, CFG, exec);
    const defaultArgv = calls[0].args;
    expect(defaultArgv[defaultArgv.indexOf("--agent") + 1]).toBe("judge");

    const { exec: exec2, calls: calls2 } = makeExec([ok("ok")]);
    await runPromptWithExec(
      { system: "S", user: "U", expectJson: false },
      { ...CFG, judgeAgent: "critic" },
      exec2,
    );
    const customArgv = calls2[0].args;
    expect(customArgv[customArgv.indexOf("--agent") + 1]).toBe("critic");
  });

  it("skips the JSON check when expectJson is false", async () => {
    const { exec } = makeExec([ok("plain prose, no braces")]);
    const result = await runPromptWithExec(
      { system: "S", user: "U", expectJson: false },
      CFG,
      exec,
    );
    expect(result).toEqual({ text: "plain prose, no braces", attempts: 1 });
  });

  it("retries once when the exec exits non-zero and succeeds on the second attempt", async () => {
    const { exec, calls } = makeExec([
      { stdout: "", stderr: "opencode exploded", code: 1 },
      ok('{"recovered":true}'),
    ]);
    const result = await runPromptWithExec({ system: "S", user: "U" }, CFG, exec);
    expect(result).toEqual({ text: '{"recovered":true}', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1].args[calls[1].args.length - 1]).toBe(`S\n\nU${JSON_ONLY_SUFFIX}`);
  });

  it("retries once when expectJson and the reply has no JSON object, appending the JSON-only suffix", async () => {
    const { exec, calls } = makeExec([ok("I would rather not answer in JSON."), ok('{"a":1}')]);
    const result = await runPromptWithExec({ system: "S", user: "U" }, CFG, exec);
    expect(result).toEqual({ text: '{"a":1}', attempts: 2 });
    expect(calls).toHaveLength(2);
    const secondPrompt = calls[1].args[calls[1].args.length - 1];
    expect(secondPrompt).toBe(`S\n\nU${JSON_ONLY_SUFFIX}`);
    expect(secondPrompt).toContain("ONLY a single JSON object");
    expect(calls[0].args[calls[0].args.length - 1]).toBe("S\n\nU");
  });

  it("rejects with the last stderr snippet when both attempts fail", async () => {
    const { exec, calls } = makeExec([
      { stdout: "", stderr: "first failure", code: 1 },
      { stdout: "", stderr: "second failure", code: 2 },
    ]);
    await expect(runPromptWithExec({ system: "S", user: "U" }, CFG, exec)).rejects.toThrow(
      /run_prompt failed after 2 attempts: docker exec exited with code 2.*second failure/,
    );
    expect(calls).toHaveLength(2);
  });

  it("rejects when both attempts produce no JSON and expectJson stays true", async () => {
    const { exec } = makeExec([ok("nope"), ok("still nope")]);
    await expect(runPromptWithExec({ system: "S", user: "U" }, CFG, exec)).rejects.toThrow(
      /run_prompt failed after 2 attempts: response contains no JSON object/,
    );
  });

  it("rejects without retrying when the exec itself throws (timeout / spawn failure)", async () => {
    let calls = 0;
    const exec: ExecImpl = async () => {
      calls += 1;
      throw new Error("docker exec timed out after 120s");
    };
    await expect(runPromptWithExec({ system: "S", user: "U" }, CFG, exec)).rejects.toThrow(
      /run_prompt failed: docker exec timed out after 120s/,
    );
    expect(calls).toBe(1);
  });
});
