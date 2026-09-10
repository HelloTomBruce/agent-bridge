import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveOnPath, resolveOpenclawAgentId, AGENTS, type AgentDef } from "./detect.js";
import { buildArgv, envFor, makeParser, UnsupportedAgentProtocolError } from "./argv.js";
import type { AgentArgvOpts } from "./argv.js";

/**
 * Grace period between SIGTERM and SIGKILL when tearing down an agent's
 * process tree. Long enough for a well-behaved CLI to flush and exit, short
 * enough that a wedged agent doesn't pin resources.
 */
export const SIGKILL_GRACE_MS = 3000;

/**
 * Cap on buffered stdout that has not yet formed a complete line (and on the
 * single-document buffer used by `argv-message` agents). A wedged or hostile
 * agent that emits megabytes without a newline would otherwise grow the buffer
 * until the host OOMs.
 */
export const MAX_STDOUT_BUFFER_BYTES = 16 * 1024 * 1024;

export type InvokeOpts = {
  agent: string;
  prompt: string;
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
  /**
   * Wall-clock budget for the run. On expiry the process tree is terminated
   * and the stream emits `{ type: "end", status: "timeout" }`.
   *
   * Defend against agents that block forever waiting on interactive input —
   * a missing `--yes`-style flag otherwise hangs the request indefinitely.
   * Omit or set 0 to disable.
   */
  timeoutMs?: number;
  /**
   * Absolute path to the agent binary. Wins over `process.env[envOverride]`
   * and the PATH scan when set. Surfaced from host settings UIs for users
   * whose CLI lives outside the heuristic toolchain dirs.
   */
  binOverride?: string;
};

type BinResolution =
  | { kind: "ok"; bin: string }
  | { kind: "override-missing"; tried: string }
  | { kind: "not-found" };

/**
 * Resolve the binary to spawn, in priority order:
 *   1. `opts.binOverride` (user-set absolute path from host settings UI)
 *   2. `process.env[def.envOverride]` (e.g. CLAUDE_BIN, OPENCLAW_BIN)
 *   3. PATH scan over `def.bin` then `def.fallbackBins`
 *
 * If a `binOverride` is set but doesn't resolve, return `override-missing`
 * (do not silently fall through) — the user picked an explicit path and
 * deserves to see the typo / wrong path instead of mysteriously running a
 * different binary.
 */
export function resolveBinForAgent(
  def: AgentDef,
  binOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BinResolution {
  const tryPath = (p: string | undefined): string | null => {
    if (!p) return null;
    const trimmed = p.trim();
    if (!trimmed) return null;
    // Absolute path → must exist; relative names → fall back to PATH scan.
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) {
      return existsSync(trimmed) ? trimmed : null;
    }
    return resolveOnPath(trimmed, env);
  };
  if (binOverride && binOverride.trim()) {
    const fromOverride = tryPath(binOverride);
    if (fromOverride) return { kind: "ok", bin: fromOverride };
    return { kind: "override-missing", tried: binOverride.trim() };
  }
  if (def.envOverride) {
    const fromEnv = tryPath(env[def.envOverride]);
    if (fromEnv) return { kind: "ok", bin: fromEnv };
  }
  for (const c of [def.bin, ...(def.fallbackBins ?? [])]) {
    const found = resolveOnPath(c, env);
    if (found) return { kind: "ok", bin: found };
  }
  return { kind: "not-found" };
}

/** Why a run stopped. Exactly one `end` event is emitted per invocation. */
export type InvokeEndStatus =
  /** Child exited on its own (inspect `code` for success/failure). */
  | "ok"
  /** Caller aborted via `signal`, or the stream was cancelled. */
  | "aborted"
  /** `timeoutMs` elapsed. */
  | "timeout"
  /** Never started, or died in a way that produced an `error` event. */
  | "failed";

/**
 * Stable, machine-checkable reason for an `error` event.
 *
 * `message` is prose for humans and will be reworded; `code` is the contract.
 * Without it a consumer that wants to branch — offer an install link, open the
 * custom-path setting, show a retry — has to substring-match error text, which
 * silently breaks the moment the wording changes.
 */
export type InvokeErrorCode =
  /** `opts.agent` is not in the registry. */
  | "UNKNOWN_AGENT"
  /** Registered, but no binary on PATH or in the scanned toolchain dirs. */
  | "AGENT_NOT_INSTALLED"
  /** `binOverride` was set but does not exist — never falls back silently. */
  | "BIN_OVERRIDE_MISSING"
  /** Detect-only adapter (ACP family); invocation is not implemented. */
  | "UNSUPPORTED_PROTOCOL"
  /** The child could not be started, or died before producing output. */
  | "SPAWN_FAILED"
  /** `timeoutMs` elapsed; the process tree was terminated. */
  | "TIMEOUT"
  /** Output exceeded `MAX_STDOUT_BUFFER_BYTES` without a parseable break. */
  | "OUTPUT_OVERFLOW"
  /** The agent's output could not be parsed as its protocol claims. */
  | "PARSE_FAILED"
  /** The agent ran to completion but produced no content. */
  | "EMPTY_RESPONSE"
  /** Argv assembly failed for a reason not covered above. */
  | "ARGV_BUILD_FAILED";

export type InvokeEvent =
  | { type: "start"; bin: string; argv: string[]; promptBytes: number }
  | { type: "delta"; text: string }
  /**
   * Content recovered from a file-write tool call. REPLACE semantics for the
   * given `path` (see the `file_write` parse kind in argv.ts). Consumers decide
   * which paths they care about — the bridge does not filter by extension.
   */
  | { type: "file_write"; path: string; text: string }
  | { type: "meta"; key: string; value: unknown }
  | { type: "stderr"; text: string }
  | { type: "raw"; text: string }
  /**
   * Terminal event — always the last event, emitted exactly once, for every
   * outcome including abort/timeout/spawn failure. `code` is the child's exit
   * code when it ran to completion, else null.
   *
   * A bare `done` could not distinguish "finished" from "killed", so a UI had
   * no way to tell a completed run from a cancelled one.
   */
  | { type: "end"; status: InvokeEndStatus; code: number | null }
  | { type: "error"; code: InvokeErrorCode; message: string };

/**
 * Invoke a locally-installed coding agent CLI and stream its output back as
 * a Web `ReadableStream<InvokeEvent>`. The stream is pullable and abortable:
 *   - pass `signal` to abort → the whole child process tree is terminated and
 *     the stream closes without a `done` event
 *   - cancel the stream (e.g. an HTTP client disconnects and `toSseStream`
 *     propagates the cancel upstream) → the child tree is terminated too
 *
 * Termination kills the child's entire *process group*, not just the direct
 * child: agent CLIs are typically npm shims (`#!/bin/sh` → `exec node …`), so
 * signalling only the shim would leave the real agent running. SIGTERM is sent
 * first, then SIGKILL after `SIGKILL_GRACE_MS` if the tree is still alive.
 *
 * Errors (unknown agent, missing binary, override typo, spawn failure) are
 * surfaced as `{ type: "error", code }` events followed by close — never
 * thrown. Branch on `code` (see `InvokeErrorCode`), not on `message`.
 */
export function invokeAgent(opts: InvokeOpts): ReadableStream<InvokeEvent> {
  const def = AGENTS.find((a) => a.id === opts.agent);
  if (!def) {
    return errorStream("UNKNOWN_AGENT", `unknown agent: ${opts.agent}`);
  }
  const resolved = resolveBinForAgent(def, opts.binOverride);
  if (resolved.kind === "override-missing") {
    return errorStream(
      "BIN_OVERRIDE_MISSING",
      `${def.label}: custom path \`${resolved.tried}\` does not exist. Update or clear it in the host's custom-path setting.`,
    );
  }
  if (resolved.kind === "not-found") {
    return errorStream(
      "AGENT_NOT_INSTALLED",
      `${def.label} (\`${def.bin}\`) is not installed or not on PATH.`,
    );
  }
  const bin: string = resolved.bin;

  // For openclaw we need an async detection step (resolveOpenclawAgentId)
  // before buildArgv. Do all of the argv assembly inside the stream's async
  // start so we can `await` and surface failures as `error` events.
  const env = envFor(opts.agent);
  const promptViaArgv = def.protocol === "argv";
  const promptViaMessageFlag = def.protocol === "argv-message";

  // Hoisted out of `start` so the stream's `cancel()` can reach the child.
  // Assigned once the child is spawned; a no-op before that (and after the
  // child has already exited).
  let terminate: (reason?: Extract<InvokeEndStatus, "aborted" | "timeout">) => void =
    () => {};

  return new ReadableStream<InvokeEvent>({
    async start(controller) {
      let closed = false;
      let child: ChildProcessWithoutNullStreams | null = null;

      const safeEnqueue = (ev: InvokeEvent) => {
        if (closed) return;
        try {
          controller.enqueue(ev);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };

      // Guarantees the "exactly one terminal event" invariant regardless of
      // which path (exit / abort / timeout / spawn error) gets there first.
      let ended = false;
      const emitEnd = (status: InvokeEndStatus, code: number | null) => {
        if (ended) return;
        ended = true;
        safeEnqueue({ type: "end", status, code });
        safeClose();
      };

      // Resolve agent-specific argv. For openclaw we first probe `agents
      // list` to learn the actual agent id (commonly "main") so the CLI's
      // required `--agent <id>` is satisfied.
      let argv: string[];
      try {
        // Spread-if-present rather than `model: opts.model`: with
        // exactOptionalPropertyTypes an explicit `undefined` is no longer the
        // same as an absent key, and `model?: string` promises the key is
        // either a string or missing.
        const argvOpts: AgentArgvOpts = {
          prompt: opts.prompt,
          ...(opts.model ? { model: opts.model } : {}),
        };
        if (opts.agent === "openclaw") {
          argvOpts.openclawAgentId = await resolveOpenclawAgentId(bin);
        }
        argv = buildArgv(opts.agent, argvOpts);
      } catch (err) {
        safeEnqueue({
          type: "error",
          code: err instanceof UnsupportedAgentProtocolError
            ? "UNSUPPORTED_PROTOCOL"
            : "ARGV_BUILD_FAILED",
          message:
            err instanceof UnsupportedAgentProtocolError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err),
        });
        emitEnd("failed", null);
        return;
      }
      // `protocol: "argv"` adapters (deepseek-tui today) take the prompt as a
      // trailing positional arg rather than reading from stdin.
      if (promptViaArgv) argv = [...argv, opts.prompt];
      // `protocol: "argv-message"` (openclaw today) wants the prompt under
      // an explicit `--message <text>` flag.
      if (promptViaMessageFlag) argv = [...argv, "--message", opts.prompt];

      try {
        // On Windows, `spawn` cannot launch a `.cmd` / `.bat` shim (which is
        // what npm installs for most CLI agents) without going through the
        // shell. Without this, every agent invocation fails with
        // EINVAL / "spawn 无效的参数". macOS/Linux use direct exec.
        // Safety: prompt content is delivered via stdin or `--message
        // <text>` (argv-message), not interpolated into a shell command,
        // so this does not introduce a shell-injection vector.
        const useShell = process.platform === "win32";
        child = spawn(useShell ? `"${bin}"` : bin, argv, {
          cwd: opts.cwd ?? process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: useShell,
          windowsVerbatimArguments: false,
          // Make the child a process-group leader so termination can signal
          // the whole tree via `process.kill(-pid)`. Not used on Windows,
          // where `shell: true` is required for `.cmd` shims and cleanup goes
          // through `taskkill /T` instead.
          //
          // Trade-off: a detached child no longer shares the parent's process
          // group, so a Ctrl+C delivered to the parent will NOT reach it. CLI
          // consumers must wire SIGINT to an AbortController (see README).
          detached: !useShell,
        });
      } catch (err) {
        safeEnqueue({
          type: "error",
          code: "SPAWN_FAILED",
          message: err instanceof Error ? err.message : String(err),
        });
        emitEnd("failed", null);
        return;
      }

      safeEnqueue({
        type: "start",
        bin,
        argv,
        promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
      });

      // `exited` gates termination: once the child is reaped, its pid may be
      // recycled by the OS, and signalling it would hit an unrelated process.
      let exited = false;
      let sigkillTimer: NodeJS.Timeout | null = null;
      const clearSigkillTimer = () => {
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = null;
        }
      };

      // Records WHY we killed the child, so the `close` handler can report
      // "aborted"/"timeout" instead of the misleading "ok" that a SIGTERM-
      // induced exit would otherwise look like.
      let termReason: Extract<InvokeEndStatus, "aborted" | "timeout"> | null = null;

      terminate = (reason: Extract<InvokeEndStatus, "aborted" | "timeout"> = "aborted") => {
        if (termReason === null) termReason = reason;
        const pid = child?.pid;
        if (exited || pid === undefined) return;
        if (process.platform === "win32") {
          // No process groups: taskkill walks the tree (/T) and forces (/F).
          try {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          } catch {}
          return;
        }
        // Negative pid → the whole process group created by `detached: true`.
        // Fall back to signalling the direct child if the group is already
        // gone (ESRCH) or was never created.
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            child?.kill("SIGTERM");
          } catch {}
        }
        // Agents that trap or ignore SIGTERM get one grace period, then die.
        clearSigkillTimer();
        sigkillTimer = setTimeout(() => {
          if (exited) return;
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              child?.kill("SIGKILL");
            } catch {}
          }
        }, SIGKILL_GRACE_MS);
        // Don't hold the event loop open just to deliver a SIGKILL.
        sigkillTimer.unref?.();
      };

      // Wall-clock guard. Fires terminate("timeout"); the `close` handler then
      // reports status "timeout". Cleared on exit so a finished run doesn't
      // keep the timer (and the event loop) alive.
      let timeoutTimer: NodeJS.Timeout | null = null;
      const clearTimeoutTimer = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          safeEnqueue({
            type: "error",
            code: "TIMEOUT",
            message: `agent timed out after ${opts.timeoutMs}ms`,
          });
          terminate("timeout");
        }, opts.timeoutMs);
        timeoutTimer.unref?.();
      }

      const onAbort = () => {
        terminate("aborted");
        // Do NOT close the stream here: closing before the child's `close`
        // handler runs would drop the terminal `end` event. Teardown is
        // reported from one place only.
      };
      const detachAbort = () => {
        opts.signal?.removeEventListener("abort", onAbort);
      };

      child.stdin.on("error", () => {});
      try {
        // stdin-protocol agents read the prompt from stdin; argv / argv-message
        // agents already have it on the command line.
        if (!promptViaArgv && !promptViaMessageFlag) child.stdin.write(opts.prompt);
        child.stdin.end();
      } catch {}

      // One parser per spawn so cross-line dedupe state (sawStreamEventText)
      // is scoped to this single invocation and doesn't leak across runs.
      const parse = makeParser(opts.agent);

      let stdoutBuf = "";
      // Set when the buffer cap trips, so we stop re-reporting on every chunk.
      let bufferOverflowed = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (closed || bufferOverflowed) return;
        stdoutBuf += chunk;
        // Runaway-output guard. The cap applies to the *unconsumed* buffer:
        // line-delimited agents drain it below, so hitting the limit means a
        // single line (or an argv-message document) exceeded the budget.
        if (stdoutBuf.length > MAX_STDOUT_BUFFER_BYTES) {
          bufferOverflowed = true;
          safeEnqueue({
            type: "error",
            code: "OUTPUT_OVERFLOW",
            message:
              `agent produced more than ${MAX_STDOUT_BUFFER_BYTES} bytes of unparsable ` +
              `output without a line break; aborting to protect the host`,
          });
          stdoutBuf = "";
          terminate("aborted");
          return;
        }
        // OpenClaw emits one big multi-line JSON document — accumulate and
        // parse it once on close instead of trying to parse each line.
        if (opts.agent === "openclaw") return;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          for (const part of parse(line)) {
            // Some agents (bob) may echo the entire prompt back as the first
            // streamed delta. Suppress that to avoid polluting the output
            // with the system prompt.
            if (opts.agent === "bob" && part.kind === "delta") {
              if (part.text.trim() === opts.prompt.trim()) continue;
            }
            if (part.kind === "delta") safeEnqueue({ type: "delta", text: part.text });
            else if (part.kind === "file_write")
              safeEnqueue({ type: "file_write", path: part.path, text: part.text });
            else if (part.kind === "meta") safeEnqueue({ type: "meta", key: part.key, value: part.value });
            else safeEnqueue({ type: "raw", text: line.slice(0, 240) });
          }
        }
      });

      // stderr is forwarded, not buffered, but a chatty agent can still flood
      // the consumer — cap the total volume we relay.
      let stderrBytes = 0;
      let stderrTruncated = false;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderrTruncated) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDOUT_BUFFER_BYTES) {
          stderrTruncated = true;
          safeEnqueue({ type: "stderr", text: "\n[agent-bridge] stderr truncated\n" });
          return;
        }
        safeEnqueue({ type: "stderr", text: chunk });
      });

      child.on("error", (err) => {
        // spawn/EACCES etc. — the child never really ran; stop tracking it.
        exited = true;
        clearSigkillTimer();
        clearTimeoutTimer();
        detachAbort();
        safeEnqueue({ type: "error", code: "SPAWN_FAILED", message: err.message });
        emitEnd("failed", null);
      });

      child.on("close", (code) => {
        exited = true;
        clearSigkillTimer();
        clearTimeoutTimer();
        detachAbort();
        if (opts.agent === "openclaw") {
          // OpenClaw's `agent --local --json` emits one pretty-printed JSON
          // document on stdout. The visible reply is at
          // `data.finalAssistantVisibleText`; usage / model show up in
          // `data.executionTrace`. Emit the visible text as a single delta.
          if (stdoutBuf.trim()) {
            try {
              const obj = JSON.parse(stdoutBuf) as {
                payloads?: Array<{ text?: string }>;
                meta?: {
                  finalAssistantVisibleText?: string;
                  finalAssistantRawText?: string;
                  executionTrace?: { winnerProvider?: string; winnerModel?: string };
                  completion?: { stopReason?: string };
                  agentMeta?: { sessionId?: string };
                };
              };
              const text = obj?.meta?.finalAssistantVisibleText
                ?? obj?.meta?.finalAssistantRawText
                ?? obj?.payloads?.[0]?.text
                ?? "";
              if (text) safeEnqueue({ type: "delta", text });
              const trace = obj?.meta?.executionTrace;
              if (trace?.winnerModel) {
                safeEnqueue({
                  type: "meta",
                  key: "model",
                  value: trace.winnerProvider
                    ? `${trace.winnerProvider}/${trace.winnerModel}`
                    : trace.winnerModel,
                });
              }
              if (obj?.meta?.agentMeta?.sessionId) {
                safeEnqueue({ type: "meta", key: "session", value: obj.meta.agentMeta.sessionId });
              }
              if (obj?.meta?.completion?.stopReason) {
                safeEnqueue({ type: "meta", key: "result", value: obj.meta.completion.stopReason });
              }
              if (!text) {
                safeEnqueue({
                  type: "error",
                  code: "EMPTY_RESPONSE",
                  message: "OpenClaw returned an empty assistant message",
                });
              }
            } catch (err) {
              safeEnqueue({
                type: "error",
                code: "PARSE_FAILED",
                message: `OpenClaw JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
        } else if (stdoutBuf) {
          if (opts.agent === "aider" || opts.agent === "codewhale" || opts.agent === "deepseek-tui") {
            safeEnqueue({ type: "delta", text: stdoutBuf });
          } else {
            for (const part of parse(stdoutBuf)) {
              if (part.kind === "delta") safeEnqueue({ type: "delta", text: part.text });
              else if (part.kind === "file_write")
                safeEnqueue({ type: "file_write", path: part.path, text: part.text });
              else if (part.kind === "meta") safeEnqueue({ type: "meta", key: part.key, value: part.value });
            }
          }
        }
        // A killed child still reaches `close`; termReason distinguishes that
        // from a natural exit.
        emitEnd(termReason ?? "ok", termReason ? null : code);
      });

      opts.signal?.addEventListener("abort", onAbort, { once: true });
      // A signal that aborted between bin resolution and here would otherwise
      // be missed, leaving an orphan child for the full run.
      if (opts.signal?.aborted) onAbort();
    },
    cancel() {
      // Downstream went away (HTTP client disconnected, reader cancelled).
      // Without this the agent process keeps running to completion — the
      // single most common leak path, since `toSseStream` forwards cancels.
      terminate("aborted");
    },
  });
}

function errorStream(code: InvokeErrorCode, message: string): ReadableStream<InvokeEvent> {
  return new ReadableStream<InvokeEvent>({
    start(controller) {
      controller.enqueue({ type: "error", code, message });
      // Terminal event invariant: every stream ends with exactly one `end`,
      // so consumers need only one teardown path.
      controller.enqueue({ type: "end", status: "failed", code: null });
      controller.close();
    },
  });
}
