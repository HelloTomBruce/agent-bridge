import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { delimiter, join } from "node:path";

/**
 * Per-agent invocation protocol. Determines what `invokeAgent` does with the
 * prompt and how it parses output:
 *   - "stdin"        : pipe prompt → child stdin, parse stdout via parseLine
 *   - "argv"         : pass prompt as positional argv (deepseek-tui), parse stdout as plain
 *   - "argv-message" : prompt goes via `--message <text>` (openclaw); stdout is
 *                      a single multi-line JSON document (not ndjson), parsed
 *                      after the child closes.
 *   - "acp"          : ACP JSON-RPC over stdio (hermes/kimi/devin/kiro/kilo/vibe).
 *                      Not implemented — surfaced in detection so the user sees
 *                      install instructions, but invoke emits a clear error
 *                      pointing them to a supported agent.
 */
export type AgentProtocol = "stdin" | "argv" | "argv-message" | "acp";

/**
 * Support tier. Encodes how much verification an adapter has actually had, so
 * consumers can decide what to expose in a picker rather than discovering the
 * difference at runtime.
 *
 *  - "supported"    : output protocol verified against real CLI output;
 *                     text/usage/file-write parsing exercised by tests.
 *  - "experimental" : invocation wired up, parsing best-effort. May break when
 *                     the upstream CLI changes its output format.
 *  - "detect-only"  : detected for install hints, but `invokeAgent` rejects it
 *                     (protocol not implemented — see AgentProtocol).
 *
 * Kept separate from `protocol`: protocol says HOW to talk, tier says how much
 * to trust it.
 */
export type AgentTier = "supported" | "experimental" | "detect-only";

export type ModelOption = { id: string; label: string };

/** Synthetic "let the CLI pick" entry — agent runs without `--model`. */
export const DEFAULT_MODEL: ModelOption = { id: "default", label: "Default (CLI config)" };

export type AgentDef = {
  id: string;
  label: string;
  bin: string;
  fallbackBins?: string[];
  envOverride?: string;
  vendor: string;
  /** Defaults to "stdin" when omitted. */
  protocol?: AgentProtocol;
  /** Defaults to "experimental" when omitted — opt in to "supported" explicitly. */
  tier?: AgentTier;
  /**
   * Curated, evidence-based model list shown in pickers. Always begins with
   * `DEFAULT_MODEL` (= no `--model` flag → user's CLI config wins).
   */
  fallbackModels: ModelOption[];
};

export const AGENTS: AgentDef[] = [
  // Drop-in fork list (`fallbackBins`) covers CLIs that ship under a different
  // binary name but speak the exact same argv protocol. Today: openclaude is
  // listed as a fallback for Claude Code; OpenClaw is exposed as its own
  // first-class entry below so users on machines that have both can pick.
  {
    id: "claude",
    tier: "supported",
    label: "Claude Code",
    bin: "claude",
    fallbackBins: ["openclaude"],
    envOverride: "CLAUDE_BIN",
    vendor: "Anthropic",
    fallbackModels: [
      DEFAULT_MODEL,
      // Aliases only: the CLI resolves these to whatever is current, so they
      // do not rot the way pinned ids (claude-opus-4-7, …) did.
      { id: "sonnet", label: "Sonnet (alias)" },
      { id: "opus", label: "Opus (alias)" },
      { id: "haiku", label: "Haiku (alias)" },
    ],
  },
  {
    // OpenClaw is a multi-channel agent gateway, not a Claude-CLI fork —
    // its CLI surface is `openclaw agent --message <text>` and it returns a
    // single multi-line JSON blob (no streaming). The "argv-message"
    // protocol covers the prompt-via-flag and post-close JSON parse.
    id: "openclaw",
    label: "OpenClaw",
    bin: "openclaw",
    envOverride: "OPENCLAW_BIN",
    vendor: "OpenClaw multi-channel agent gateway",
    protocol: "argv-message",
    fallbackModels: [
      DEFAULT_MODEL,
      // OpenRouter ids carry upstream point versions and rot quickly; pass
      // `model` explicitly, e.g. "openrouter/anthropic/claude-sonnet-4.6".
    ],
  },
  {
    id: "codex",
    tier: "supported",
    label: "OpenAI Codex",
    bin: "codex",
    envOverride: "CODEX_BIN",
    vendor: "OpenAI",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "gpt-5", label: "gpt-5" },
      { id: "gpt-5-codex", label: "gpt-5-codex" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
  },
  {
    id: "cursor-agent",
    // Shares claude's stream_event shape (see parseLineWithState), but that
    // was inferred, not confirmed against a real capture — so it stays
    // experimental. Promotion criteria: docs/TIER.md.
    tier: "experimental",
    label: "Cursor Agent",
    bin: "cursor-agent",
    envOverride: "CURSOR_AGENT_BIN",
    vendor: "Cursor",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "auto", label: "auto" },
      { id: "gpt-5", label: "gpt-5" },
    ],
  },
  {
    id: "gemini",
    // Same branch as cursor-agent, same reason for staying experimental.
    tier: "experimental",
    label: "Gemini CLI",
    bin: "gemini",
    envOverride: "GEMINI_BIN",
    vendor: "Google",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    ],
  },
  {
    id: "copilot",
    tier: "supported",
    label: "GitHub Copilot CLI",
    bin: "copilot",
    envOverride: "COPILOT_BIN",
    vendor: "GitHub",
    fallbackModels: [
      DEFAULT_MODEL,
      // Copilot rotates its backing models without stable aliases, so only
      // DEFAULT_MODEL is offered; pass `model` explicitly to override.
    ],
  },
  {
    id: "bob",
    label: "IBM Bob Shell",
    bin: "bob",
    envOverride: "BOB_BIN",
    vendor: "IBM",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "opencode",
    tier: "supported",
    label: "OpenCode",
    bin: "opencode-cli",
    fallbackBins: ["opencode"],
    envOverride: "OPENCODE_BIN",
    vendor: "Open",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { id: "openai/gpt-5", label: "openai/gpt-5" },
      { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
    ],
  },
  {
    id: "qwen",
    label: "Qwen Coder",
    bin: "qwen",
    envOverride: "QWEN_BIN",
    vendor: "Alibaba",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "qwen3-coder-plus", label: "qwen3-coder-plus" },
      { id: "qwen3-coder-flash", label: "qwen3-coder-flash" },
    ],
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    bin: "qodercli",
    envOverride: "QODER_BIN",
    vendor: "Qoder",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "lite", label: "Lite" },
      { id: "efficient", label: "Efficient" },
      { id: "auto", label: "Auto" },
      { id: "performance", label: "Performance" },
      { id: "ultimate", label: "Ultimate" },
    ],
  },
  {
    id: "codewhale",
    label: "CodeWhale",
    bin: "codewhale",
    fallbackBins: ["deepseek-tui"],
    envOverride: "CODEWHALE_BIN",
    vendor: "CodeWhale",
    protocol: "argv",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
    ],
  },
  {
    id: "deepseek-tui",
    label: "DeepSeek TUI",
    bin: "deepseek-tui",
    fallbackBins: ["codewhale"],
    envOverride: "DEEPSEEK_TUI_BIN",
    vendor: "DeepSeek",
    protocol: "argv",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
    ],
  },
  {
    id: "aider",
    label: "Aider",
    bin: "aider",
    vendor: "Aider",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
      { id: "gpt-5", label: "gpt-5" },
      { id: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat" },
    ],
  },

  // ACP family — detection-only. Models still surfaced for UI completeness.
  {
    id: "hermes",
    label: "Hermes",
    bin: "hermes",
    envOverride: "HERMES_BIN",
    vendor: "Mature",
    protocol: "acp",
    fallbackModels: [
      DEFAULT_MODEL,
      // detect-only: invokeAgent rejects it, so a model list would only be
      // decoration that still has to be maintained.
    ],
  },
  {
    id: "kimi",
    label: "Kimi CLI",
    bin: "kimi",
    envOverride: "KIMI_BIN",
    vendor: "Moonshot",
    protocol: "acp",
    fallbackModels: [
      DEFAULT_MODEL,
      // detect-only — see hermes.
    ],
  },
  {
    id: "devin",
    label: "Devin for Terminal",
    bin: "devin",
    envOverride: "DEVIN_BIN",
    vendor: "Cognition",
    protocol: "acp",
    fallbackModels: [
      DEFAULT_MODEL,
      // detect-only — see hermes.
    ],
  },
  {
    id: "kiro",
    label: "Kiro CLI",
    bin: "kiro-cli",
    envOverride: "KIRO_BIN",
    vendor: "AWS",
    protocol: "acp",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "kilo",
    label: "Kilo",
    bin: "kilo",
    envOverride: "KILO_BIN",
    vendor: "Kilo",
    protocol: "acp",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "vibe",
    label: "Mistral Vibe CLI",
    bin: "vibe-acp",
    envOverride: "VIBE_BIN",
    vendor: "Mistral",
    protocol: "acp",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    envOverride: "PI_BIN",
    // Not Inflection's consumer "Pi" — this is @earendil-works/pi-coding-agent,
    // a local coding agent with read/bash/edit/write tools. Verified against
    // pi 0.85.1: `-p --mode json` emits ndjson and takes the prompt as a
    // positional arg, so it's an ordinary `argv` agent.
    vendor: "earendil-works",
    protocol: "argv",
    tier: "supported",
    // pi resolves models through its own provider catalog (`pi --list-models`),
    // which is per-install and per-auth, so only DEFAULT_MODEL is offered.
    fallbackModels: [DEFAULT_MODEL],
  },
];

/**
 * Extra directories scanned beyond `$PATH`. GUI-launched Node processes often
 * miss the shell's PATH additions, so we probe the common per-user toolchain
 * locations directly. Win32 additionally covers Scoop shim/app dirs and the
 * standalone Node installer's %AppData%/npm.
 */
export function userToolchainDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const vp = env.VP_HOME?.trim();
  if (vp) dirs.push(join(vp, "bin"));
  const npmPrefix = env.NPM_CONFIG_PREFIX?.trim();
  if (npmPrefix) {
    // npm on Windows installs CLI shims directly in <prefix>, not <prefix>/bin.
    dirs.push(join(npmPrefix, "bin"), npmPrefix);
  }
  dirs.push(
    join(home, ".local/bin"),
    join(home, ".vite-plus/bin"),
    join(home, ".opencode/bin"),
    join(home, ".bun/bin"),
    join(home, ".volta/bin"),
    join(home, ".asdf/shims"),
    join(home, "Library/pnpm"),
    join(home, ".cargo/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".npm-packages/bin"),
    join(home, ".claude/local"),
  );
  if (process.platform === "win32") {
    // Scoop-managed Node.js drops global npm shims into the app dir directly,
    // not under a /bin/ subdirectory. Cover the common Scoop layouts plus the
    // default %AppData%/npm location used by the standalone Node installer.
    const scoopRoot = env.SCOOP?.trim() || join(home, "scoop");
    const globalScoopRoot = env.SCOOP_GLOBAL?.trim() || "C:\\ProgramData\\scoop";
    const appData = env.APPDATA?.trim();
    dirs.push(
      join(scoopRoot, "shims"),
      join(scoopRoot, "apps", "nodejs", "current"),
      join(scoopRoot, "apps", "nodejs-lts", "current"),
      join(globalScoopRoot, "shims"),
      join(globalScoopRoot, "apps", "nodejs", "current"),
    );
    if (appData) dirs.push(join(appData, "npm"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return dirs;
}

/**
 * Probe `<openclaw> agents list` and return the first agent id (typically
 * "main"). OpenClaw refuses `agent --message` invocations without one of
 * `--agent`, `--to`, or `--session-id`, so we resolve this once per-process
 * with a 5-minute TTL cache.
 *
 * Falls back to "main" on any error — that is the OpenClaw default agent
 * name on a fresh install, so it works for most users out of the box.
 */
let openclawAgentIdCache: { value: string; expiresAt: number } | null = null;
export async function resolveOpenclawAgentId(bin: string): Promise<string> {
  const now = Date.now();
  if (openclawAgentIdCache && openclawAgentIdCache.expiresAt > now) {
    return openclawAgentIdCache.value;
  }
  let resolved = "main";
  try {
    const { spawn } = await import("node:child_process");
    const out = await new Promise<string>((res, rej) => {
      const useShell = process.platform === "win32";
      const child = spawn(useShell ? `"${bin}"` : bin, ["agents", "list"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
      });
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (buf += c));
      child.on("close", () => res(buf));
      child.on("error", rej);
      setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        rej(new Error("openclaw agents list timed out"));
      }, 5_000);
    });
    // First agent line looks like:  "- main (default)"  or  "- ops"
    const m = out.match(/^- (\S+)/m);
    if (m && m[1]) resolved = m[1];
  } catch {
    // keep fallback
  }
  openclawAgentIdCache = { value: resolved, expiresAt: now + 5 * 60_000 };
  return resolved;
}

/**
 * Resolve a bare binary name against `$PATH` plus the heuristic toolchain
 * dirs. Returns the first existing absolute path, or `null`.
 */
export function resolveOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const seen = new Set<string>();
  const dirs = [
    ...(env.PATH ?? "").split(delimiter),
    ...userToolchainDirs(env),
  ].filter((d) => d && !seen.has(d) && (seen.add(d), true));
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d, bin + e);
      try {
        if (existsSync(full)) return full;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

export type DetectedAgent = {
  id: string;
  label: string;
  vendor: string;
  available: boolean;
  path?: string;
  resolvedBin?: string;
  protocol: AgentProtocol;
  /** See `AgentTier` — lets pickers separate verified adapters from the rest. */
  tier: AgentTier;
  /**
   * Curated model picker list. Sent to clients so pickers can render a
   * dropdown without a follow-up round trip.
   */
  models: ModelOption[];
  /** True when the adapter cannot be invoked yet (acp). */
  unsupported?: boolean;
};

/**
 * Detect which registered agents are actually installed, in bin-resolution
 * priority order: `$ENV_OVERRIDE` absolute path > `$PATH` scan over
 * `bin` then `fallbackBins`. Detection never throws — every entry resolves
 * to a `DetectedAgent` with `available: false` at worst.
 */
export function detectAgents(env: NodeJS.ProcessEnv = process.env): DetectedAgent[] {
  return AGENTS.map((a): DetectedAgent => {
    const protocol = a.protocol ?? "stdin";
    const unsupported = protocol === "acp";
    // A detect-only protocol always wins over any declared tier — it cannot be
    // invoked no matter how well its output is understood.
    const tier: AgentTier = unsupported ? "detect-only" : (a.tier ?? "experimental");
    const base = {
      id: a.id,
      label: a.label,
      vendor: a.vendor,
      protocol,
      tier,
      models: a.fallbackModels,
      ...(unsupported ? { unsupported: true as const } : {}),
    };
    const override = a.envOverride ? env[a.envOverride] : undefined;
    if (override && existsSync(override)) {
      return { ...base, available: true, path: override, resolvedBin: a.bin };
    }
    const candidates = [a.bin, ...(a.fallbackBins ?? [])];
    for (const c of candidates) {
      const p = resolveOnPath(c, env);
      if (p) {
        return { ...base, available: true, path: p, resolvedBin: c };
      }
    }
    return { ...base, available: false };
  });
}
