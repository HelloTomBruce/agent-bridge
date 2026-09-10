import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { invokeAgent, SIGKILL_GRACE_MS, type InvokeEvent } from "../src/invoke.js";
import { buildArgv, UnsupportedAgentProtocolError } from "../src/argv.js";

/**
 * Write a launchable fake agent: a `.cmd` shim on Windows, a `sh` shim
 * elsewhere, both delegating to the same Node script. This mirrors how npm
 * actually installs agent CLIs (a shim that exec's node), which is precisely
 * the shape that made process-group teardown tricky in the first place — the
 * real agent is a *grandchild* of what we spawn.
 *
 * Using Node for the agent body (rather than sh/cmd built-ins) is what lets
 * these tests run on Windows at all, so the `taskkill /T` path is covered
 * instead of skipped.
 */
function writeShim(dir: string, name: string, scenario: string, marker?: string): string {
  const agent = fileURLToPath(new URL("./helpers/fake-agent.mjs", import.meta.url));
  const args = [agent, scenario, ...(marker ? [marker] : [])]
    .map((a) => `"${a}"`)
    .join(" ");
  if (process.platform === "win32") {
    const p = join(dir, `${name}.cmd`);
    // %* forwards the agent's own argv; the shim ignores it.
    writeFileSync(p, `@echo off\r\n"${process.execPath}" ${args} %*\r\n`, "utf8");
    return p;
  }
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" ${args} "$@"\n`, "utf8");
  chmodSync(p, 0o755);
  return p;
}

/** Only meaningful on POSIX: Windows has no SIGTERM for an agent to trap. */
const posixOnlyIt = process.platform === "win32" ? it.skip : it;

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

describe("invokeAgent — fake child process", () => {
  // A fake agent that speaks claude's stream-json shape.
  const dir = join(tmpdir(), "agent-bridge-fake-claude-dir");

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_BIN = writeShim(dir, "fake-claude", "claude-turn");
  });

  afterAll(() => {
    delete process.env.CLAUDE_BIN;
    rmSync(dir, { recursive: true, force: true });
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
describe("process lifetime — no orphan leaks", () => {
  const markerDir = join(tmpdir(), "agent-bridge-lifetime");

  beforeAll(() => {
    rmSync(markerDir, { recursive: true, force: true });
    mkdirSync(markerDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(markerDir, { recursive: true, force: true });
  });

  const writeFakeBin = (name: string, scenario: string, marker?: string): string =>
    writeShim(markerDir, name, scenario, marker);

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
    const bin = writeFakeBin("fake-cancel", "sleeper", marker);

    const reader = invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin }).getReader();
    await readUntilDelta(reader);
    await reader.cancel();

    await new Promise((r) => setTimeout(r, 4000));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("abort kills the whole process group, not just the npm shim", async () => {
    const marker = join(markerDir, "abort-grandchild-leak.txt");
    // The scenario forks its grandchild BEFORE announcing readiness, so
    // "saw a delta" means "the grandchild is running" — otherwise abort could
    // land in the gap and the test would pass for the wrong reason.
    const bin = writeFakeBin("fake-grandchild", "grandchild", marker);

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

  // POSIX-only: Windows has no SIGTERM for an agent to trap — `taskkill /F`
  // is unconditional, so there is no graceful-then-forceful escalation to
  // verify there.
  posixOnlyIt("escalates to SIGKILL when the agent traps SIGTERM", async () => {
    const marker = join(markerDir, "sigkill-grace-leak.txt");
    // Writes the marker AFTER the SIGKILL grace window but BEFORE the
    // assertion below: a trapped-SIGTERM survivor leaves a marker, a SIGKILLed
    // process never gets there. (A longer delay would make the test pass
    // vacuously — the marker simply would not be written yet.)
    const bin = writeFakeBin("fake-stubborn", "stubborn", marker);

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
describe("terminal event contract", () => {
  const dir = join(tmpdir(), "agent-bridge-terminal");

  beforeAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // All the scenarios used here exist in `helpers/fake-agent.mjs`.
  const wb = (name: string, scenario: string, marker?: string): string =>
    writeShim(dir, name, scenario, marker);

  it("timeoutMs → error + end(timeout), and the child is killed", async () => {
    const marker = join(dir, "timeout-leak.txt");
    const bin = wb("fake-slow", "slow", marker);

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
    const bin = wb("fake-quick", "quick");
    const evts = await drain(
      invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin, timeoutMs: 10_000 }),
    );
    expect(evts[evts.length - 1]).toEqual({ type: "end", status: "ok", code: 0 });
  }, 20_000);

  it("non-zero exit is end(ok) with the code — 'ok' means 'ran to completion'", async () => {
    const bin = wb("fake-fail", "fail");
    const evts = await drain(invokeAgent({ agent: "claude", prompt: "hi", binOverride: bin }));
    expect(evts[evts.length - 1]).toEqual({ type: "end", status: "ok", code: 3 });
  }, 20_000);

  it("caps runaway stdout that never emits a newline", async () => {
    const bin = wb("fake-flood", "flood");
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
