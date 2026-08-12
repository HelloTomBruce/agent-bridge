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

协议抽象：`stdin` / `argv` / `argv-message` / `acp` / `pi-rpc`（后两者仅检测、未实现调用，调用会抛 `UnsupportedAgentProtocolError`）。

内置 21 个 agent：claude、openclaw、codex、cursor-agent、gemini、copilot、bob、opencode、qwen、qoder、codewhale、deepseek-tui、aider，及 ACP 家族（hermes/kimi/devin/kiro/kilo/vibe）与 pi（pi-rpc）。

## 安装

```bash
pnpm add agent-bridge   # 或 npm / yarn
```

要求 Node ≥ 18（使用 Web `ReadableStream`）。

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
    case "start":  console.log(`spawn ${value.bin}`, value.argv); break;
    case "delta":  appendHtml(value.text); break;
    case "html":   replaceHtml(value.text); break;   // Write 工具救回的完整 HTML
    case "meta":   console.log(value.key, value.value); break; // usage/cost/model
    case "stderr": console.error(value.text); break;
    case "error":  console.error(value.message); break;
    case "done":   console.log("exit", value.code); break;
  }
}
```

## 事件流（InvokeEvent）

```
start  →  delta* / html* / meta* / stderr*  →  done(code)
        └── error(message)  （任意阶段失败，随后关闭）
```

- `delta`：增量文本，追加渲染
- `html`：从 `Write`/`create_file` 工具调用中救回的**权威完整 HTML**，应**替换**而非追加
- `meta`：usage、cost_usd、duration_ms、model、session、thinking 等
- 错误（未知 agent、bin 不存在、override 路径错误、spawn 失败）都走 `error` 事件，**不抛异常**
- `signal` 中止 → SIGTERM 杀子进程，流关闭（无 `done`）

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
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run（36 用例：parse 各 agent 协议 / PATH 检测 / 假子进程事件流）
pnpm build       # tsc → dist/（ESM + .d.ts）
```

## 路线（规划中）

- [ ] 插件协议（manifest + 管道钩子）：让宿主在「输入解析 / prompt 组装 / 流事件 / 产物后处理 / 导出」各扩展点接入插件
- [ ] skill 目录作为"声明式插件"的适配层
- [ ] `resolveBinForAgent` 支持 `agentRegistry` 注入（宿主可扩展第三方 agent 定义）

## License

MIT
