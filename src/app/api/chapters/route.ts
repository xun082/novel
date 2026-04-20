import { NextRequest } from "next/server";
import {
  buildChapterPrompts,
  callUpstreamStream,
  ChapterTaskInput,
  NO_CACHE_HEADERS,
} from "../_lib/rwkv";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

interface Payload {
  tasks: ChapterTaskInput[];
  maxTokens?: number;
}

function isValidTask(task: unknown): task is ChapterTaskInput {
  if (!task || typeof task !== "object") return false;
  const t = task as Partial<ChapterTaskInput>;
  return (
    !!t.novelContext &&
    typeof t.novelContext.title === "string" &&
    typeof t.novelContext.summary === "string" &&
    !!t.chapter &&
    typeof t.chapter.title === "string" &&
    typeof t.chapter.outline === "string" &&
    typeof t.chapterOrder === "number" &&
    typeof t.chapterTotal === "number"
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

  const tasks = Array.isArray(payload.tasks)
    ? payload.tasks.filter(isValidTask)
    : [];

  if (tasks.length === 0) {
    return new Response(
      JSON.stringify({ error: "tasks must be a non-empty array" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const prompts = buildChapterPrompts(tasks);

  return callUpstreamStream({
    contents: prompts,
    maxTokens: payload.maxTokens,
    batchSize: 10,
  });
}
