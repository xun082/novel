import { NextRequest, NextResponse } from "next/server";
import { createRun, NovelRunInput } from "@/lib/novel/novel-store";
import { runNovelWorkflow } from "@/lib/novel/novel-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawBody {
  userIdea?: unknown;
  novelCount?: unknown;
  chapterCount?: unknown;
  paragraphCount?: unknown;
  batchSize?: unknown;
  stylePreference?: unknown;
  genrePreference?: unknown;
  decodeConfig?: unknown;
}

function asInt(v: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof v === "number"
      ? Math.floor(v)
      : typeof v === "string"
        ? Number.parseInt(v, 10)
        : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  if (typeof body.userIdea !== "string" || body.userIdea.trim() === "") {
    return NextResponse.json({ error: "userIdea_required" }, { status: 400 });
  }

  const input: NovelRunInput = {
    userIdea: body.userIdea,
    novelCount: asInt(body.novelCount, 1, 32, 2),
    chapterCount: asInt(body.chapterCount, 1, 64, 3),
    paragraphCount: asInt(body.paragraphCount, 1, 64, 4),
    batchSize: asInt(body.batchSize, 1, 120, 8),
    stylePreference:
      typeof body.stylePreference === "string"
        ? body.stylePreference
        : undefined,
    genrePreference:
      typeof body.genrePreference === "string"
        ? body.genrePreference
        : undefined,
    decodeConfig:
      body.decodeConfig && typeof body.decodeConfig === "object"
        ? (body.decodeConfig as NovelRunInput["decodeConfig"])
        : undefined,
  };

  const run = createRun(input);

  // 后台异步执行；不阻塞 HTTP 响应。
  void runNovelWorkflow(run.runId).catch((err) => {
    console.error("[novel-workflow] failed", run.runId, err);
  });

  return NextResponse.json({ runId: run.runId });
}
