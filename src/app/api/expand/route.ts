import { NextRequest } from "next/server";
import {
  buildExpandPrompts,
  callUpstreamStream,
  ExpandTaskInput,
  NO_CACHE_HEADERS,
} from "../_lib/rwkv";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

interface Payload {
  chapters: ExpandTaskInput[];
  maxTokens?: number;
}

function isValidChapter(value: unknown): value is ExpandTaskInput {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<ExpandTaskInput>;
  return (
    typeof t.title === "string" &&
    typeof t.outline === "string" &&
    typeof t.currentContent === "string"
  );
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

  const chapters = Array.isArray(payload.chapters)
    ? payload.chapters.filter(isValidChapter)
    : [];

  if (chapters.length === 0) {
    return new Response(
      JSON.stringify({ error: "chapters must be a non-empty array" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const prompts = buildExpandPrompts(chapters);

  // 扩写后每章目标 1200-1500 字 ≈ 1500 token；
  // 150 × 1500 = 225k 会被上游拒为空 body，所以默认取 1000，
  // TOTAL_TOKEN_BUDGET 还会兜底按比例下调。
  return callUpstreamStream({
    contents: prompts,
    maxTokens: payload.maxTokens ?? 1000,
  });
}
