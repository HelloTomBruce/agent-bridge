# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — unreleased

Focus of this release: make the bridge trustworthy enough to `import` into a
server. 0.1.x registered 20 agents but leaked processes and could not report why
a run stopped; breadth ran ahead of depth. This trades some breadth for
correctness.

### Fixed

- **Flaky process-group test.** `abort kills the whole process group` emitted
  its readiness delta before forking the grandchild, so `abort()` could land in
  the gap — failing when the fork raced the signal, and passing for the wrong
  reason when nothing had spawned yet. The fork now precedes the delta, so
  "saw a delta" actually means "the grandchild is running". Surfaced by a
  one-in-nine CI job; verified by re-running the job and by 5 consecutive
  local runs, plus a sabotage check confirming the test still fails when
  teardown is reduced to the direct child.
- **`detect` tests failed on Windows.** The fixtures were extension-less files,
  but Windows only executes what PATHEXT lists and `resolveOnPath` honours
  that — so the lookup correctly found nothing and four assertions failed. The
  fakes now carry `.cmd` (matching how npm installs agent CLIs on Windows), the
  duplicate-PATH test uses `path.delimiter` instead of a hardcoded `:`, and
  path comparisons are case-insensitive there, since PATHEXT yields `.CMD`
  while the file on disk is `.cmd`. Caught by the first real CI run; the suite
  had never executed on Windows before.
- **`detect` tests failed on machines with a `*_BIN` override exported.**
  `oldEnvOverrides` was declared but never populated — the isolation the author
  started was never finished. Detection reads `process.env[def.envOverride]`
  before scanning PATH, so a developer with `QWEN_BIN` set saw "qwen is
  available" and the missing-agent assertion failed locally while CI stayed
  green. All overrides are now cleared in `beforeAll` and restored in
  `afterAll`. Verified against six agents' override vars.
- **copilot emitted every reply twice.** The adapter pushed `response` and
  `text` as separate deltas, but some builds send both fields carrying the
  identical payload, so the whole message was duplicated. It now prefers
  `response` and falls back to `text`.
- **Process leak when `toSseStream` is given an already-aborted signal** (P0).
  The pre-abort branch closed its own output and returned *before* calling
  `getReader()`, so the upstream `invokeAgent` stream was never cancelled and
  the spawned agent ran to completion. This reintroduced, through the signal
  path, the exact leak that `cancel()` was added to fix. It now cancels the
  upstream stream directly. Abort listeners are also detached when the stream
  finishes, so a long-lived request-scoped controller no longer accumulates one
  listener per run.
- **Process leak on stream cancel** (P0). `cancel()` was an empty function while
  the docs promised the child would be killed. Since `toSseStream` forwards
  cancellation, every disconnected SSE client left an agent process running to
  completion — the most common path in practice.
- **Orphaned process trees on abort** (P0). Teardown sent `SIGTERM` to the direct
  child only. Agent CLIs are usually npm shims (`#!/bin/sh` → `exec node …`), so
  the real agent survived. The child is now a process-group leader
  (`detached: true`) and the whole group is signalled.
- **Agents that trap `SIGTERM`** now get `SIGKILL` after `SIGKILL_GRACE_MS`.
- **Abort between bin resolution and listener registration** was silently
  dropped, leaving an orphan for the full run.
- Timers no longer keep the event loop alive; abort listeners are detached on
  exit rather than accumulating on long-lived signals.

### Added

- `timeoutMs` on `InvokeOpts` — wall-clock budget. Guards against agents that
  block forever waiting on interactive input (a missing `--yes`-style flag).
- `MAX_STDOUT_BUFFER_BYTES` (16 MB) cap on unparsable buffered stdout and on
  relayed stderr, so runaway output cannot OOM the host.
- `AgentTier` (`supported` / `experimental` / `detect-only`), exposed on
  `DetectedAgent.tier`. 7 adapters are verified; 7 are best-effort; 6 are
  detect-only. Pickers can now tier their UI instead of finding out at runtime.
- **`cursor-agent` and `gemini` downgraded from `supported` to `experimental`.**
  Both share claude's `stream_event` parse branch, and sharing a branch was
  mistaken for having verified it — neither has ever been checked against real
  CLI output. `supported` is now 5 agents (claude / codex / copilot / opencode /
  pi), all with fixtures. Entry criteria live in `docs/TIER.md` and are enforced
  by `test/tier.test.ts`, so declaring `supported` without landing fixtures
  fails CI rather than shipping quietly.
- **`code` on the `error` event** (`InvokeErrorCode`). Ten stable identifiers
  covering every failure path: `UNKNOWN_AGENT`, `AGENT_NOT_INSTALLED`,
  `BIN_OVERRIDE_MISSING`, `UNSUPPORTED_PROTOCOL`, `SPAWN_FAILED`, `TIMEOUT`,
  `OUTPUT_OVERFLOW`, `PARSE_FAILED`, `EMPTY_RESPONSE`, `ARGV_BUILD_FAILED`.
  Previously every failure arrived as free-form prose in `message`, so a
  consumer wanting to distinguish "not installed" (show an install link) from
  "bad custom path" (open the setting) had to substring-match error text that
  changes whenever the wording is edited.
- Release workflow (`npm publish --provenance` on `v*` tags) that refuses to
  publish when the tag and `package.json` version disagree.
- Smoke canaries for `experimental` adapters, so refactoring the shared parse
  branches cannot silently break an agent that nobody runs locally.
- Stricter compiler checks, no new dependency: `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride`,
  `noImplicitReturns`. The first of these is what surfaced the dead
  `oldEnvOverrides` binding above. A linter was considered and rejected: the
  codebase is single-author with no tab/trailing-space/indent drift, so a
  formatter would mostly have reflowed comments and flagged the six
  deliberately-empty `catch {}` cleanup blocks.
- `.editorconfig` pinning indentation, line endings and final newline, so the
  existing consistency survives contact with other editors.
- `typecheck` now covers `test/` as well as `src/`. It previously only included
  `src`, which is how `test/server.test.ts` kept constructing removed `done` /
  `html` events without CI failing.
- **跨平台进程生命周期测试。** 以前假 agent 用 `#!/bin/sh`，Windows 不可执行，
  因此 `taskkill /T` 这条销毁路径在 CI 中全 skip。现在用 Node 脚本 + 平台对
  应的 shim（Windows `.cmd`，其余 `sh`），三平台都真跑。唯一 POSIX-only 的是
  SIGTERM→SIGKILL 升级用例：Windows 上 `taskkill /F` 无条件强杀，没有可捕获
  的 SIGTERM 可言。
- **`.pnpm-store/` 被误提交。** 上一次提交把本地 pnpm 缓存一并带了进去。
  那是机器本地的二进制缓存，各机内容不同，留在版本库里只会制造无意义 diff。
  已从索引移除并加入 `.gitignore`。
- **`pi` is now invocable** (`supported`). It was tagged `protocol: "pi-rpc"`
  and refused at `buildArgv`, which was a misreading: `pi -p --mode json`
  (verified on pi 0.85.1) is plain ndjson over stdout with the prompt as a
  positional arg. Parses text deltas, `write` tool calls into `file_write`,
  `provider/model`, `stopReason`, and normalises pi's nested
  `usage.cost.total` into the shared `cost_usd` shape. Thinking deltas are
  dropped rather than mixed into output.
  - Also corrected its vendor: `@earendil-works/pi-coding-agent`, not Inflection.
  - Its hardcoded model list (`anthropic/claude-sonnet-4-5`, `openai/gpt-5`, …)
    was fabricated — pi resolves models via its own catalog, so only
    `DEFAULT_MODEL` is offered now.

### Changed

- **Model picker lists trimmed from 55 entries to 28.** Pinned point releases
  (`gpt-5.4-mini`, `claude-opus-4-7`, `sonnet-4-thinking`, …) were removed and
  only stable aliases (`sonnet`, `auto`) and unversioned ids (`gpt-5`) kept;
  detect-only agents no longer carry lists at all. A stale list is worse than a
  short one — it renders a dropdown of models the CLI will reject, which reads
  as the library being broken. `model` is passed through verbatim, so the list
  was never a whitelist. Policy recorded in `docs/TIER.md`.
- `engines.node` raised to `>=20`. Node 18 is EOL and was never in the CI
  matrix; claiming it was unsupported-in-practice. `packageManager` is pinned
  so CI and local installs cannot drift onto different pnpm majors.
- Package metadata added (`repository`, `bugs`, `homepage`, `publishConfig`,
  `sideEffects: false`).

### Changed (breaking)

- **`"pi-rpc"` removed from `AgentProtocol`.** No agent used it once `pi` moved
  to `argv`, and `detectAgents` no longer tests for it. Keeping a member that
  nothing can produce only invites dead branches in consumer switches.
- **`done` → `end`.** `{ type: "done", code }` is replaced by
  `{ type: "end", status, code }` where status is
  `"ok" | "aborted" | "timeout" | "failed"`. A bare `done` could not distinguish
  a completed run from a killed one. Exactly one `end` is now emitted on every
  path — including spawn failure and unknown-agent errors, which previously
  closed the stream with no terminal event at all.
  - `status: "ok"` means *ran to completion*, not *succeeded*: check `code`.
- **`html` → `file_write`.** `{ type: "html", text }` becomes
  `{ type: "file_write", path, text }`, and the bridge no longer filters writes
  by extension — deciding that only `.html` matters is application policy, not
  protocol. Consumers filter on `path` themselves.
  - Multi-file turns previously concatenated all writes into one blob; each
    write is now reported separately.
- `AgentParse`'s `html` kind likewise becomes `file_write` with a `path`.

### Migration

```ts
// before
case "done":  finish(ev.code); break;
case "html":  setHtml(ev.text); break;

// after
case "end":
  if (ev.status === "ok") finish(ev.code);
  else showStopped(ev.status);            // "aborted" | "timeout" | "failed"
  break;
case "file_write":
  if (/\.html?$/i.test(ev.path)) setHtml(ev.text);
  break;
```

## [0.1.2]

- Rescue `Write`-tool HTML for opencode.
- Add the `agent-bridge/server` subpath export (`toSseStream`).

## [0.1.0]

- Initial extraction from `html-anything`'s `lib/agents/`: `detect` / `invoke` /
  `parse` over 20 registered agent CLIs.
