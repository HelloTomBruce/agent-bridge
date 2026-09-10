import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveOnPath, detectAgents, AGENTS, DEFAULT_MODEL } from "../src/detect.js";

/**
 * Windows only executes files whose extension is listed in PATHEXT, and
 * `resolveOnPath` honours that. An extension-less fixture is therefore
 * unfindable there — which is correct behaviour, not a bug — so the fake
 * binaries carry `.cmd`, matching how npm actually installs agent CLIs on
 * Windows. This keeps the PATHEXT branch genuinely covered instead of skipped.
 */
const BIN_EXT = process.platform === "win32" ? ".cmd" : "";

/**
 * Compare two paths the way the host filesystem would.
 *
 * `resolveOnPath` returns the string it probed — `bin + ext` taken from
 * PATHEXT, which Windows reports uppercase (`.CMD`). The fixture on disk is
 * `.cmd`, and NTFS matches it case-insensitively, so the two agree as paths
 * while differing as strings. Comparing raw strings would fail on Windows for
 * a purely cosmetic reason.
 */
const expectSamePath = (actual: string | null, expected: string): void => {
  expect(actual).not.toBeNull();
  const norm = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v);
  expect(norm(actual!)).toBe(norm(expected));
};

let dir: string;
let oldPath: string | undefined;
/**
 * Saved `*_BIN` overrides, restored in afterAll.
 *
 * Detection reads `process.env[def.envOverride]` before scanning PATH, so a
 * developer who has e.g. `QWEN_BIN` exported sees "qwen is available" and the
 * missing-agent assertion fails on their machine but not in CI. Clearing every
 * override up front makes these tests depend only on the temp PATH.
 */
const oldEnvOverrides: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-bridge-test-"));
  const fakeBin = join(dir, `claude${BIN_EXT}`);
  writeFileSync(fakeBin, "#!/bin/sh\necho fake\n");
  chmodSync(fakeBin, 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = dir;
  for (const a of AGENTS) {
    if (!a.envOverride) continue;
    oldEnvOverrides[a.envOverride] = process.env[a.envOverride];
    delete process.env[a.envOverride];
  }
  // Pin the toolchain dirs away from the real machine so detection is
  // deterministic: set VP_HOME to the temp dir (its <VP_HOME>/bin is probed).
  process.env.VP_HOME = dir;
});

afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.VP_HOME;
  for (const [key, value] of Object.entries(oldEnvOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveOnPath", () => {
  it("finds an executable on PATH", () => {
    expectSamePath(resolveOnPath("claude"), join(dir, `claude${BIN_EXT}`));
  });

  it("returns null for a missing binary", () => {
    expect(resolveOnPath("definitely-not-installed-xyz")).toBeNull();
  });

  it("dedupes overlapping PATH entries", () => {
    process.env.PATH = [dir, dir, dir].join(delimiter);
    expectSamePath(resolveOnPath("claude"), join(dir, `claude${BIN_EXT}`));
  });
});

describe("detectAgents", () => {
  it("marks a detected binary available with resolved path", () => {
    const claude = detectAgents().find((a) => a.id === "claude");
    expect(claude?.available).toBe(true);
    expect(claude?.resolvedBin).toBe("claude");
  });

  it("honors env overrides over the PATH scan", () => {
    const other = join(dir, `other-claude${BIN_EXT}`);
    writeFileSync(other, "#!/bin/sh\necho other\n");
    chmodSync(other, 0o755);
    process.env.CLAUDE_BIN = other;
    try {
      const claude = detectAgents().find((a) => a.id === "claude");
      expect(claude?.available).toBe(true);
      expectSamePath(claude?.path ?? null, other);
    } finally {
      delete process.env.CLAUDE_BIN;
    }
  });

  it("marks acp agents unsupported but detected when installed", () => {
    const hermesBin = join(dir, `hermes${BIN_EXT}`);
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
