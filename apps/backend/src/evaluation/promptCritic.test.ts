/**
 * promptCritic tests — the non-blind contract plus strict output parsing.
 *
 * The blindness case is inverted here: the critic MUST receive the prompt
 * text, but must still receive NO volatile run state (dataset path, per-run
 * identity/portfolio lines, correction/replica hints). The test asserts the
 * ACTUAL prompt handed to the model against both halves of that contract.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPromptSetDefinition } from "@model_md/agent-orchestrator";
import type { PromptSetDefinition } from "@model_md/agent-orchestrator";
import type { ChatCompleteInput } from "./llmClient.js";
import { chatComplete } from "./llmClient.js";
import {
  buildCriticContext,
  buildCriticPrompt,
  CriticOutputError,
  critiquePromptSet,
  parseCriticOutput,
} from "./promptCritic.js";
import type { FailureNote, PromptProposal } from "./promptCritic.js";

vi.mock("./llmClient.js", () => ({ chatComplete: vi.fn() }));

const mockedChat = vi.mocked(chatComplete);

beforeEach(() => {
  mockedChat.mockReset();
});

const definition: PromptSetDefinition = getPromptSetDefinition("dr-value", "weekly");

const FAILURES: readonly FailureNote[] = [
  { error: "positions must sum to 1.0 (±0.01)", totalFailures: 3 },
  { error: "missing exit line for held symbol KO", totalFailures: 3 },
];

const PROPOSAL: PromptProposal = {
  component: "complete_book_rule",
  kind: "clarify",
  severity: "high",
  problem: "The complete-book rule does not say what happens to an omitted holding.",
  currentText: "every symbol listed in HOLDINGS MUST have a line in positions.",
  proposedText:
    "every symbol listed in HOLDINGS MUST have a line in positions; omitting one is a validation error.",
  rationale: "Removes the ambiguity that produced the missing-exit-line failures.",
};

const COMPLETION = {
  critiques: "The mandate is clear, but the complete-book rule leaves an omission ambiguous.",
  proposals: [PROPOSAL],
};

/** Volatile per-run markers that must never reach the critic. */
const VOLATILE_MARKERS = [
  "the dataset file is at",
  "you are analyzing data as of",
  "simulationid=",
  "priorroundid=",
  "portfoliovalue=",
  "roundseq=",
  "cash=",
  "correction from the previous attempt",
  "consistency replica of",
] as const;

describe("buildCriticContext", () => {
  it("carries the prompt-set metadata, every component, the template, and the failure digest", () => {
    const context = buildCriticContext(definition, FAILURES);
    const parsed = JSON.parse(context) as {
      personaKey: string;
      window: string;
      agentKey: string;
      promptSetVersion: string;
      promptHash: string;
      components: { id: string; label: string; text: string }[];
      template: string;
      failureDigest: { totalFailures: number; errors: string[] };
    };
    expect(parsed.personaKey).toBe(definition.personaKey);
    expect(parsed.window).toBe(definition.window);
    expect(parsed.agentKey).toBe(definition.agentKey);
    expect(parsed.promptSetVersion).toBe(definition.promptSetVersion);
    expect(parsed.promptHash).toBe(definition.promptHash);
    expect(parsed.template).toBe(definition.template);
    expect(parsed.components.map((component) => component.id)).toEqual(
      definition.components.map((component) => component.id),
    );
    for (const component of definition.components) {
      const carried = parsed.components.find((entry) => entry.id === component.id);
      expect(carried?.label).toBe(component.label);
      expect(carried?.text).toBe(component.text);
    }
    expect(parsed.failureDigest.totalFailures).toBe(3);
    expect(parsed.failureDigest.errors).toEqual(FAILURES.map((failure) => failure.error));
  });

  it("omits the failure digest entirely when there are no failures", () => {
    const parsed = JSON.parse(buildCriticContext(definition, [])) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("failureDigest");
  });

  it("carries no volatile run state", () => {
    const context = buildCriticContext(definition, FAILURES).toLowerCase();
    for (const marker of VOLATILE_MARKERS) {
      expect(context).not.toContain(marker);
    }
  });
});

describe("buildCriticPrompt", () => {
  it("embeds the context in the user message and the contract in the system message", () => {
    const { system, user } = buildCriticPrompt(buildCriticContext(definition, FAILURES));
    expect(system).toContain("prompt-critic");
    expect(system).toContain("persona_mandate");
    expect(system).toContain("scaffolding");
    const parsed = JSON.parse(user.slice(user.indexOf("{"))) as { template: string };
    expect(parsed.template).toBe(definition.template);
  });
});

describe("critiquePromptSet", () => {
  it("sends the model the prompt text and no volatile run state", async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify(COMPLETION));
    await critiquePromptSet({ definition, failures: FAILURES });

    const call = mockedChat.mock.calls[0]?.[0] as ChatCompleteInput;
    const prompt = `${call.system}\n${call.user}`;
    expect(prompt).toContain(definition.promptHash);
    expect(prompt).toContain(definition.promptSetVersion);
    expect(prompt).toContain(FAILURES[0]?.error ?? "");
    const parsed = JSON.parse(call.user.slice(call.user.indexOf("{"))) as {
      template: string;
      components: { text: string }[];
    };
    expect(parsed.template).toBe(definition.template);
    expect(parsed.components[0]?.text).toBe(definition.components[0]?.text);
    const lowered = prompt.toLowerCase();
    for (const marker of VOLATILE_MARKERS) {
      expect(lowered).not.toContain(marker);
    }
  });

  it("passes an explicit model through to the chat client", async () => {
    mockedChat.mockResolvedValueOnce(JSON.stringify(COMPLETION));
    await critiquePromptSet({ definition, failures: FAILURES, model: "custom/critic-model" });
    expect(mockedChat.mock.calls[0]?.[0].model).toBe("custom/critic-model");
  });
});

describe("parseCriticOutput", () => {
  it("parses a fenced JSON completion", () => {
    const result = parseCriticOutput(`\`\`\`json\n${JSON.stringify(COMPLETION)}\n\`\`\``);
    expect(result.critiques).toBe(COMPLETION.critiques);
    expect(result.proposals).toEqual([PROPOSAL]);
  });

  it("extracts a JSON object embedded in surrounding prose", () => {
    const result = parseCriticOutput(`Here is the critique: ${JSON.stringify(COMPLETION)}`);
    expect(result.proposals).toHaveLength(1);
  });

  it("throws CriticOutputError on output with no JSON object", () => {
    expect(() => parseCriticOutput("the prompt looks fine overall")).toThrow(CriticOutputError);
    expect(() => parseCriticOutput("the prompt looks fine overall")).toThrow(/no JSON object/);
  });

  it("throws CriticOutputError on unparseable JSON", () => {
    expect(() => parseCriticOutput('{"critiques": broken,}')).toThrow(/not parseable JSON/);
  });

  it("throws CriticOutputError when critiques is missing or empty", () => {
    const { critiques: _omitted, ...noCritiques } = COMPLETION;
    expect(() => parseCriticOutput(JSON.stringify(noCritiques))).toThrow(/critiques/);
    expect(() => parseCriticOutput(JSON.stringify({ ...COMPLETION, critiques: "  " }))).toThrow(
      /critiques/,
    );
  });

  it("throws CriticOutputError when proposals is not an array or is empty", () => {
    expect(() => parseCriticOutput(JSON.stringify({ ...COMPLETION, proposals: {} }))).toThrow(
      /proposals/,
    );
    expect(() => parseCriticOutput(JSON.stringify({ ...COMPLETION, proposals: [] }))).toThrow(
      /must not be empty/,
    );
  });

  it("throws CriticOutputError on more than 15 proposals", () => {
    const proposals = Array.from({ length: 16 }, () => PROPOSAL);
    expect(() => parseCriticOutput(JSON.stringify({ ...COMPLETION, proposals }))).toThrow(
      /at most 15/,
    );
  });

  it("throws CriticOutputError on an unknown component, kind, or severity", () => {
    expect(() =>
      parseCriticOutput(
        JSON.stringify({ ...COMPLETION, proposals: [{ ...PROPOSAL, component: "nope" }] }),
      ),
    ).toThrow(/component/);
    expect(() =>
      parseCriticOutput(
        JSON.stringify({ ...COMPLETION, proposals: [{ ...PROPOSAL, kind: "rewrite" }] }),
      ),
    ).toThrow(/kind/);
    expect(() =>
      parseCriticOutput(
        JSON.stringify({ ...COMPLETION, proposals: [{ ...PROPOSAL, severity: "critical" }] }),
      ),
    ).toThrow(/severity/);
  });

  it("throws CriticOutputError on an empty problem, proposedText, or rationale", () => {
    expect(() =>
      parseCriticOutput(
        JSON.stringify({ ...COMPLETION, proposals: [{ ...PROPOSAL, problem: "" }] }),
      ),
    ).toThrow(/problem/);
    expect(() =>
      parseCriticOutput(
        JSON.stringify({ ...COMPLETION, proposals: [{ ...PROPOSAL, proposedText: "  " }] }),
      ),
    ).toThrow(/proposedText/);
    expect(() =>
      parseCriticOutput(
        JSON.stringify({ ...COMPLETION, proposals: [{ ...PROPOSAL, rationale: "" }] }),
      ),
    ).toThrow(/rationale/);
  });
});
