"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import { ChapterCard } from "@/components/ChapterCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getServerPersistedOutlinesSnapshot,
  isChapterOutputComplete,
  subscribePersistedOutlines,
  type NovelOutline,
  readPersistedOutlines,
} from "@/lib/novel-data";

export default function OutlineDetailPage() {
  const params = useParams<{ outlineId: string }>();
  const outlineId = Number(params?.outlineId ?? NaN);

  const outlines = useSyncExternalStore(
    subscribePersistedOutlines,
    readPersistedOutlines,
    getServerPersistedOutlinesSnapshot,
  );

  const outline = useMemo<NovelOutline | null>(
    () => outlines.find((item) => item.id === outlineId) || null,
    [outlineId, outlines],
  );

  const totalChapters = outline?.chapters.length || 0;
  const completedChapters = useMemo(
    () => outline?.chapters.filter((chapter) => isChapterOutputComplete(chapter.content)).length || 0,
    [outline],
  );

  if (!outline) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_10%_20%,rgba(56,189,248,0.14),transparent_45%),radial-gradient(circle_at_90%_10%,rgba(236,72,153,0.12),transparent_45%),linear-gradient(180deg,#020617,#030712_48%,#0b1120)] px-4">
        <Card className="w-full max-w-2xl border-border/70 bg-card/80 backdrop-blur-sm">
          <CardHeader className="space-y-3">
            <CardTitle>未找到该大纲详情</CardTitle>
            <CardDescription>
              当前标签页没有拿到对应大纲数据，请回到主页重新生成或重新打开。
            </CardDescription>
            <Button asChild className="w-fit">
              <Link href="/">返回主页</Link>
            </Button>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[radial-gradient(circle_at_10%_20%,rgba(56,189,248,0.14),transparent_45%),radial-gradient(circle_at_90%_10%,rgba(236,72,153,0.12),transparent_45%),linear-gradient(180deg,#020617,#030712_48%,#0b1120)] pb-10">
      <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 pt-4">
        <Card className="border-border/70 bg-card/80 backdrop-blur-sm">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-2xl leading-relaxed">{outline.title || `大纲 ${outline.id}`}</CardTitle>
              <Badge variant="secondary">章节完成 {completedChapters}/{totalChapters}</Badge>
            </div>
            <CardDescription className="whitespace-pre-wrap leading-7 text-foreground/90">
              {outline.summary || "该大纲暂无总纲摘要。"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">章节大纲总览</p>
              <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {outline.chapters.map((chapter) => (
                  <div key={chapter.id} className="rounded-lg border border-border/70 bg-card/70 px-3 py-2">
                    <p className="text-sm font-semibold text-foreground">{chapter.title}</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                      {chapter.outline || "暂无章节大纲"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <section className="space-y-4">
          {outline.chapters.map((chapter) => (
            <ChapterCard key={chapter.id} chapter={chapter} isGenerating={false} />
          ))}
        </section>
      </main>
    </div>
  );
}
