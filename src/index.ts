/**
 * agent-bridge — 本地 coding-agent CLI 的统一桥接层。
 *
 * 三个正交能力，可独立使用：
 *   - detect  : 扫描本机已安装的 agent CLI（PATH + 常用工具链目录 + 环境变量覆盖）
 *   - invoke  : 以统一事件流（ReadableStream<InvokeEvent>）调用任意已注册 agent
 *   - parse   : 按 agent 协议解析 stdout（stream-json / ndjson / 纯文本）
 *
 * 零 API key：复用本机已登录 CLI 会话（claude login、cursor login、gemini auth …）。
 * 协议抽象：stdin / argv / argv-message / acp（acp 家族仅检测、未实现调用）。
 */

export type {
  AgentProtocol,
  AgentTier,
  ModelOption,
  AgentDef,
  DetectedAgent,
} from "./detect.js";
export {
  AGENTS,
  DEFAULT_MODEL,
  userToolchainDirs,
  resolveOnPath,
  resolveOpenclawAgentId,
  detectAgents,
} from "./detect.js";

export type { AgentArgvOpts, AgentParse, ParseState } from "./argv.js";
export {
  buildArgv,
  envFor,
  makeParser,
  parseLine,
  extractTextFromLine,
  UnsupportedAgentProtocolError,
} from "./argv.js";

export type {
  InvokeOpts,
  InvokeEvent,
  InvokeEndStatus,
  InvokeErrorCode,
} from "./invoke.js";
export {
  invokeAgent,
  resolveBinForAgent,
  SIGKILL_GRACE_MS,
  MAX_STDOUT_BUFFER_BYTES,
} from "./invoke.js";
