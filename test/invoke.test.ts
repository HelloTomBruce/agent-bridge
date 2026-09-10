import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeAgent, SIGKILL_GRACE_MS, type InvokeEvent } from "../src/invoke.js";
import { buildArgv, UnsupportedAgentProtocolError } from "../src/argv.js";

// The fake agents below are POSIX `sh` scripts, which Windows cannot execute.
// Skipping is honest about the gap: Windows teardown goes through
// `taskkill /T` (a different code path from `process.kill(-pid)`) and is
// therefore NOT covered by CI. Covering it needs a `.cmd` fake agent —
// tracked in docs/TIER.md. Running these on Windows would fail on the shebang,
// not on the behaviour under test.
const posixOnly = process.platform === "win32" ? describe.skip : describe;

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

  it("throws UnsupportedAgentProtocolError for acp adapters", () => {
    expect(() => buildArgv("hermes")).toThrow(UnsupportedAgentProtocolError);
  });

  it("pi: print-mode ndjson argv", () => {
    expect(buildArgv("pi")).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--approve",
      "--no-context-files",
    ]);
    expect(buildArgv("pi", { model: "kimi-coding/k3" })).toContain("--model");
  });

  it("throws for unknown agent", () => {
    expect(() => buildArgv("no-such-agent")).toThrow(/unknown agent/);
  });
});

describe("invokeAgent — bin resolution errors (no spawn)", () => {
  it("unknown agent id → error event", async () => {
    const evts = await drain(invokeAgent({ agent: "nope", prompt: "hi" }));
    expect(evts).toEqual([
      { type: "error", code: "UNKNOWN_AGENT", message: "unknown agent: nope" },
      { type: "end", status: "failed", code: null },
    ]);
  });

  it("nonexistent binOverride → override-missing error (never silent fallback)", async () => {
    const evts = await drain(
      invokeAgent({ agent: "claude", prompt: "hi", binOverride: "/definitely/missing/claude" }),
    );
    expect(evts.map((e) => e.type)).toEqual(["error", "end"]);
    expect(evts[0]).toMatchObject({ code: "BIN_OVERRIDE_MISSING" });
    expect((evts[0] as { message: string }).message).toMatch(/does not exist/);
    expect(evts[1]).toEqual({ type: "end", status: "failed", code: null });
  });
});

describe("error codes", () => {
  // `message` is prose and will be reworded; `code` is the contract consumers
  // branch on. Each code gets an assertion so a refactor cannot quietly
  // reclassify a failure (e.g. a missing binary surfacing as SPAWN_FAILED,
  // which would send the user to the wrong remedy).
  it("detect-only (acp) agent → UNSUPPORTED_PROTOCOL, not a spawn failure", async () => {
    const evts = await drain(
      invokeAgent({ agent: "hermes", prompt: "hi", binOverride: process.execPath }),
    );
    expect(evts.find((e) => e.type === "error")).toMatchObject({
      code: "UNSUPPORTED_PROTOCOL",
    });
    expect(evts.at(-1)).toEqual({ type: "end", status: "failed", code: null });
  });

  it("registered agent with no binary → AGENT_NOT_INSTALLED", async () => {
    const evts = await drain(
      invokeAgent({ agent: "qwen", prompt: "hi" }),
    );
    const err = evts.find((e) => e.type === "error");
    // Only meaningful when qwen genuinely isn't installed on this machine.
    if (err) expect(err).toMatchObject({ code: "AGENT_NOT_INSTALLED" });
  });

  it("every error event carries a code", async () => {
    const evts = await drain(invokeAgent({ agent: "nope", prompt: "hi" }));
    for (const e of evts) {
      if (e.type === "error") expect(typeof e.code).toBe("string");
    }
  });
});

posixOnly("invokeAgent — fake child process", () => {
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

  it("emits start → deltas/meta → end(ok)", async () => {
    const evts = await drain(invokeAgent({ agent: "claude", prompt: "build a page" }));
    const types = evts.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types[types.length - 1]).toBe("end");
    expect(
      evts
        .filter((e) => e.type === "delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("<p>ok</p>");
    expect(evts).toContainEqual({ type: "meta", key: "model", value: "claude-sonnet" });
    expect(evts).toContainEqual({ type: "end", status: "ok", code: 0 });
  });

  it("honors abort: reports end(aborted), not a silent close", async () => {
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
    // The child may still flush a couple of events before the kill lands, so
    // assert on the terminal event rather than an exact event count.
    const rest: InvokeEvent[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value!);
    }
    const last = rest[rest.length - 1];
    expect(last).toEqual({ type: "end", status: "aborted", code: null });
    // Exactly one terminal event, ever.
    expect(rest.filter((e) => e.type === "end")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Process lifetime — cancel / abort must kill the child *and its descendants*.
//
// Each test spawns a fake agent that would write a marker file if it outlived
// the teardown. Asserting "marker absent" is the only reliable cross-platform
// way to prove the process is gone: pid probing races with pid reuse, and
// `ps` is not available in every sandbox.
// ---------------------------------------------------------------------------
posixOnly("process lifetime — no orphan leaks", () => {
  const markerDir = join(tmpdir(), "agent-bridge-lifetime");

  // Two stream-json lines every fake agent emits before it forks/sleeps, so
  // the test can be sure the script is actually running before tearing down.
  const PREAMBLE = [
    `echo '{"type":"system","subtype":"init","model":"x","session_id":"s1"}'`,
    `echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'`,
  ];

  beforeAll(() => {
    rmSync(markerDir, { recursive: true, force: true });
    mkdirSync(markerDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(markerDir, { recursive: true, force: true });
  });

  const writeFakeBin = (name: string, lines: string[]): string => {
    const p = join(markerDir, name);
    writeFileSync(p, ["#!/bin/sh", ...lines].join("\n"), "utf8");
    chmodSync(p, 0o755);
    return p;
  };

  /** Read events until the first `delta` — i.e. the fake agent is live. */
  async function readUntilDelta(
    reader: ReadableStreamDefaultReader<InvokeEvent>,
  ): Promise<void> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before any delta arrived");
      if (value!.type === "delta") return;
    }
  }

  it("cancel() kills the child — the most common leak path (SSE client disconnect)", async () => {
    const marker = join(markerDir, "cancel-leak.txt");
    const bin = writeFakeBin("fake-cancel", [
      ...PREAMBLE,
      "sleep 2",
      `echo leaked > "${marker}"`,
    ]);

    const reader = invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin }).getReader();
    await readUntilDelta(reader);
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 4000));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("abort kills the whole process group, not just the npm shim", async () => {
    const marker = join(markerDir, "abort-grandchild-leak.txt");
    // Fork the grandchild BEFORE announcing readiness. PREAMBLE's delta is
    // what the test waits on, so emitting it first left a window where abort
    // could land before the grandchild existed — then nothing survives the
    // kill and the test passes for the wrong reason, or the fork races the
    // signal and it fails. Ordering the fork first makes "saw a delta" mean
    // "the grandchild is running", which is the precondition under test.
    const bin = writeFakeBin("fake-grandchild", [
      // Mimic an npm shim: the real agent is a grandchild. Signalling only the
      // direct child would leave this running.
      `sh -c 'sleep 2; echo leaked > "${marker}"' &`,
      ...PREAMBLE,
      "wait",
    ]);

    const ctl = new AbortController();
    const reader = invokeAgent({
      agent: "claude",
      prompt: "hi",
      binOverride: bin,
      signal: ctl.signal,
    }).getReader();
    await readUntilDelta(reader);
    ctl.abort();

    await new Promise((r) => setTimeout(r, 4000));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("escalates to SIGKILL when the agent traps SIGTERM", async () => {
    const marker = join(markerDir, "sigkill-grace-leak.txt");
    const bin = writeFakeBin("fake-stubborn", [
      "trap '' TERM",
      ...PREAMBLE,
      // Writes the marker AFTER the SIGKILL grace window but BEFORE the
      // assertion below. So a trapped-SIGTERM survivor leaves a marker, while
      // a SIGKILLed process never gets there. (A longer sleep would make the
      // test pass vacuously — the marker would simply not be written yet.)
      "sleep 4",
      `echo leaked > "${marker}"`,
    ]);

    const ctl = new AbortController();
    const reader = invokeAgent({
      agent: "claude",
      prompt: "hi",
      binOverride: bin,
      signal: ctl.signal,
    }).getReader();
    await readUntilDelta(reader);
    ctl.abort();

    // Wait past the script's `sleep 4` (> SIGKILL_GRACE_MS): if the SIGKILL
    // had not landed, the marker would exist by now.
    await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS + 3000));
    expect(existsSync(marker)).toBe(false);
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Terminal-event contract: exactly one `end` per invocation, with a status
// that distinguishes finished / cancelled / timed-out / never-started.
// ---------------------------------------------------------------------------
posixOnly("terminal event contract", () => {
  const dir = join(tmpdir(), "agent-bridge-terminal");

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const fakeBin = (name: string, lines: string[]): string => {
    const p = join(dir, name);
    writeFileSync(p, ["#!/bin/sh", ...lines].join("\n"), "utf8");
    chmodSync(p, 0o755);
    return p;
  };

  it("timeoutMs → error + end(timeout), and the child is killed", async () => {
    const marker = join(dir, "timeout-leak.txt");
    const bin = fakeBin("fake-slow", [
      `echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}'`,
      "sleep 4",
      `echo leaked > "${marker}"`,
    ]);

    const evts = await drain(
      invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin, timeoutMs: 700 }),
    );

    const last = evts[evts.length - 1];
    expect(last).toEqual({ type: "end", status: "timeout", code: null });
    expect(evts.filter((e) => e.type === "end")).toHaveLength(1);
    expect(
      evts.some(
        (e) =>
          e.type === "error" &&
          e.code === "TIMEOUT" &&
          /timed out after 700ms/.test(e.message),
      ),
    ).toBe(true);

    // The timeout must also tear the process down, not just detach from it.
    await new Promise((r) => setTimeout(r, 4500));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("a run that finishes before timeoutMs still reports end(ok)", async () => {
    const bin = fakeBin("fake-quick", [
      `echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}'`,
      "exit 0",
    ]);
    const evts = await drain(
      invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin, timeoutMs: 10_000 }),
    );
    expect(evts[evts.length - 1]).toEqual({ type: "end", status: "ok", code: 0 });
  }, 20_000);

  it("non-zero exit is end(ok) with the code — 'ok' means 'ran to completion'", async () => {
    const bin = fakeBin("fake-fail", ["exit 3"]);
    const evts = await drain(invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin }));
    expect(evts[evts.length - 1]).toEqual({ type: "end", status: "ok", code: 3 });
  }, 20_000);

  it("caps runaway stdout that never emits a newline", async () => {
    // ~24MB on one line, over the 16MB cap.
    const bin = fakeBin("fake-flood", [
      `awk 'BEGIN{ s=sprintf("%*s", 1000000, ""); for(i=0;i<24;i++) printf "%s", s }'`,
      "sleep 5",
    ]);
    const evts = await drain(invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin }));
    expect(
      evts.some(
        (e) =>
          e.type === "error" &&
          e.code === "OUTPUT_OVERFLOW" &&
          /aborting to protect the host/.test(e.message),
      ),
    ).toBe(true);
    expect(evts.filter((e) => e.type === "end")).toHaveLength(1);
  }, 30_000);
});
