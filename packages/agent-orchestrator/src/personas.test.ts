/**
 * Pure unit tests for the persona catalog and its agent-key helpers — no DB,
 * no spawn.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_KEY_SEPARATOR,
  ANALYST_WINDOWS,
  PERSONAS,
  agentKeyFor,
  getPersona,
  personaKeyFromAgentKey,
  windowFromAgentKey,
} from "./personas.js";

describe("agentKeyFor / windowFromAgentKey / personaKeyFromAgentKey", () => {
  it("round-trips every persona across every window", () => {
    for (const persona of PERSONAS) {
      for (const window of ANALYST_WINDOWS) {
        const key = agentKeyFor(persona.key, window);
        expect(key).toBe(`${persona.key}${AGENT_KEY_SEPARATOR}${window}`);
        expect(windowFromAgentKey(key)).toBe(window);
        expect(personaKeyFromAgentKey(key)).toBe(persona.key);
      }
    }
  });

  it("recovers the persona from a replica key that carries a #rep suffix", () => {
    expect(personaKeyFromAgentKey("dr-macro--monthly#rep2")).toBe("dr-macro");
    expect(windowFromAgentKey("dr-macro--monthly#rep2")).toBe("monthly");
  });

  it("accepts a bare persona key with no window segment", () => {
    expect(personaKeyFromAgentKey("dr-value")).toBe("dr-value");
    expect(windowFromAgentKey("dr-value")).toBeUndefined();
  });

  it("rejects keys that do not name a catalog persona", () => {
    expect(personaKeyFromAgentKey("dr-unknown--daily")).toBeUndefined();
    expect(personaKeyFromAgentKey("--daily")).toBeUndefined();
    expect(personaKeyFromAgentKey("")).toBeUndefined();
    expect(personaKeyFromAgentKey("   ")).toBeUndefined();
  });
});

describe("persona catalog", () => {
  it("assigns each persona a unique key and a non-empty display name and strategy", () => {
    const keys = PERSONAS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const persona of PERSONAS) {
      expect(persona.displayName.trim().length).toBeGreaterThan(0);
      expect(persona.strategy.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps strategy free of any hard-coded cadence token", () => {
    for (const persona of PERSONAS) {
      expect(persona.strategy).not.toMatch(/daily|weekly|monthly/i);
    }
  });

  it("throws for an unknown persona key", () => {
    expect(() => getPersona("dr-nope")).toThrow(/Unknown analyst persona/);
  });
});
