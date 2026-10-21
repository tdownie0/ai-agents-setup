/**
 * Unit tests for the MCP client seam used by the judge/critic call.
 *
 * The gateway transport itself is never exercised here: `runPromptWithDeps`
 * takes the `callTool` function as an argument, so the tool name, the tool
 * arguments, and the `run_prompt` payload contract (success / failure /
 * malformed) are all pinned without a gateway.
 */

import { describe, expect, it } from "vitest";
import { runPromptWithDeps, type RunPromptDeps } from "./mcpClient.js";

/** Wrap a payload the way an MCP server returns a tool result. */
const toolResult = (payload: unknown): unknown => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

/** A `callTool` fake that records the tool name and arguments it received. */
function makeDeps(result: unknown): {
  deps: RunPromptDeps;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const deps: RunPromptDeps = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return result;
    },
  };
  return { deps, calls };
}

describe("runPromptWithDeps", () => {
  it("calls the run_prompt tool and returns the text and attempt count", async () => {
    const { deps, calls } = makeDeps(toolResult({ ok: true, text: "hello", attempts: 1 }));
    const result = await runPromptWithDeps({ system: "SYS", user: "USER" }, deps);
    expect(result).toEqual({ text: "hello", attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("run_prompt");
    expect(calls[0].args).toEqual({ system: "SYS", user: "USER" });
  });

  it("defaults the attempt count to 1 when the payload omits it", async () => {
    const { deps } = makeDeps(toolResult({ ok: true, text: "hello" }));
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).resolves.toEqual({
      text: "hello",
      attempts: 1,
    });
  });

  it("omits model and timeoutMs from the tool arguments when they are unset", async () => {
    const { deps, calls } = makeDeps(toolResult({ ok: true, text: "x", attempts: 1 }));
    await runPromptWithDeps({ system: "S", user: "U" }, deps);
    expect(calls[0].args).not.toHaveProperty("model");
    expect(calls[0].args).not.toHaveProperty("timeoutMs");
  });

  it("forwards model and timeoutMs when they are set", async () => {
    const { deps, calls } = makeDeps(toolResult({ ok: true, text: "x", attempts: 1 }));
    await runPromptWithDeps(
      { system: "S", user: "U", model: "opencode/big-pickle", timeoutMs: 5000 },
      deps,
    );
    expect(calls[0].args).toEqual({
      system: "S",
      user: "U",
      model: "opencode/big-pickle",
      timeoutMs: 5000,
    });
  });

  it("throws the error message carried by a failure payload", async () => {
    const { deps } = makeDeps(
      toolResult({ ok: false, error: "run_prompt failed after 2 attempts" }),
    );
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toThrow(
      "run_prompt failed after 2 attempts",
    );
  });

  it("carries the attempt count of a failure payload onto the thrown error", async () => {
    const { deps } = makeDeps(toolResult({ ok: false, error: "boom", attempts: 2 }));
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toMatchObject({
      message: "boom",
      attempts: 2,
    });
  });

  it("throws a default message when a failure payload carries no error text", async () => {
    const { deps } = makeDeps(toolResult({ ok: false }));
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toThrow(
      "run_prompt failed without an error message",
    );
  });

  it("rejects an unparseable tool payload", async () => {
    const { deps } = makeDeps({ content: [{ type: "text", text: "not json" }] });
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toThrow(
      /unparseable JSON/,
    );
  });

  it("rejects a payload that is not a JSON object", async () => {
    const { deps } = makeDeps(toolResult([1, 2, 3]));
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toThrow(
      /non-object payload/,
    );
  });

  it("rejects a success payload that carries no text", async () => {
    const { deps } = makeDeps(toolResult({ ok: true, attempts: 1 }));
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toThrow(
      /carried no text/,
    );
  });

  it("rejects a tool result with no text content", async () => {
    const { deps } = makeDeps({ content: [{ type: "image", data: "xx" }] });
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).rejects.toThrow(
      /no text content/,
    );
  });

  it("accepts a bare string tool result", async () => {
    const { deps } = makeDeps(JSON.stringify({ ok: true, text: "plain", attempts: 1 }));
    await expect(runPromptWithDeps({ system: "S", user: "U" }, deps)).resolves.toEqual({
      text: "plain",
      attempts: 1,
    });
  });
});
