import { describe, expect, it } from "vitest";
import { parseLine, makeParser, extractTextFromLine } from "../src/argv.js";

describe("parseLine opencode", () => {
  it("extracts text from nested part payload", () => {
    const line = JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: {
        type: "text",
        text: "<html><body>ok</body></html>",
      },
    });

    expect(parseLine("opencode", line)).toContainEqual({
      kind: "delta",
      text: "<html><body>ok</body></html>",
    });
  });

  it("emits one delta when top-level and nested text are both present", () => {
    const line = JSON.stringify({
      type: "text",
      text: "<html><body>ok</body></html>",
      part: {
        type: "text",
        text: "<html><body>ok</body></html>",
      },
    });

    expect(parseLine("opencode", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>ok</body></html>",
      },
    ]);
  });

  it("falls back to top-level text when nested text is empty", () => {
    const line = JSON.stringify({
      type: "text",
      content: "<html>ok</html>",
      part: {
        type: "text",
        text: "",
      },
    });

    expect(parseLine("opencode", line)).toEqual([
      {
        kind: "delta",
        text: "<html>ok</html>",
      },
    ]);
  });

  it("extracts session only from step start payload", () => {
    expect(
      parseLine(
        "opencode",
        JSON.stringify({
          type: "step_start",
          sessionID: "ses_test",
          part: {
            type: "step-start",
          },
        }),
      ),
    ).toContainEqual({
      kind: "meta",
      key: "session",
      value: "ses_test",
    });

    expect(
      parseLine(
        "opencode",
        JSON.stringify({
          type: "text",
          sessionID: "ses_test",
          part: {
            type: "text",
            text: "ok",
          },
        }),
      ),
    ).not.toContainEqual({
      kind: "meta",
      key: "session",
      value: "ses_test",
    });
  });

  it("extracts usage from step finish payload and accumulates successive steps", () => {
    const line1 = JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        tokens: {
          input: 10,
          output: 2,
          cache: {
            read: 3,
            write: 4,
          },
        },
        cost: 0.01,
      },
    });

    const line2 = JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        tokens: {
          input: 5,
          output: 1,
          cache: {
            read: 1,
            write: 1,
          },
        },
        cost: 0.005,
      },
    });

    const parser = makeParser("opencode");
    expect(parser(line1)).toEqual([
      {
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      },
      {
        kind: "meta",
        key: "cost_usd",
        value: 0.01,
      },
    ]);

    expect(parser(line2)).toEqual([
      {
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: 15,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
        },
      },
      {
        kind: "meta",
        key: "cost_usd",
        value: 0.015,
      },
    ]);
  });
});

describe("parseLine bob", () => {
  it("extracts text from stream-json output", () => {
    const line = JSON.stringify({
      text: "<html><body>Hello</body></html>",
    });

    expect(parseLine("bob", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>Hello</body></html>",
      },
    ]);
  });

  it("extracts content field when present", () => {
    const line = JSON.stringify({
      content: "<html><body>World</body></html>",
    });

    expect(parseLine("bob", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>World</body></html>",
      },
    ]);
  });

  it("extracts message field when present", () => {
    const line = JSON.stringify({
      message: "<html><body>Test</body></html>",
    });

    expect(parseLine("bob", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>Test</body></html>",
      },
    ]);
  });

  it("handles final answer after thinking when --hide-intermediary-output is used", () => {
    // When --hide-intermediary-output is enabled, Bob only emits the final answer.
    // This test verifies that the parser correctly handles the final completion.
    const finalAnswer = JSON.stringify({
      text: "<html><body>Final result</body></html>",
    });

    expect(parseLine("bob", finalAnswer)).toEqual([
      {
        kind: "delta",
        text: "<html><body>Final result</body></html>",
      },
    ]);
  });
});

describe("parseLine claude", () => {
  it("extracts fine-grained text deltas and dedupes the assistant body", () => {
    const parser = makeParser("claude");
    const streamEvent = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    });

    expect(parser(streamEvent)).toEqual([{ kind: "delta", text: "Hello" }]);
    // assistant body suppressed — streamed tokens are authoritative
    expect(parser(assistant)).toEqual([]);
  });

  it("extracts usage and duration from the result envelope", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
      duration_ms: 1200,
      total_cost_usd: 0.02,
    });

    expect(parseLine("claude", line)).toEqual([
      { kind: "meta", key: "usage", value: { input_tokens: 10, output_tokens: 5 } },
      { kind: "meta", key: "duration_ms", value: 1200 },
      { kind: "meta", key: "cost_usd", value: 0.02 },
      { kind: "meta", key: "result", value: "success" },
    ]);
  });

  it("rescues HTML from a Write tool_use input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "已输出至 output.html" },
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "output.html", content: "<html><body>real</body></html>" },
          },
        ],
      },
    });

    expect(parseLine("claude", line)).toEqual([
      { kind: "html", text: "<html><body>real</body></html>" },
    ]);
  });

  it("does not rescue non-HTML sidecar files", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "notes.md", content: "# not html" },
          },
        ],
      },
    });

    expect(parseLine("claude", line)).toEqual([]);
  });
});

describe("parseLine codex / qwen / copilot", () => {
  it("codex: extracts item.completed assistant text", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { item_type: "assistant_message", text: "<p>ok</p>" },
    });
    expect(parseLine("codex", line)).toEqual([{ kind: "delta", text: "<p>ok</p>" }]);
  });

  it("codex: extracts item.delta text", () => {
    const line = JSON.stringify({ type: "item.delta", text: "part" });
    expect(parseLine("codex", line)).toEqual([{ kind: "delta", text: "part" }]);
  });

  it("qwen: extracts text/content/message fields", () => {
    expect(parseLine("qwen", JSON.stringify({ text: "a" }))).toEqual([{ kind: "delta", text: "a" }]);
    expect(parseLine("qwen", JSON.stringify({ content: "b" }))).toEqual([{ kind: "delta", text: "b" }]);
    expect(parseLine("qwen", JSON.stringify({ message: "c" }))).toEqual([{ kind: "delta", text: "c" }]);
  });

  it("copilot: extracts response field", () => {
    const line = JSON.stringify({ response: "hello copilot" });
    expect(parseLine("copilot", line)).toEqual([{ kind: "delta", text: "hello copilot" }]);
  });
});

describe("parseLine raw text agents", () => {
  it("aider / codewhale / deepseek-tui emit plain-text deltas", () => {
    for (const agent of ["aider", "codewhale", "deepseek-tui"]) {
      expect(parseLine(agent, "line one")).toEqual([{ kind: "delta", text: "line one\n" }]);
      expect(parseLine(agent, "line two\n")).toEqual([{ kind: "delta", text: "line two\n" }]);
    }
  });

  it("non-JSON input on JSON agents is noise", () => {
    expect(parseLine("claude", "not json at all")).toEqual([{ kind: "noise" }]);
  });
});

describe("extractTextFromLine", () => {
  it("joins deltas only", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ab" }] } });
    expect(extractTextFromLine("claude", line)).toBe("ab");
  });
});
