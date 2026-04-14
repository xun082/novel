import { NextRequest } from "next/server";

const UPSTREAM = "http://154.37.222.49:8193/big_batch/completions";

export async function POST(req: NextRequest) {
  const body = await req.text();

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  // 调试开关：用于捕捉上游原始流式返回
  const shouldDebugStream =
    process.env.RWKV_DEBUG_STREAM === "1" ||
    process.env.NEXT_PUBLIC_RWKV_DEBUG_STREAM === "1";

  if (shouldDebugStream && upstream.body) {
    try {
      const [streamForClient, streamForDebug] = upstream.body.tee();
      const decoder = new TextDecoder();

      void (async () => {
        const reader = streamForDebug.getReader();
        let buffer = "";
        let loggedLines = 0;
        const maxLines = 60;

        try {
          while (loggedLines < maxLines) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              if (!trimmed.startsWith("data:") && !trimmed.startsWith("{")) {
                continue;
              }

              console.log(`[RWKV-UPSTREAM] ${trimmed.substring(0, 300)}`);
              loggedLines++;
              if (loggedLines >= maxLines) break;
            }
          }
        } catch (error) {
          console.error("[RWKV-UPSTREAM] 调试流读取失败:", error);
        } finally {
          reader.releaseLock();
        }
      })();

      return new Response(streamForClient, {
        status: upstream.status,
        headers: {
          "Content-Type":
            upstream.headers.get("Content-Type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (error) {
      console.error("[RWKV-UPSTREAM] tee失败，回退直通模式:", error);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
