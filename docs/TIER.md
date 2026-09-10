# Agent 支持档位（tier）

`DetectedAgent.tier` 是本库对外最核心的信任声明：它告诉使用者**哪些适配器
经过真实输出核对，哪些是尽力而为的猜测**。

"支持 20 个 agent" 这种说法会让人把 experimental 当 supported 用，出问题时
消耗的是对整个库的信任。所以档位不是主观判断，而是有准入条件、且由
`test/tier.test.ts` 机器校验的。

## 三档定义

| 档位 | 含义 | `invokeAgent` |
|---|---|---|
| `supported` | 输出协议已对照**真实 CLI 输出**核对，解析有 fixture 覆盖 | 可调用 |
| `experimental` | 调用链路已接通，解析尽力而为；上游改格式可能失效 | 可调用 |
| `detect-only` | 协议未实现（ACP 家族），仅用于检测以给出安装提示 | 返回明确错误 |

`detect-only` 由 `protocol: "acp"` 推导，**优先于**任何声明的 tier——协议没实现，
输出解析得再好也不能调用。

## 升级到 `supported` 的准入条件

三条**全部**满足才能标注 `tier: "supported"`：

1. **有真实 fixture**：至少一条测试数据来自真实 CLI 输出，不是照着文档编的。
2. **覆盖三个面**：
   - 文本增量（text delta）
   - 终止信息（usage / result / stopReason，取该 agent 实际提供的）
   - `file_write` 救回（若该 agent 有写文件工具）
3. **标注来源**：fixture 附近注明 CLI 版本与抓取日期，例如
   `// 抓取自 pi 0.85.1，2026-09`。上游改版时才知道该重新核对哪些。

满足后，把 agent id 加入 `test/tier.test.ts` 的 `SUPPORTED_WITH_FIXTURES`。
**只改 `detect.ts` 而不补 fixture 会导致 CI 失败**——这是刻意设计的闸门。

## 当前状态

### `supported`（5）

| agent | fixture 依据 |
|---|---|
| claude | `stream_event` 增量、`result` usage/cost、`Write` 工具救回 |
| codex | `item.completed` / `item.delta` |
| opencode | `write` 工具 `state.input` 救回、`step_start` session |
| pi | `message_update` 增量、`turn_end` usage、嵌套 `cost.total` 归一 |
| copilot | `response` 字段，含 `response`+`text` 同时出现时的去重回归用例 |

### `experimental`（9）

`cursor-agent`、`gemini`、`openclaw`、`bob`、`qwen`、`qoder`、`codewhale`、
`deepseek-tui`、`aider`

其中 **cursor-agent / gemini 曾被标为 `supported`，已下调**：它们与 claude 共用
`stream_event` 解析分支，形状看起来同构，但从未在真实抓包上核对过。
共用分支不等于验证过——claude 的 fixture 只能证明 claude。

> 要把这两个升回 `supported`：贴一份真实的
> `cursor-agent --output-format stream-json` / `gemini` ndjson 抓包，
> 按上面三条补测试即可。

### `detect-only`（6）

`hermes`、`kimi`、`devin`、`kiro`、`kilo`、`vibe` —— ACP JSON-RPC over stdio，未实现。

## 已知覆盖缺口

- **Windows 进程销毁路径（`taskkill /T`）无测试覆盖**。生命周期测试用
  `#!/bin/sh` 假 agent，Windows 上不可执行，因此在 CI 中被 skip。
  要补需要一份 `.cmd` 版本的假 agent。**这是缺口，不是"已通过"。**
- `experimental` 档中仅 `bob` 有 parse 测试，其余靠人工。

## 模型列表策略

`AgentDef.fallbackModels` 是 **picker 的便利列表，不是白名单**——
`InvokeOpts.model` 原样透传给 CLI，列表里没有的模型照样能用。

因此只收录**不会过期**的条目：

- ✅ 稳定别名：`sonnet`、`opus`、`haiku`、`auto`
- ✅ 无小版本号的 id：`gpt-5`、`gpt-5-codex`、`o3`
- ❌ 钉死小版本：`gpt-5.4-mini`、`claude-opus-4-7`、`sonnet-4-thinking`
- ❌ detect-only agent 的列表：根本不能调用，维护它纯属浪费

理由：过期列表比短列表更糟——它会在下拉框里渲染出 CLI 会直接拒绝的模型，
把库的错误伪装成用户的错误。上游节奏由厂商决定，本库不可能跟得上。

2026-09 一次性从 55 条收敛到 28 条。若某 agent 需要更全的列表，
应当去查它自己的 catalog（如 `pi --list-models`），而不是往这里堆。
