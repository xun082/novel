import { NextRequest } from "next/server";
import {
  buildChapterPrompts,
  callUpstreamStream,
  NO_CACHE_HEADERS,
  ParagraphPromptInput,
  upstreamCredentialsFromPayload,
} from "../_lib/rwkv";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

interface Payload {
  chapters?: unknown;
}

function normalizeOutlineEntries(raw: unknown): ParagraphPromptInput["allChapterOutlines"] {
  if (!Array.isArray(raw)) return [];
  const out: ParagraphPromptInput["allChapterOutlines"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<ParagraphPromptInput["allChapterOutlines"][number]>;
    if (typeof entry.title === "string" && typeof entry.outline === "string") {
      out.push({ title: entry.title, outline: entry.outline });
    }
  }
  return out;
}

function normalizeChapters(raw: unknown): ParagraphPromptInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ParagraphPromptInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Partial<ParagraphPromptInput>;
    if (
      typeof c.chapterTitle !== "string" ||
      typeof c.paragraphOutline !== "string"
    ) {
      continue;
    }

    const allChapterOutlines = normalizeOutlineEntries(c.allChapterOutlines);
    const chapterNumber =
      typeof c.chapterNumber === "number" && c.chapterNumber > 0
        ? Math.floor(c.chapterNumber)
        : 1;
    const totalChapters =
      typeof c.totalChapters === "number" && c.totalChapters > 0
        ? Math.floor(c.totalChapters)
        : Math.max(allChapterOutlines.length, chapterNumber);
    const paragraphNumber =
      typeof c.paragraphNumber === "number" && c.paragraphNumber > 0
        ? Math.floor(c.paragraphNumber)
        : 1;
    const totalParagraphs =
      typeof c.totalParagraphs === "number" && c.totalParagraphs > 0
        ? Math.floor(c.totalParagraphs)
        : paragraphNumber;

    out.push({
      novelTitle: typeof c.novelTitle === "string" ? c.novelTitle : "",
      novelSummary: typeof c.novelSummary === "string" ? c.novelSummary : "",
      worldbuildingText:
        typeof c.worldbuildingText === "string" ? c.worldbuildingText : "",
      chapterTitle: c.chapterTitle,
      chapterOutline: typeof c.chapterOutline === "string" ? c.chapterOutline : "",
      chapterNumber,
      totalChapters,
      paragraphNumber,
      totalParagraphs,
      paragraphOutline: c.paragraphOutline,
      allChapterOutlines,
      previousParagraphContent:
        typeof c.previousParagraphContent === "string" &&
        c.previousParagraphContent.trim()
          ? c.previousParagraphContent
          : undefined,
      previousChapterContent:
        typeof c.previousChapterContent === "string" &&
        c.previousChapterContent.trim()
          ? c.previousChapterContent
          : undefined,
    });
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
