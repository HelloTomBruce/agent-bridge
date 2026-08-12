import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeAgent, type InvokeEvent } from "../src/invoke.js";
import { buildArgv, UnsupportedAgentProtocolError } from "../src/argv.js";

/** Drain a ReadableStream<InvokeEvent> to a plain array. */
async function drain(stream: ReadableStream<InvokeEvent>): Promise<InvokeEvent[]> {
  const out: InvokeEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value!);
  }
  return out;
}

describe("buildArgv", () => {
  it("claude: print-mode stream-json argv, --model optional", () => {
    expect(buildArgv("claude")).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(buildArgv("claude", { model: "sonnet" })).toContain("--model");
  });

  it("openclaw: agent id injected from opts", () => {
    expect(buildArgv("openclaw", { openclawAgentId: "ops" })).toEqual([
      "agent",
      "--local",
      "--json",
      "--agent",
      "ops",
    ]);
  });

  it("throws UnsupportedAgentProtocolError for acp / pi-rpc adapters", () => {
    expect(() => buildArgv("hermes")).toThrow(UnsupportedAgentProtocolError);
    expect(() => buildArgv("pi")).toThrow(UnsupportedAgentProtocolError);
  });

  it("throws for unknown agent", () => {
    expect(() => buildArgv("no-such-agent")).toThrow(/unknown agent/);
  });
});

describe("invokeAgent — bin resolution errors (no spawn)", () => {
  it("unknown agent id → error event", async () => {
    const evts = await drain(invokeAgent({ agent: "nope", prompt: "hi" }));
    expect(evts).toEqual([{ type: "error", message: "unknown agent: nope" }]);
  });

  it("nonexistent binOverride → override-missing error (never silent fallback)", async () => {
    const evts = await drain(
      invokeAgent({ agent: "claude", prompt: "hi", binOverride: "/definitely/missing/claude" }),
    );
    expect(evts.length).toBe(1);
    expect(evts[0]!.type).toBe("error");
    expect((evts[0] as { message: string }).message).toMatch(/does not exist/);
  });
});

describe("invokeAgent — fake child process", () => {
  // A real shell script that speaks claude's stream-json shape.
  let fakeBin: string;

  beforeAll(() => {
    fakeBin = join(tmpdir(), "agent-bridge-fake-claude");
    writeFileSync(
      fakeBin,
      [
        "#!/bin/sh",
        // read stdin prompt, echo a stream_event delta + result envelope
        "read -r _line",
        'echo \'{"type":"system","subtype":"init","model":"claude-sonnet","session_id":"s1"}\'',
        'echo \'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"<p>ok</p>"}}}\'',
        'echo \'{"type":"result","subtype":"success","usage":{"input_tokens":5}}\'',
        "exit 0",
      ].join("\n"),
    );
    chmodSync(fakeBin, 0o755);
    process.env.CLAUDE_BIN = fakeBin;
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
  });

  it("emits start → deltas/meta → done", async () => {
    const evts = await drain(invokeAgent({ agent: "claude", prompt: "build a page" }));
    const types = evts.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("done");
    expect(
      evts
        .filter((e) => e.type === "delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("<p>ok</p>");
    expect(evts).toContainEqual({ type: "meta", key: "model", value: "claude-sonnet" });
    expect(evts).toContainEqual({ type: "done", code: 0 });
  });

  it("honors abort: signal aborts before child closes → stream ends without done", async () => {
    const controller = new AbortController();
    const stream = invokeAgent({
      agent: "claude",
      prompt: "build a page",
      signal: controller.signal,
    });
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value?.type).toBe("start");
    controller.abort();
    // After abort the stream closes; reading returns done. The child may
    // still flush a couple of events before the kill lands — assert the
    // stream terminates, not the exact event count.
    const rest: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value!.type);
    }
    expect(rest).not.toContain("done");
  });
});
