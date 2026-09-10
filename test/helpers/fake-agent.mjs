#!/usr/bin/env node
/**
 * Cross-platform fake agent used by the process-lifetime tests.
 *
 * Written in Node rather than as a shell script so the same behaviour runs on
 * Windows: `sh` scripts are not executable there, which is why these suites
 * used to be skipped and the `taskkill /T` teardown path went untested.
 *
 * Behaviour is selected by argv[2] (the scenario name); everything else on the
 * command line is the agent's own argv and is ignored.
 */
import { writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

const scenario = process.argv[2];
const marker = process.argv[3];

/**
 * Write to fd 1 *synchronously*. `process.stdout.write` only queues on a pipe,
 * and `process.exit` discards whatever is still queued — so a scenario that
 * emits and exits immediately can lose its own output. writeSync blocks until
 * the bytes are in the pipe.
 */
const out = (s) => {
  try {
    writeSync(1, s);
  } catch {
    // EPIPE: the parent tore us down mid-write, which is the point of some
    // of these scenarios.
  }
};

const emit = (obj) => out(JSON.stringify(obj) + "\n");

/** The two lines every scenario emits so the test knows the agent is live. */
const preamble = () => {
  emit({ type: "system", subtype: "init", model: "x", session_id: "s1" });
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
  });
};

/** Write the leak marker after `ms`, unless we are killed first. */
const leakAfter = (ms) =>
  setTimeout(() => {
    if (marker) writeFileSync(marker, "leaked");
    process.exit(0);
  }, ms);

switch (scenario) {
  // Killed via cancel()/abort: the marker must never appear.
  case "sleeper":
    preamble();
    leakAfter(2000);
    break;

  // The real work happens in a grandchild, mimicking an npm shim. Killing only
  // the direct child leaves this running. Spawned BEFORE the preamble so that
  // "saw a delta" means "the grandchild exists" — otherwise abort can land in
  // the gap and the test passes for the wrong reason.
  case "grandchild": {
    spawn(
      process.execPath,
      ["-e", `setTimeout(()=>{require("node:fs").writeFileSync(${JSON.stringify(marker)},"leaked")},2000)`],
      { stdio: "ignore", detached: false },
    );
    preamble();
    setTimeout(() => process.exit(0), 10_000);
    break;
  }

  // Ignores SIGTERM, so only the SIGKILL escalation can stop it. On Windows
  // there is no SIGTERM to trap — taskkill /F is unconditional — so the test
  // that uses this scenario stays POSIX-only.
  case "stubborn":
    process.on("SIGTERM", () => {});
    preamble();
    leakAfter(4000);
    break;

  // A full claude-shaped turn: reads the prompt from stdin, then emits an
  // init envelope, one delta and a result envelope before exiting cleanly.
  case "claude-turn": {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      emit({ type: "system", subtype: "init", model: "claude-sonnet", session_id: "s1" });
      emit({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "<p>ok</p>" } },
      });
      emit({ type: "result", subtype: "success", usage: { input_tokens: 5 } });
      process.exit(0);
    });
    break;
  }

  // Emits one delta then hangs, for the timeout test.
  case "slow":
    preamble();
    leakAfter(4000);
    break;

  // Emits one delta and exits cleanly.
  case "quick":
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    });
    process.exit(0);
    break;

  // Exits non-zero without output.
  case "fail":
    process.exit(3);
    break;

  // ~24 MB on a single line, over the 16 MB cap. Written synchronously: with
  // async writes the parent kills us (correctly) at 16 MB, but `process.exit`
  // on a timer would drop the rest of the queue first, so on a slow runner
  // fewer than 16 MB ever reached the parent and the cap never tripped.
  // Blocking writes make "the parent has seen N bytes" a fact, not a race.
  case "flood": {
    const chunk = " ".repeat(1_000_000);
    for (let i = 0; i < 24; i++) out(chunk);
    // Stay alive so the parent's teardown is what ends this, not our own exit.
    setTimeout(() => process.exit(0), 30_000);
    break;
  }

  default:
    process.stderr.write(`unknown scenario: ${scenario}\n`);
    process.exit(64);
}
