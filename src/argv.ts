export type AgentArgvOpts = {
  model?: string;
  cwd?: string;
  /** When the adapter takes the prompt as a positional argv (deepseek-tui). */
  prompt?: string;
  /**
   * For openclaw only — pre-resolved agent id (e.g. "main" or "ops") that
   * gets injected into the argv as `--agent <id>`. invoke.ts is responsible
   * for resolving this via `resolveOpenclawAgentId` before calling buildArgv.
   */
  openclawAgentId?: string;
};

export class UnsupportedAgentProtocolError extends Error {
  constructor(public readonly agent: string, public readonly protocol: string) {
    super(
      `${agent} uses the ${protocol} protocol, which is not yet wired up in this build. ` +
        `Pick one of: claude / codex / cursor-agent / gemini / copilot / opencode / qwen / qoder / codewhale / deepseek-tui / aider.`,
    );
  }
}

/**
 * Build the argv for a non-interactive invocation of the given agent.
 * Prompt delivery (stdin vs positional vs --message) is handled by
 * `invokeAgent` after this returns — see the `AgentProtocol` docs.
 */
export function buildArgv(agent: string, _opts: AgentArgvOpts = {}): string[] {
  const { model } = _opts;
  switch (agent) {
    case "claude":
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
        ...(model ? ["--model", model] : []),
      ];
    case "openclaw":
      // OpenClaw is a multi-channel agent gateway — invocation is
      //   openclaw agent --local --json --agent <id> [--model <id>]
      // and the prompt is appended later via `--message <text>` by invoke.ts
      // (see protocol === "argv-message"). The agent id is resolved at
      // invocation time by `resolveOpenclawAgentId`.
      return [
        "agent",
        "--local",
        "--json",
        "--agent",
        _opts.openclawAgentId ?? "main",
        ...(model ? ["--model", model] : []),
      ];
    case "codex":
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...(model ? ["--model", model] : []),
      ];
    case "cursor-agent":
      return [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--trust",
        ...(model ? ["--model", model] : []),
      ];
    case "gemini":
      return [
        "--output-format",
        "stream-json",
        "--yolo",
        ...(model ? ["--model", model] : []),
      ];
    case "copilot":
      return [
        "--allow-all-tools",
        "--output-format",
        "json",
        ...(model ? ["--model", model] : []),
      ];
    case "bob":
      // Bob's `-p`/`--prompt` flag expects an argument; we stream the prompt via
      // stdin, so omit `-p` and just request stream-json output.
      // --hide-intermediary-output suppresses thinking/reasoning, leaving only
      // the final completion in stdout.
      return ["--output-format", "stream-json", "--hide-intermediary-output"];
    case "opencode":
      return [
        "run",
        "--format",
        "json",
        "--dangerously-skip-permissions",
        ...(model ? ["--model", model] : []),
        "-",
      ];
    case "qwen":
      return ["--yolo", ...(model ? ["--model", model] : []), "-"];
    case "aider":
      return [
        "--no-pretty",
        "--no-stream",
        "--yes-always",
        "--message-file",
        "-",
        ...(model ? ["--model", model] : []),
      ];
    case "qoder":
      // Qoder CLI mirrors `claude -p`'s shape: print mode + stream-json + yolo
      // for non-interactive approval. Prompt arrives via stdin.
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--yolo",
        ...(model ? ["--model", model] : []),
      ];
    case "codewhale":
    case "deepseek-tui":
      // DeepSeek's `exec --auto` requires the prompt as a positional arg;
      // there's no `-` stdin sentinel. invoke.ts appends opts.prompt at
      // spawn time, so we leave the trailing slot empty here.
      return ["exec", "--auto", ...(model ? ["--model", model] : [])];
    case "hermes":
    case "kimi":
    case "devin":
    case "kiro":
    case "kilo":
    case "vibe":
      throw new UnsupportedAgentProtocolError(agent, "ACP JSON-RPC");
    case "pi":
      // @earendil-works/pi-coding-agent — verified against pi 0.85.1.
      // Non-interactive "print" mode + ndjson output. Prompt arrives as a
      // positional arg (argv protocol). No session file, trust project-local
      // files, skip context files to avoid reading AGENTS.md/CLAUDE.md.
      return [
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--approve",
        "--no-context-files",
        ...(model ? ["--model", model] : []),
      ];
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
}

export function envFor(agent: string): NodeJS.ProcessEnv {
  const base = { ...process.env };
  if (agent === "gemini") base.GEMINI_CLI_TRUST_WORKSPACE = "true";
  return base;
}

export type AgentParse =
  | { kind: "delta"; text: string }
  | { kind: "meta"; key: string; value: unknown }
  /**
   * Content recovered from a file-write tool call (Claude's `Write`,
   * opencode's `write`, …). Agents frequently ignore "stream the document
   * inline" instructions and dump the artifact into a file, leaving only a
   * chatty confirmation ("saved to out.html") in the assistant text — without
   * this rescue the real payload would be lost.
   *
   * `path` is reported verbatim (may be empty if the tool call omitted it) so
   * consumers can filter by extension themselves. The bridge deliberately does
   * NOT filter: deciding that only `.html` matters is application policy, not
   * protocol.
   *
   * Semantics are REPLACE, not append — the tool input is authoritative for
   * that file.
   */
  | { kind: "file_write"; path: string; text: string }
  | { kind: "noise" };

/**
 * Cross-line state that the parser carries between calls. Currently used to
 * dedupe text deltas: when an agent emits both fine-grained `stream_event`
 * `text_delta` blocks AND a final `assistant` message containing the same
 * text concatenated, we keep the streamed tokens and skip the assistant
 * message body. Without this dedupe, every Claude/Cursor/Gemini/Qoder run
 * with `--include-partial-messages` (or the equivalent) writes its output
 * twice.
 */
export type ParseState = {
  sawStreamEventText?: boolean;
  opencodeAccumulatedInputTokens?: number;
  opencodeAccumulatedOutputTokens?: number;
  opencodeAccumulatedCacheReadTokens?: number;
  opencodeAccumulatedCacheWriteTokens?: number;
  opencodeAccumulatedCost?: number;
};

/**
 * Build a stateful per-invocation parser. Feed every stdout line through the
 * returned function — it carries the cross-line state needed for dedupe.
 */
export function makeParser(agent: string): (line: string) => AgentParse[] {
  const state: ParseState = {};
  return (line: string) => parseLineWithState(agent, line, state);
}

/**
 * Parse a single line of agent stdout. Stateless wrapper kept for callers
 * that only need one-shot parsing (e.g. `extractTextFromLine`). Streaming
 * callers should use `makeParser` so dedupe state survives across lines.
 */
export function parseLine(agent: string, line: string): AgentParse[] {
  return parseLineWithState(agent, line, {});
}

/** Tool names treated as file-write operations across agent protocols. */
const WRITE_TOOL_NAMES = new Set([
  "write",
  "create_file",
  "createfile",
  "writefile",
  "write_file",
  "filewrite",
]);

/**
 * Extract every file-write tool call from an Anthropic-shaped `content` array.
 * Returns one entry per write so a turn that writes several files reports all
 * of them — the old HTML-only version concatenated them into a single blob,
 * which silently corrupted multi-file turns.
 *
 * `path` is preserved as-written (not lowercased) since consumers may display
 * it; matching against WRITE_TOOL_NAMES is case-insensitive.
 */
function rescueFileWrites(
  content: Array<{ type?: string; name?: string; input?: unknown }> | undefined,
): Array<{ path: string; text: string }> {
  if (!Array.isArray(content)) return [];
  const writes: Array<{ path: string; text: string }> = [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    const name = (block.name ?? "").toLowerCase();
    if (!WRITE_TOOL_NAMES.has(name)) continue;
    const input = block.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") continue;
    const path = String(input.file_path ?? input.path ?? input.filename ?? "");
    const text =
      typeof input.content === "string"
        ? input.content
        : typeof input.text === "string"
          ? input.text
          : typeof input.file_content === "string"
            ? input.file_content
            : "";
    if (text) writes.push({ path, text });
  }
  return writes;
}

function parseLineWithState(agent: string, line: string, state: ParseState): AgentParse[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Aider / DeepSeek — plain text streaming on stdout (DeepSeek tool calls
  // go to stderr, which is forwarded as `stderr` events, not parsed here).
  if (agent === "aider" || agent === "codewhale" || agent === "deepseek-tui") {
    return [{ kind: "delta", text: trimmed.endsWith("\n") ? trimmed : trimmed + "\n" }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: "noise" }];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const out: AgentParse[] = [];

  if (agent === "claude") {
    // Init / system metadata
    if (obj.type === "system" && obj.subtype === "init") {
      out.push({ kind: "meta", key: "model", value: obj.model });
      out.push({ kind: "meta", key: "session", value: obj.session_id });
      if (obj.cwd) out.push({ kind: "meta", key: "cwd", value: obj.cwd });
    }
    // Stream events (--include-partial-messages → fine-grained text_delta)
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
        out.push({ kind: "meta", key: "thinking", value: ev.delta.thinking });
      }
    }
    // Full assistant messages — fallback only when stream_event text deltas
    // were absent (e.g. older claude without --include-partial-messages).
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as {
        content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
        usage?: Record<string, number>;
        model?: string;
      };
      const fileWrites = rescueFileWrites(msg.content);
      if (fileWrites.length) {
        for (const w of fileWrites) out.push({ kind: "file_write", path: w.path, text: w.text });
        // suppress the chatty assistant text fallback below; the Write input
        // is authoritative for this turn.
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
      if (msg.usage) out.push({ kind: "meta", key: "usage_partial", value: msg.usage });
    }
    if (obj.type === "result") {
      if (obj.usage) out.push({ kind: "meta", key: "usage", value: obj.usage });
      if (typeof obj.duration_ms === "number") out.push({ kind: "meta", key: "duration_ms", value: obj.duration_ms });
      if (typeof obj.total_cost_usd === "number") out.push({ kind: "meta", key: "cost_usd", value: obj.total_cost_usd });
      if (typeof obj.subtype === "string") out.push({ kind: "meta", key: "result", value: obj.subtype });
    }
    if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
      out.push({ kind: "meta", key: "rate_limit", value: obj.rate_limit_info });
    }
  }

  if (agent === "pi") {
    // pi emits ndjson events. Parse the ones that carry content.
    if (obj.type === "message_update") {
      const ev = obj.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!ev || typeof ev !== "object") return out;
      switch (ev.type) {
        case "text_delta":
          if (typeof ev.delta === "string") out.push({ kind: "delta", text: ev.delta });
          break;
        case "toolcall_end": {
          const tc = (ev.toolCall ?? ev.tool_call) as Record<string, unknown> | undefined;
          if (tc) {
            const name = String(tc.name ?? "").toLowerCase();
            if (WRITE_TOOL_NAMES.has(name)) {
              const args = tc.arguments as Record<string, unknown> | undefined;
              if (args) {
                const path = String(args.path ?? args.file_path ?? "");
                const text = String(args.content ?? args.text ?? "");
                if (text.trim()) out.push({ kind: "file_write", path, text });
              }
            }
          }
          break;
        }
      }
    }
    if (obj.type === "message_end") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        if (msg.provider && msg.model)
          out.push({ kind: "meta", key: "model", value: `${msg.provider}/${msg.model}` });
        if (msg.stopReason) out.push({ kind: "meta", key: "result", value: msg.stopReason });
      }
    }
    if (obj.type === "turn_end") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg?.usage && typeof msg.usage === "object") {
        const u = msg.usage as Record<string, number>;
        out.push({
          kind: "meta",
          key: "usage",
          value: {
            input_tokens: u.input ?? 0,
            output_tokens: u.output ?? 0,
            cache_read_input_tokens: u.cacheRead ?? 0,
            cache_creation_input_tokens: u.cacheWrite ?? 0,
          },
        });
        if (typeof u.cost === "number") out.push({ kind: "meta", key: "cost_usd", value: u.cost });
        else if (typeof u.cost === "object") {
          const c = u.cost as Record<string, number>;
          if (typeof c.total === "number") out.push({ kind: "meta", key: "cost_usd", value: c.total });
        }
      }
    }
    return out;
  }

  if (agent === "codex") {
    if (obj.type === "item.completed" && obj.item && typeof obj.item === "object") {
      const item = obj.item as { item_type?: string; type?: string; text?: string };
      const itemType = item.item_type ?? item.type;
      if (
        (itemType === "assistant_message" || itemType === "agent_message") &&
        typeof item.text === "string"
      ) {
        out.push({ kind: "delta", text: item.text });
      }
    }
    if (obj.type === "item.delta" && typeof obj.text === "string") {
      out.push({ kind: "delta", text: obj.text });
    }
    if (obj.msg && typeof obj.msg === "object") {
      const msg = obj.msg as { type?: string; message?: string };
      if (msg.type === "agent_message" && typeof msg.message === "string") {
        out.push({ kind: "delta", text: msg.message });
      }
    }
    if (obj.type === "task_complete" && obj.usage) {
      out.push({ kind: "meta", key: "usage", value: obj.usage });
    }
    if (obj.type === "turn.completed" && obj.usage) {
      out.push({ kind: "meta", key: "usage", value: obj.usage });
    }
  }

  if (agent === "cursor-agent" || agent === "gemini") {
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      const fileWrites = rescueFileWrites(msg.content);
      if (fileWrites.length) {
        for (const w of fileWrites) out.push({ kind: "file_write", path: w.path, text: w.text });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
    }
    // Bare `text` field — only honor it when we haven't already emitted a
    // streamed delta or an assistant body, otherwise it duplicates the same
    // payload (cursor-agent / gemini both ship this redundancy on some
    // versions).
    if (typeof obj.text === "string" && !state.sawStreamEventText && obj.type !== "assistant") {
      out.push({ kind: "delta", text: obj.text as string });
    }
  }

  if (agent === "copilot") {
    // Some builds emit `response` and `text` on the same line carrying the
    // identical payload. Pushing both duplicated the whole reply, so pick one:
    // `response` is the assistant message, `text` is the fallback/echo field.
    const text =
      typeof obj.response === "string"
        ? obj.response
        : typeof obj.text === "string"
          ? obj.text
          : "";
    if (text) out.push({ kind: "delta", text });
  }

  if (agent === "opencode") {
    const part =
      obj.part && typeof obj.part === "object"
        ? (obj.part as Record<string, unknown>)
        : null;
    const text = [part?.text, part?.content, part?.message, obj.text, obj.content, obj.message].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (text) out.push({ kind: "delta", text });

    // Rescue content from a completed `write` tool call. opencode streams tool
    // input under `part.state.input` (not `part.input`), and the model often
    // prefers Write over streaming the document inline — without this the
    // artifact would be lost entirely (only the trailing "Done. out.html
    // written…" text arrives as a delta).
    const toolState = part?.state && typeof part.state === "object"
      ? (part.state as { status?: string; input?: Record<string, unknown> })
      : null;
    if (obj.type === "tool_use" && toolState?.status === "completed") {
      const tool = String(part?.tool ?? "").toLowerCase();
      if (WRITE_TOOL_NAMES.has(tool)) {
        const input = toolState.input ?? {};
        const filePath = String(input.filePath ?? input.path ?? "");
        const content =
          typeof input.content === "string"
            ? input.content
            : typeof input.text === "string"
              ? input.text
              : "";
        if (content.trim()) out.push({ kind: "file_write", path: filePath, text: content });
      }
    }
    if (obj.type === "step_start" && typeof obj.sessionID === "string") {
      out.push({ kind: "meta", key: "session", value: obj.sessionID });
    }
    if (part?.tokens && typeof part.tokens === "object") {
      const tokens = part.tokens as {
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
      };
      state.opencodeAccumulatedInputTokens = (state.opencodeAccumulatedInputTokens ?? 0) + (tokens.input ?? 0);
      state.opencodeAccumulatedOutputTokens = (state.opencodeAccumulatedOutputTokens ?? 0) + (tokens.output ?? 0);
      state.opencodeAccumulatedCacheReadTokens = (state.opencodeAccumulatedCacheReadTokens ?? 0) + (tokens.cache?.read ?? 0);
      state.opencodeAccumulatedCacheWriteTokens = (state.opencodeAccumulatedCacheWriteTokens ?? 0) + (tokens.cache?.write ?? 0);

      out.push({
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: state.opencodeAccumulatedInputTokens,
          output_tokens: state.opencodeAccumulatedOutputTokens,
          cache_read_input_tokens: state.opencodeAccumulatedCacheReadTokens,
          cache_creation_input_tokens: state.opencodeAccumulatedCacheWriteTokens,
        },
      });
    }
    if (typeof part?.cost === "number") {
      state.opencodeAccumulatedCost = (state.opencodeAccumulatedCost ?? 0) + part.cost;
      out.push({ kind: "meta", key: "cost_usd", value: state.opencodeAccumulatedCost });
    }
  }

  if (agent === "qwen") {
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
    if (typeof obj.content === "string") out.push({ kind: "delta", text: obj.content });
    if (typeof obj.message === "string") out.push({ kind: "delta", text: obj.message });
  }

  if (agent === "bob") {
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
    if (typeof obj.content === "string") out.push({ kind: "delta", text: obj.content });
    if (typeof obj.message === "string") out.push({ kind: "delta", text: obj.message });
  }

  if (agent === "qoder") {
    // Qoder's stream-json output mirrors claude's envelope shape (init/system,
    // stream_event with content_block_delta/text_delta, assistant message,
    // result with usage). Parse generously across both fine-grained deltas and
    // full assistant turns. Falls back to a bare `text` field for
    // forward-compatibility with future Qoder JSON variants.
    if (obj.type === "system" && obj.subtype === "init") {
      if (obj.model) out.push({ kind: "meta", key: "model", value: obj.model });
      if (obj.session_id) out.push({ kind: "meta", key: "session", value: obj.session_id });
    }
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      const fileWrites = rescueFileWrites(msg.content);
      if (fileWrites.length) {
        for (const w of fileWrites) out.push({ kind: "file_write", path: w.path, text: w.text });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
    }
    if (obj.type === "result") {
      if (obj.usage) out.push({ kind: "meta", key: "usage", value: obj.usage });
      if (typeof obj.duration_ms === "number") out.push({ kind: "meta", key: "duration_ms", value: obj.duration_ms });
    }
    if (typeof obj.text === "string" && !state.sawStreamEventText && obj.type !== "assistant") {
      out.push({ kind: "delta", text: obj.text });
    }
  }

  return out;
}

/** Back-compat shim for callers that just want plain text. */
export function extractTextFromLine(agent: string, line: string): string {
  return parseLine(agent, line)
    .filter((p): p is Extract<AgentParse, { kind: "delta" }> => p.kind === "delta")
    .map((p) => p.text)
    .join("");
}
