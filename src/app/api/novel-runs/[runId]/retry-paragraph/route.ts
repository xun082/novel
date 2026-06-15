import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/novel/novel-store";
import { retryParagraph } from "@/lib/novel/novel-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

interface RetryBody {
  novelIndex?: unknown;
  chapterIndex?: unknown;
  paragraphIndex?: unknown;
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  const { runId } = await ctx.params;
  if (!getRun(runId)) {
    return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  }

  let body: RetryBody;
  try {
    body = (await req.json()) as RetryBody;
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  if (
    typeof body.novelIndex !== "number" ||
    typeof body.chapterIndex !== "number" ||
    typeof body.paragraphIndex !== "number"
  ) {
    return NextResponse.json(
      { error: "novelIndex/chapterIndex/paragraphIndex must be numbers" },
      { status: 400 },
    );
  }

  const result = await retryParagraph(
    runId,
    body.novelIndex,
    body.chapterIndex,
    body.paragraphIndex,
  );

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
