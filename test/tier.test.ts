import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/detect.js";
import { detectAgents } from "../src/detect.js";

/**
 * `tier` is this library's central trust claim: it tells consumers which
 * adapters were checked against real CLI output and which are guesswork. A
 * claim nobody can audit decays into marketing, so the allow-list below is
 * asserted mechanically — adding `tier: "supported"` without landing parse
 * fixtures turns CI red instead of quietly shipping.
 *
 * Entry criteria for this list are documented in docs/TIER.md.
 */
const SUPPORTED_WITH_FIXTURES = ["claude", "codex", "copilot", "opencode", "pi"];

describe("tier claims are auditable", () => {
  it("every agent declared `supported` has parse-test fixtures", () => {
    const declared = AGENTS.filter((a) => a.tier === "supported")
      .map((a) => a.id)
      .sort();
    expect(declared).toEqual([...SUPPORTED_WITH_FIXTURES].sort());
  });

  it("detect-only agents are never invocable, whatever tier they declare", () => {
    for (const a of detectAgents()) {
      if (a.protocol === "acp") {
        expect(a.tier).toBe("detect-only");
        expect(a.unsupported).toBe(true);
      }
    }
  });

  it("every agent resolves to exactly one of the three tiers", () => {
    const valid = new Set(["supported", "experimental", "detect-only"]);
    for (const a of detectAgents()) expect(valid.has(a.tier)).toBe(true);
  });
});
