import { NextRequest } from "next/server";
import {
  buildChapterPrompts,
  callUpstreamStream,
  ChapterPromptInput,
  NO_CACHE_HEADERS,
  upstreamCredentialsFromPayload,
} from "../_lib/rwkv";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

/**
 * 一次性高并发写章：每条 prompt 只含「本章标题 + 本章概括」，不含小说总纲或其他章节。
 *
 * {
 *   chapters: [ { title, outline }, ... ],
 * }
 */
interface Payload {
  chapters?: unknown;
}

function normalizeChapters(raw: unknown): ChapterPromptInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ChapterPromptInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Partial<ChapterPromptInput>;
    if (typeof c.title === "string" && typeof c.outline === "string") {
      out.push({ title: c.title, outline: c.outline });
    }
  }
  return out;
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
        error: "expect { chapters: [{ title, outline }, ...] }",
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
