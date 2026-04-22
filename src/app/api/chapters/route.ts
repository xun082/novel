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

/**
 * 一次性高并发 payload：把所有大纲 + 所有章节一起塞进 1 个请求。
 * 每份大纲的 summary 只出现一次（不会按章节数重复）。
 * 服务端把它展开成扁平 prompts，交给上游 /big_batch 在一个请求内并行执行。
 *
 * {
 *   outlines: [
 *     { title, summary, chapters: [ { title, outline }, ... ] },
 *     ...
 *   ],
 *   maxTokens?: number
 * }
 */
interface GroupedOutline {
  title: string;
  summary: string;
  chapters: Array<{ title: string; outline: string }>;
}

interface Payload {
  outlines?: unknown;
  maxTokens?: number;
}

function normalizeOutlines(raw: unknown): GroupedOutline[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupedOutline[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<GroupedOutline>;
    if (typeof o.title !== "string" || typeof o.summary !== "string") continue;
    if (!Array.isArray(o.chapters)) continue;
    const chapters: GroupedOutline["chapters"] = [];
    for (const c of o.chapters) {
      if (!c || typeof c !== "object") continue;
      const ch = c as Partial<GroupedOutline["chapters"][number]>;
      if (typeof ch.title === "string" && typeof ch.outline === "string") {
        chapters.push({ title: ch.title, outline: ch.outline });
      }
    }
    if (chapters.length > 0) {
      out.push({ title: o.title, summary: o.summary, chapters });
    }
  }
  return out;
}

function flattenTasks(outlines: GroupedOutline[]): ChapterTaskInput[] {
  const tasks: ChapterTaskInput[] = [];
  for (const outline of outlines) {
    const novelContext = { title: outline.title, summary: outline.summary };
    for (const chapter of outline.chapters) {
      tasks.push({ novelContext, chapter });
    }
  }
  return tasks;
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

  const outlines = normalizeOutlines(payload.outlines);
  const tasks = flattenTasks(outlines);

  if (tasks.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          "expect { outlines: [{ title, summary, chapters: [{ title, outline }] }] }",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const prompts = buildChapterPrompts(tasks);

  // N × maxTokens 会受 rwkv.ts 里 TOTAL_TOKEN_BUDGET (150k) 约束，
  // resolveMaxTokens 会按 tasks 数量自动把每条 max_tokens 压到可行区间。
  return callUpstreamStream({
    contents: prompts,
    maxTokens: payload.maxTokens ?? 1000,
  });
}
