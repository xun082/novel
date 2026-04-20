import { NextRequest } from "next/server";
import {
  buildOutlinePrompts,
  callUpstreamStream,
  NO_CACHE_HEADERS,
} from "../_lib/rwkv";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

interface Payload {
  genre: string;
  chapters?: number;
  count?: number;
  maxTokens?: number;
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

  const genre = (payload.genre || "").trim();
  const chapters = Math.max(1, Math.floor(payload.chapters ?? 15));
  const count = Math.max(1, Math.floor(payload.count ?? 10));

  if (!genre) {
    return new Response(JSON.stringify({ error: "genre is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
    });
  }

  const prompts = buildOutlinePrompts(genre, chapters, count);

  return callUpstreamStream({
    contents: prompts,
    maxTokens: payload.maxTokens,
  });
}
