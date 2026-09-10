/**
 * HTTP 传输层：把 InvokeEvent 流编码为 Server-Sent-Events (SSE) 字节流。
 *
 * 框架无关——返回 Web 标准的 `ReadableStream<Uint8Array>`，Next / Express /
 * Hono / Fastify 直接 `new Response(stream, { headers })` 即可。
 *
 * 事件编码：`event: <type>\ndata: <json>\n\n`
 * 生命周期：
 *   - 上游流内错误 → 发送 `error` 事件后关闭
 *   - 下游 cancel（客户端断开）→ 传播 cancel 到上游（invokeAgent 会杀掉子进程）
 *   - 传入 `signal` 且被 abort → cancel 上游并关闭输出
 */

import type { InvokeEvent } from "./invoke.js";

export function toSseStream(
  stream: ReadableStream<InvokeEvent>,
  opts: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let reader: ReadableStreamDefaultReader<InvokeEvent> | null = null;

  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // Cancel the upstream `invokeAgent` stream so it tears down the agent
      // process tree. Must work even before `getReader()` has run: cancelling
      // the stream itself is equivalent and avoids leaking the child on the
      // already-aborted path.
      const cancelUpstream = () => {
        const p = reader ? reader.cancel() : stream.cancel();
        p.catch(() => {
          /* upstream already finished */
        });
      };

      const onAbort = () => {
        cancelUpstream();
        close();
      };
      const detachAbort = () => {
        opts.signal?.removeEventListener("abort", onAbort);
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          // Pre-aborted: the child may already be spawning, so cancel upstream
          // rather than just closing our own output. Closing alone left the
          // agent running to completion — the same P0 leak `cancel()` fixes.
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          send(value.type, value);
        }
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Long-lived signals (a shared request-scoped controller) would
        // otherwise accumulate one listener per stream.
        detachAbort();
        close();
      }
    },
    cancel() {
      // 下游断开（客户端关闭连接 / Response 被取消）→ 杀掉子进程。
      // 与 cancelUpstream 同理：reader 可能尚未取到，此时直接取消上游流。
      (reader ? reader.cancel() : stream.cancel()).catch(() => {});
    },
  });
}
