import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOnPath, detectAgents, AGENTS, DEFAULT_MODEL } from "../src/detect.js";

let dir: string;
let oldPath: string | undefined;
let oldEnvOverrides: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-bridge-test-"));
  const fakeBin = join(dir, "claude");
  writeFileSync(fakeBin, "#!/bin/sh\necho fake\n");
  chmodSync(fakeBin, 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = dir;
  // Pin the toolchain dirs away from the real machine so detection is
  // deterministic: set VP_HOME to the temp dir (its <VP_HOME>/bin is probed).
  process.env.VP_HOME = dir;
});

afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.VP_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveOnPath", () => {
  it("finds an executable on PATH", () => {
    expect(resolveOnPath("claude")).toBe(join(dir, "claude"));
  });

  it("returns null for a missing binary", () => {
    expect(resolveOnPath("definitely-not-installed-xyz")).toBeNull();
  });

  it("dedupes overlapping PATH entries", () => {
    process.env.PATH = dir + ":" + dir + ":" + dir;
    expect(resolveOnPath("claude")).toBe(join(dir, "claude"));
  });
});

describe("detectAgents", () => {
  it("marks a detected binary available with resolved path", () => {
    const claude = detectAgents().find((a) => a.id === "claude");
    expect(claude?.available).toBe(true);
    expect(claude?.resolvedBin).toBe("claude");
  });

  it("honors env overrides over the PATH scan", () => {
    const other = join(dir, "other-claude");
    writeFileSync(other, "#!/bin/sh\necho other\n");
    chmodSync(other, 0o755);
    process.env.CLAUDE_BIN = other;
    try {
      const claude = detectAgents().find((a) => a.id === "claude");
      expect(claude?.available).toBe(true);
      expect(claude?.path).toBe(other);
    } finally {
      delete process.env.CLAUDE_BIN;
    }
  });

  it("marks acp / pi-rpc agents unsupported but detected when installed", () => {
    const hermesBin = join(dir, "hermes");
    writeFileSync(hermesBin, "#!/bin/sh\necho hi\n");
    chmodSync(hermesBin, 0o755);
    try {
      const hermes = detectAgents().find((a) => a.id === "hermes");
      expect(hermes?.available).toBe(true);
      expect(hermes?.unsupported).toBe(true);
      expect(hermes?.protocol).toBe("acp");
    } finally {
      // no cleanup needed; temp dir removed in afterAll
    }
  });

  it("returns available:false without throwing for missing agents", () => {
    const qwen = detectAgents().find((a) => a.id === "qwen");
    expect(qwen?.available).toBe(false);
  });

  it("exposes curated models starting with DEFAULT_MODEL", () => {
    const codex = AGENTS.find((a) => a.id === "codex");
    expect(codex?.fallbackModels[0]).toEqual(DEFAULT_MODEL);
    expect(codex?.fallbackModels.length).toBeGreaterThan(1);
  });
});
