# agent-bridge

本地 coding-agent CLI 的统一桥接层：**检测（detect）→ 调用（invoke）→ 协议解析（parse）**。
零 API key，复用本机已登录的 CLI 会话（claude login、cursor login、gemini auth …）。

从 [html-anything](https://github.com/nexu-io/html-anything) 的 `lib/agents/` 抽出的独立包，API 形状与源码保持一致。

## 能力

| 模块 | 导出 | 说明 |
|---|---|---|
| detect | `detectAgents()`、`AGENTS`、`resolveOnPath()` | PATH + 常用工具链目录 + 环境变量覆盖（`CLAUDE_BIN` 等）检测已安装 agent |
| invoke | `invokeAgent(opts)` → `ReadableStream<InvokeEvent>` | 以统一事件流调用任意已注册 agent，可中止（AbortSignal） |
| parse | `makeParser()`、`parseLine()`、`extractTextFromLine()` | 按 agent 协议解析 stdout（stream-json / ndjson / 纯文本），含 HTML rescue 与文本去重 |

协议抽象：`stdin` / `argv` / `argv-message` / `acp`（`acp` 家族仅检测、未实现调用，调用会抛 `UnsupportedAgentProtocolError`）。

### 支持的 agent（注册表共 20 个，分三档）

档位通过 `DetectedAgent.tier` 暴露，便于 picker 分组展示——不必等到运行时才发现差异。

| 档位 | 数量 | agent | 含义 |
|---|---|---|---|
| `supported` | 5 | claude、codex、copilot、opencode、pi | 输出协议已对照真实 CLI 验证，解析有 fixture 覆盖 |
| `experimental` | 9 | cursor-agent、gemini、openclaw、bob、qwen、qoder、codewhale、deepseek-tui、aider | 调用已接通，解析尽力而为；上游 CLI 改输出格式时可能失效 |
| `detect-only` | 6 | hermes、kimi、devin、kiro、kilo、vibe | **不可调用**。仅用于检测以给出安装提示，`invokeAgent` 会返回明确错误（ACP 协议未实现） |

也就是说：**14 个可调用，其中 5 个经过验证。** 之所以把这件事讲清楚，是因为"支持 20 个 agent"
这种说法会让人把 experimental 当 supported 用，出问题时消耗的是对整个库的信任。

准入条件与当前依据见 [docs/TIER.md](docs/TIER.md)，并由 `test/tier.test.ts` 机器校验——
把 agent 标成 `supported` 却不补 fixture 会直接让 CI 变红。

> **cursor-agent 与 gemini 已从 `supported` 下调为 `experimental`**：它们与 claude
> 共用 `stream_event` 解析分支，形状看起来同构，但从未在真实抓包上核对过。
> 共用分支不等于验证过——claude 的 fixture 只能证明 claude。

> `pi` 指 [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)，
> 不是 Inflection 的消费级 Pi。它此前被标为 `pi-rpc` / 不可调用，实测（pi 0.85.1）
> `pi -p --mode json` 就是标准 ndjson 输出，无需 RPC 模式——已按 `argv` 协议接入。
> 模型列表只提供 DEFAULT_MODEL：pi 的可用模型来自它自己的 provider catalog
> （`pi --list-models`），随安装与授权而变，硬编码只会是猜测。

## 安装

```bash
pnpm add agent-bridge   # 或 npm / yarn
```

要求 Node ≥ 20（Node 18 已 EOL，未纳入 CI 测试矩阵，故不声称支持）。

## 浏览器 playground

```bash
npm run build          # 需要 dist/
node examples/server.mjs
# → http://localhost:8787
```

零依赖本地服务（`node:http`）+ 单文件页面，把事件流做成可点击验证：

| 内置场景 | 验证点 |
|---|---|
| 正常完成 | `end{status:"ok", code:0}` |
| 取消运行 | `end{status:"aborted"}`，且 agent 进程组被真实杀掉 |
| 超时 | `timeoutMs=3000` → `error` + `end{status:"timeout"}` |
| file_write | 同一轮写入 `.html` 与 `.md`，两者都带 `path` 上报 |

左栏按 `tier` 分档列出本机 agent（`detect-only` 不进下拉框——它不可调用）。
右侧实时显示事件流、文本输出与捕获到的文件写入，顶栏显示 model / token / cost / exit。

**关掉标签页即可验证 0.1.x 的 P0 泄漏已修复**：服务端 `res.on("close")` → `abort` →
进程组终止。旧版本里 `cancel()` 是空实现，agent 会继续跑到结束。

## 事件协议

`invokeAgent` 产出的事件流有两条硬约束：

1. **恰好一个终态事件**。每次调用一定以 `{ type: "end", status, code }` 结束——包括
   spawn 失败、未知 agent、超时、被 abort 这些路径。消费者只需要一条收尾分支。
2. **`status` 区分停止原因**：`"ok"`（跑完，成败看 `code`）/ `"aborted"` / `"timeout"` /
   `"failed"`（没能真正启动）。
3. **`error` 事件带机器可判别的 `code`**。`message` 是给人看的、会改写；`code` 才是契约。

```ts
type InvokeEvent =
  | { type: "start"; bin: string; argv: string[]; promptBytes: number }
  | { type: "delta"; text: string }                        // 增量文本
  | { type: "file_write"; path: string; text: string }      // 从写文件工具调用中恢复的产物
  | { type: "meta"; key: string; value: unknown }           // model / session / usage / cost_usd …
  | { type: "stderr"; text: string }
  | { type: "raw"; text: string }
  | { type: "end"; status: "ok" | "aborted" | "timeout" | "failed"; code: number | null }
  | { type: "error"; code: InvokeErrorCode; message: string };
```

### 错误码（`InvokeErrorCode`）

按 `code` 分流，不要去 match `message` 文案——后者随时会改。

| code | 含义 | 典型处置 |
|---|---|---|
| `UNKNOWN_AGENT` | agent id 不在注册表 | 检查调用方拼写 |
| `AGENT_NOT_INSTALLED` | 注册了但 PATH 上找不到 | 给安装引导链接 |
| `BIN_OVERRIDE_MISSING` | 用户指定的路径不存在 | 跳转到自定义路径设置 |
| `UNSUPPORTED_PROTOCOL` | detect-only（ACP 家族） | 引导改用 supported agent |
| `SPAWN_FAILED` | 进程起不来（EACCES 等） | 显示权限/环境问题 |
| `TIMEOUT` | 超过 `timeoutMs` | 提示重试或调大预算 |
| `OUTPUT_OVERFLOW` | 输出超过 16 MB 且无法解析 | 视为 agent 异常 |
| `PARSE_FAILED` | 输出不符合其声称的协议 | 多为上游改版，报 issue |
| `EMPTY_RESPONSE` | 跑完但没有任何内容 | 提示重试 |
| `ARGV_BUILD_FAILED` | argv 组装期未归类异常 | 兜底 |

```ts
case "error":
  if (ev.code === "AGENT_NOT_INSTALLED") showInstallHint(agentId);
  else if (ev.code === "BIN_OVERRIDE_MISSING") openPathSetting();
  else showError(ev.message);
  break;
```

关于 `file_write`：agent 经常无视"把文档直接流式输出"的指令，转而调用 `Write` 工具写进文件，
只在正文里留一句"已保存至 out.html"。这个事件把工具入参里的真实内容捞回来。**桥接层不按扩展名
过滤**——"只有 `.html` 有意义"是应用策略而非协议，请消费者自己按 `path` 判断。语义是
**替换**（同一 path 的权威内容），不是追加。

## 进程生命周期

`invokeAgent` 返回的 `ReadableStream` 是**可 abort / 可 cancel** 的：

- 传 `AbortSignal` → 子进程整个进程组被 `SIGTERM` 终止，`SIGKILL_GRACE_MS`（3 秒）后仍不退则 `SIGKILL`。
- 下游 `reader.cancel()` → 同上（这是 SSE 客户端断开后的常见路径，`toSseStream` 会传播 cancel）。
- 终止作用范围是整个**进程组**（`detached: true`），而非仅直接子进程——因为 agent CLI 通常通过 npm shim 间接启动，只杀 shim 会留下真实 agent 进程。
- 传 `timeoutMs` → 到期后终止进程树并发 `{ status: "timeout" }`。用于兜住「agent 等交互输入永久挂住」（漏了某个 `--yes` 类 flag 就会这样）。
- stdout 累积超过 `MAX_STDOUT_BUFFER_BYTES`（16 MB）且始终没有换行时中止，避免失控输出打爆宿主内存；转发的 stderr 同样限额。
- 陷阱：`detached` 使得子进程不再继承父进程的 Ctrl+C 处理。CLI 消费者应自行将 `SIGINT` 绑定到 `AbortController`：

  ```ts
  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  ```

## 用法

```ts
import { detectAgents, invokeAgent } from "agent-bridge";

// 1. 检测本机有哪些 agent 可用
const agents = detectAgents();
const available = agents.filter((a) => a.available);

// 2. 调用（事件流，非阻塞）
const stream = invokeAgent({
  agent: "claude",          // 或 codex / gemini / opencode ...
  prompt: "生成一个单文件 HTML 登录页",
  model: "sonnet",          // 可选；省略 = 用 CLI 自身配置
  // binOverride: "/path/to/claude",  // 可选：手动指定 bin 路径
});

const reader = stream.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  switch (value.type) {
    case "start":      console.log(`spawn ${value.bin}`, value.argv); break;
    case "delta":      appendText(value.text); break;
    case "file_write": html = value.text; break;     // Write 工具救回的完整内容：替换，不是追加
    case "meta":       console.log(value.key, value.value); break; // usage/cost/model/session
    case "stderr":     console.error(value.text); break;
    case "error":      console.error(value.message); break;
    case "end":        console.log(value.status, value.code); break; // ok/aborted/timeout/failed
  }
}
```

## 与 html-anything 的替换步骤

已实测完成：三个 API 路由（agents / convert / draft）改用本包，本地 `lib/agents` 源码已删除。

```bash
# 1. 在 agent-bridge 里产出 tarball（发布前本地引入的标准方式）
pnpm pack   # → agent-bridge-0.1.0.tgz

# 2. 在宿主项目安装（file: 协议 = 真实解包，与 npm 发布后形态一致）
pnpm add file:../../agent-bridge/agent-bridge-0.1.0.tgz

# 3. 替换 import
#    from "@/lib/agents/invoke"  →  from "agent-bridge"
#    from "@/lib/agents/detect"  →  from "agent-bridge"

# 4. 验证
pnpm typecheck && pnpm test && pnpm build
```

> ⚠️ **不要用 `pnpm link:` 协议**：Turbopack（Next 16）无法解析指向仓库外的
> `link:` symlink（`Module not found: Can't resolve`）。tarball 安装（标准
> `.pnpm` store 布局）无此问题，且更接近真实 npm 安装。
> 发布到 npm 后，把依赖改为 `"agent-bridge": "^0.1.0"` 即可。

> 导出名与源码完全一致（`AGENTS`、`DEFAULT_MODEL`、`detectAgents`、`resolveOnPath`、
> `resolveOpenclawAgentId`、`buildArgv`、`envFor`、`makeParser`、`parseLine`、
> `extractTextFromLine`、`invokeAgent`、`resolveBinForAgent`、`UnsupportedAgentProtocolError`），
> 切换是纯 import 路径替换，无逻辑改动。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit（含 test/；开启 noUnusedLocals 等严格检查）
pnpm test        # vitest run（84 用例：协议解析 / tier 审计 / 错误码 / 真子进程生命周期）
pnpm build       # tsc → dist/（ESM + .d.ts）
```

> 生命周期测试使用 POSIX `sh` 假 agent，**Windows 上会 skip**——那里的销毁走
> `taskkill /T`，是另一条代码路径，目前无覆盖。这是已知缺口，不是"已通过"。

## 发布

打 tag 即触发 `.github/workflows/release.yml`：跑完整门禁 → 校验 tag 与
`package.json` 版本一致 → `npm publish --provenance`。版本不一致会直接失败，
避免 `v0.3.0` 悄悄发出 0.2.0（npm 版本不可变，发错无法撤回）。

```bash
# 版本号先改 package.json + CHANGELOG，再打 tag
git tag v0.2.0 && git push origin v0.2.0
```

## 路线（规划中）

- [ ] 插件协议（manifest + 管道钩子）：让宿主在「输入解析 / prompt 组装 / 流事件 / 产物后处理 / 导出」各扩展点接入插件
- [ ] skill 目录作为"声明式插件"的适配层
- [ ] `resolveBinForAgent` 支持 `agentRegistry` 注入（宿主可扩展第三方 agent 定义）

## License

MIT
