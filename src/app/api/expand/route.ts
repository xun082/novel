import { NextRequest } from "next/server";
import { NO_CACHE_HEADERS } from "@/lib/http/cache-headers";
import { normalizeExpandTasks } from "@/lib/rwkv/rwkv-payload";
import { buildExpandPrompts } from "@/lib/rwkv/rwkv-prompts";
import {
  callUpstreamStream,
  upstreamCredentialsFromPayload,
} from "@/lib/rwkv/rwkv-stream";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

interface Payload {
  chapters?: unknown;
}

export async function POST(req: NextRequest) {
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
    });
  }

  const chapters = normalizeExpandTasks(payload.chapters);

  if (chapters.length === 0) {
    return new Response(
      JSON.stringify({
        error: "chapters must be a non-empty array of paragraph expand tasks",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const prompts = buildExpandPrompts(chapters);

  return callUpstreamStream("expand", {
    contents: prompts,
    ...upstreamCredentialsFromPayload(payload as unknown as Record<string, unknown>),
  });
}
