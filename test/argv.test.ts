import { describe, expect, it } from "vitest";
import { parseLine, makeParser, extractTextFromLine } from "../src/argv.js";

describe("parseLine opencode", () => {
  it("rescues canonical HTML from a completed write tool call", () => {
    const line = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_test",
      part: {
        type: "tool",
        tool: "write",
        callID: "call_01",
        state: {
          status: "completed",
          input: {
            filePath: "/tmp/oc-test/out.html",
            content: "<html><body><h1>rescue</h1></body></html>\n",
          },
        },
        id: "prt_01",
        sessionID: "ses_test",
        messageID: "msg_01",
      },
    });
    expect(parseLine("opencode", line)).toContainEqual({
      kind: "file_write",
      path: "/tmp/oc-test/out.html",
      text: "<html><body><h1>rescue</h1></body></html>\n",
    });
  });

  it("reports non-html write targets too — extension filtering is the consumer's job", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        state: {
          status: "completed",
          input: {
            filePath: "/tmp/note.md",
            content: "# hello",
          },
        },
      },
    });
    expect(parseLine("opencode", line)).toEqual([
      { kind: "file_write", path: "/tmp/note.md", text: "# hello" },
    ]);
  });

  it("ignores non-write tools (bash / read)", () => {
    for (const tool of ["bash", "read", "edit"]) {
      const line = JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool",
          tool,
          state: {
            status: "completed",
            input: { command: "ls", filePath: "/tmp/a.html", content: "<html>x</html>" },
          },
        },
      });
      expect(parseLine("opencode", line), `tool=${tool}`).toEqual([]);
    }
  });

  it("ignores in-flight (non-completed) writes", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "write",
        state: {
          status: "running",
          input: { filePath: "/tmp/a.html", content: "<html>partial</html>" },
        },
      },
    });
    expect(parseLine("opencode", line)).toEqual([]);
  });

  it("keeps text deltas flowing alongside tool rescues", () => {
    const line = JSON.stringify({
      type: "text",
      part: { type: "text", text: "Done. out.html written." },
    });
    expect(parseLine("opencode", line)).toEqual([
      { kind: "delta", text: "Done. out.html written." },
    ]);
  });

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

  it("rescues content from a Write tool_use input, reporting its path", () => {
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
      { kind: "file_write", path: "output.html", text: "<html><body>real</body></html>" },
    ]);
  });

  it("reports .md writes as well — the bridge does not filter by extension", () => {
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

    expect(parseLine("claude", line)).toEqual([
      { kind: "file_write", path: "notes.md", text: "# not html" },
    ]);
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

  it("copilot: falls back to text when response is absent", () => {
    const line = JSON.stringify({ text: "from text field" });
    expect(parseLine("copilot", line)).toEqual([{ kind: "delta", text: "from text field" }]);
  });

  // Regression: both fields were pushed unconditionally, so a line carrying
  // `response` AND `text` (same payload, as some copilot builds emit) sent the
  // reply twice. Every other adapter dedupes; this one silently doubled output.
  it("copilot: does not emit the same text twice when both fields are present", () => {
    const line = JSON.stringify({ response: "A", text: "A" });
    expect(parseLine("copilot", line)).toEqual([{ kind: "delta", text: "A" }]);
  });

  // When they genuinely differ, `response` is the assistant reply and `text`
  // is an echo/summary field — prefer the former rather than concatenating.
  it("copilot: prefers response over a differing text field", () => {
    const line = JSON.stringify({ response: "real reply", text: "echo" });
    expect(parseLine("copilot", line)).toEqual([{ kind: "delta", text: "real reply" }]);
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

// ---------------------------------------------------------------------------
// pi (@earendil-works/pi-coding-agent). Fixtures below are trimmed from real
// `pi -p --mode json` output on pi 0.85.1.
// ---------------------------------------------------------------------------
describe("parseLine pi", () => {
  it("extracts text_delta from message_update", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PONG" },
    });
    expect(parseLine("pi", line)).toEqual([{ kind: "delta", text: "PONG" }]);
  });

  it("ignores thinking_delta (reasoning is not output)", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "The user" },
    });
    expect(parseLine("pi", line)).toEqual([]);
  });

  it("rescues a write toolcall as file_write with its path", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "tool_x",
          name: "write",
          arguments: { path: "/tmp/hi.html", content: "<h1>Hi</h1>\n" },
        },
      },
    });
    expect(parseLine("pi", line)).toEqual([
      { kind: "file_write", path: "/tmp/hi.html", text: "<h1>Hi</h1>\n" },
    ]);
  });

  it("ignores non-write toolcalls (bash / read)", () => {
    for (const name of ["bash", "read", "edit"]) {
      const line = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          toolCall: { name, arguments: { path: "/tmp/a.html", content: "<html>x</html>" } },
        },
      });
      expect(parseLine("pi", line)).toEqual([]);
    }
  });

  it("reports provider/model and stopReason from message_end", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "kimi-coding",
        model: "kimi-for-coding-highspeed",
        stopReason: "stop",
      },
    });
    expect(parseLine("pi", line)).toEqual([
      { kind: "meta", key: "model", value: "kimi-coding/kimi-for-coding-highspeed" },
      { kind: "meta", key: "result", value: "stop" },
    ]);
  });

  it("normalises turn_end usage into the shared token shape", () => {
    // pi nests cost under usage.cost.total, unlike the flat field other agents use.
    const line = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        usage: {
          input: 9737,
          output: 22,
          cacheRead: 15872,
          cacheWrite: 0,
          totalTokens: 25631,
          cost: { input: 0.02, output: 0.004, total: 0.0247 },
        },
      },
    });
    expect(parseLine("pi", line)).toEqual([
      {
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: 9737,
          output_tokens: 22,
          cache_read_input_tokens: 15872,
          cache_creation_input_tokens: 0,
        },
      },
      { kind: "meta", key: "cost_usd", value: 0.0247 },
    ]);
  });

  it("treats session / agent_start / agent_settled as noise, not raw", () => {
    for (const line of [
      JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/tmp" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "agent_settled" }),
    ]) {
      expect(parseLine("pi", line)).toEqual([]);
    }
  });
});
