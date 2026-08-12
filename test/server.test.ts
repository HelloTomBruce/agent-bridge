import { describe, expect, it } from "vitest";
import { toSseStream } from "../src/server.js";
import type { InvokeEvent } from "../src/invoke.js";

function makeStream(events: InvokeEvent[] | (() => AsyncGenerator<InvokeEvent>)): ReadableStream<InvokeEvent> {
  const gen =
    typeof events === "function"
      ? events()
      : (async function* () {
          for (const e of events) yield e;
        })();
  return new ReadableStream<InvokeEvent>({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      gen.return?.();
    },
  });
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  return out;
}

const sseHeaders = ["Content-Type: text/event-stream; charset=utf-8", "Cache-Control: no-cache, no-transform"];

describe("toSseStream", () => {
  it("encodes every event type as event: <type> + data JSON frame", async () => {
    const events: InvokeEvent[] = [
      { type: "start", bin: "/usr/bin/claude", argv: ["-p"], promptBytes: 12 },
      { type: "delta", text: "hello" },
      { type: "meta", key: "session", value: "ses_123" },
      { type: "html", text: "<html></html>" },
      { type: "stderr", text: "warn" },
      { type: "raw", text: "…" },
      { type: "done", code: 0 },
    ];
    const out = await collectSse(toSseStream(makeStream(events)));
    expect(out).toContain('event: start\ndata: {"type":"start","bin":"/usr/bin/claude","argv":["-p"],"promptBytes":12}\n\n');
    expect(out).toContain('event: delta\ndata: {"type":"delta","text":"hello"}\n\n');
    expect(out).toContain('event: meta\ndata: {"type":"meta","key":"session","value":"ses_123"}\n\n');
    expect(out).toContain('event: html\ndata: {"type":"html","text":"<html></html>"}\n\n');
    expect(out).toContain('event: stderr\ndata: {"type":"stderr","text":"warn"}\n\n');
    expect(out).toContain('event: done\ndata: {"type":"done","code":0}\n\n');
  });

  it("emits an error frame when the upstream stream throws", async () => {
    const bad = new ReadableStream<InvokeEvent>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });
    const out = await collectSse(toSseStream(bad));
    expect(out).toContain('event: error\ndata: {"message":"boom"}');
  });

  it("propagates downstream cancel to the upstream stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<InvokeEvent>({
      pull(controller) {
        controller.enqueue({ type: "delta", text: "x" });
      },
      cancel() {
        cancelled = true;
      },
    });
    const sse = toSseStream(stream);
    const reader = sse.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it("closes immediately when the signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const out = await collectSse(toSseStream(makeStream([{ type: "delta", text: "never" }]), { signal: ctl.signal }));
    expect(out).toBe("");
  });

  it("closes output and cancels upstream when signal aborts mid-stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<InvokeEvent>({
      start(controller) {
        controller.enqueue({ type: "delta", text: "a" });
      },
      cancel() {
        cancelled = true;
      },
    });
    const ctl = new AbortController();
    const sse = toSseStream(stream, { signal: ctl.signal });
    const reader = sse.getReader();
    await reader.read(); // 拿到第一个帧
    ctl.abort();
    const { done } = await reader.read();
    expect(done).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("handles empty streams", async () => {
    const out = await collectSse(toSseStream(makeStream([])));
    expect(out).toBe("");
  });

  it("works as a Response body with SSE headers (integration shape)", async () => {
    const res = new Response(toSseStream(makeStream([{ type: "done", code: 0 }])), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
    expect(res.headers.get("Content-Type")).toBe(sseHeaders[0].split(": ")[1]);
    const text = await res.text();
    expect(text).toContain('event: done');
  });
});
