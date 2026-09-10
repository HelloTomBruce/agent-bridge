#!/usr/bin/env node
/**
 * agent-bridge playground —— 零依赖本地服务，把桥接层暴露给浏览器。
 *
 *   node examples/server.mjs        # 然后打开 http://localhost:8787
 *
 * 端点：
 *   GET  /              → playground.html
 *   GET  /api/agents    → detectAgents()（含 tier 分档）
 *   POST /api/run       → SSE 事件流（invokeAgent + toSseStream）
 *   POST /api/stop      → 按 runId 中止某次运行
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectAgents, invokeAgent } from "../dist/index.js";
import { toSseStream } from "../dist/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

/** runId → AbortController，供 /api/stop 用。 */
const runs = new Map();

const json = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

async function readBody(req) {
  let raw = "";
  req.setEncoding("utf8");
  for await (const c of req) raw += c;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(join(here, "playground.html")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agents") {
    json(res, 200, detectAgents());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const body = await readBody(req);
    const ctl = body?.runId ? runs.get(body.runId) : null;
    if (!ctl) return json(res, 404, { ok: false, reason: "no such run" });
    ctl.abort();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    const body = await readBody(req);
    if (!body?.agent || !body?.prompt?.trim()) return json(res, 400, { error: "need agent + prompt" });

    const runId = String(body.runId ?? Math.random().toString(36).slice(2));
    const ctl = new AbortController();
    runs.set(runId, ctl);

    // 客户端断开（关标签页 / 网络断）→ abort → agent 进程组被杀。
    // 这正是 0.1.x 的 P0 泄漏点：那时 cancel() 是空实现，agent 会一直跑下去。
    res.on("close", () => ctl.abort());

    const stream = invokeAgent({
      agent: body.agent,
      prompt: body.prompt,
      model: body.model || undefined,
      cwd: body.cwd || undefined,
      timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined,
      signal: ctl.signal,
    });

    // 注意：signal 只给 invokeAgent，不给 toSseStream。
    // toSseStream 收到 abort 会立刻关闭输出流，那样 invokeAgent 发出的
    // end{status:"aborted"} 就被丢掉了，浏览器永远看不到终态事件。
    // 让 invokeAgent 自己走完 → 发 end → 流自然结束 → SSE 完整转发。
    const sse = toSseStream(stream);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const reader = sse.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      /* 客户端断开 */
    } finally {
      runs.delete(runId);
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  const agents = detectAgents().filter((a) => a.available);
  console.log(`\n  agent-bridge playground  →  http://localhost:${PORT}\n`);
  console.log(`  本机可用 agent: ${agents.map((a) => `${a.id}[${a.tier}]`).join(", ") || "(无)"}`);
  console.log(`  Ctrl+C 退出\n`);
});
