import { describe, expect, it } from "vitest";
import { AGENTS, parseLine } from "../src/index.js";

/**
 * Smoke canaries for `experimental` adapters.
 *
 * These are deliberately NOT fixtures from real CLIs — if they were, the agent
 * would qualify for `supported` (docs/TIER.md). They only pin the shape the
 * adapter currently claims to handle, so that refactoring the shared parse
 * branches cannot silently break an agent nobody runs locally.
 *
 * A passing canary means "the branch still fires", not "the protocol is right".
 */
const CLAUDE_SHAPED_DELTA = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
});

describe("experimental adapter canaries", () => {
  it.each([
    ["cursor-agent", CLAUDE_SHAPED_DELTA],
    ["gemini", CLAUDE_SHAPED_DELTA],
    ["qoder", CLAUDE_SHAPED_DELTA],
    ["qwen", JSON.stringify({ text: "hi" })],
  ])("%s emits a delta for its documented line shape", (agent, line) => {
    expect(parseLine(agent, line)).toEqual([{ kind: "delta", text: "hi" }]);
  });

  // These three have no JSON mode; every stdout line is content verbatim.
  it.each(["aider", "codewhale", "deepseek-tui"])(
    "%s passes plain text through as a delta",
    (agent) => {
      expect(parseLine(agent, "plain text line")).toEqual([
        { kind: "delta", text: "plain text line\n" },
      ]);
    },
  );

  // qwen accepts three interchangeable field names; all must keep working.
  it.each(["text", "content", "message"])("qwen reads the %s field", (field) => {
    expect(parseLine("qwen", JSON.stringify({ [field]: "hi" }))).toEqual([
      { kind: "delta", text: "hi" },
    ]);
  });

  it("every invocable agent has a parse branch that does not throw", () => {
    const invocable = AGENTS.filter((a) => (a.protocol ?? "stdin") !== "acp");
    for (const a of invocable) {
      expect(() => parseLine(a.id, CLAUDE_SHAPED_DELTA)).not.toThrow();
      expect(() => parseLine(a.id, "not json at all")).not.toThrow();
      expect(() => parseLine(a.id, "")).not.toThrow();
    }
  });
});
