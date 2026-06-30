import { NextRequest } from "next/server";
import { NO_CACHE_HEADERS } from "@/lib/http/cache-headers";
import { normalizeChapters } from "@/lib/rwkv/rwkv-payload";
import { buildChapterPrompts } from "@/lib/rwkv/rwkv-prompts";
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

  const chapters = normalizeChapters(payload.chapters);

  if (chapters.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          "expect { chapters: [ParagraphPromptInput, ...] } for paragraph draft generation",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const prompts = buildChapterPrompts(chapters);

  return callUpstreamStream("chapters", {
    contents: prompts,
    ...upstreamCredentialsFromPayload(payload as unknown as Record<string, unknown>),
  });
}
