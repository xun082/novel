import { NextRequest } from "next/server";
import { NO_CACHE_HEADERS } from "@/lib/http/cache-headers";
import { getRun, NovelEvent, subscribe } from "@/lib/novel/novel-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

const SSE_HEADERS = {
  ...NO_CACHE_HEADERS,
  "Content-Type": "text/event-stream; charset=utf-8",
} as const;

function formatSse(event: NovelEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { runId } = await ctx.params;
  const run = getRun(runId);
  if (!run) {
    return new Response(JSON.stringify({ error: "run_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };

      // 推送目前已有的事件历史（不含 llm.chunk，store 已过滤）
      for (const e of run.events) safeEnqueue(formatSse(e));
      // 推送一份当前 run 快照，方便订阅者立即重建 UI 状态
      safeEnqueue(
        formatSse({
          type: "run.snapshot",
          runId: run.runId,
          payload: {
            status: run.status,
            stage: run.stage,
            input: run.input,
            novels: run.novels,
          },
          ts: Date.now(),
        }),
      );

      const unsubscribe = subscribe(run.runId, (event) => {
        safeEnqueue(formatSse(event));
        if (event.type === "run.completed" || event.type === "run.failed") {
          // 让客户端有机会收到最终事件，再关闭
          setTimeout(() => {
            unsubscribe();
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // ignore
              }
            }
          }, 50);
        }
      });

      // 心跳，避免代理层断开闲置连接
      const heartbeat = setInterval(() => {
        if (closed) return;
        safeEnqueue(`: keepalive ${Date.now()}\n\n`);
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // ignore
          }
        }
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
