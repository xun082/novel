import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, FileText } from "lucide-react";
import { normalizeChapterContent } from "@/lib/novel-data";

interface Chapter {
  id: number;
  title: string;
  outline: string;
  content: string;
}

interface ChapterCardProps {
  chapter: Chapter;
  isGenerating: boolean;
}

export function ChapterCard({ chapter, isGenerating }: ChapterCardProps) {
  const [expanded, setExpanded] = useState(false);

  const content = useMemo(() => normalizeChapterContent(chapter.content), [chapter.content]);
  const isPendingText = chapter.content.includes("生成中...") || chapter.content.includes("扩写中...");
  const contentLength = content.length;
  const shouldCollapse = contentLength > 360 && !isPendingText;
  const preview = !expanded && shouldCollapse ? `${content.slice(0, 360)}...` : content;

  return (
    <Card className={isGenerating && content ? "border-primary/40" : "border-border"}>
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-3">
            <CardTitle className="text-lg leading-snug">{chapter.title}</CardTitle>
            <CardDescription className="rounded-lg border bg-muted/35 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                章节大纲
              </span>
              {chapter.outline || "暂无梗概"}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={isPendingText ? "secondary" : "default"}>
              {isPendingText ? "处理中" : `${contentLength} 字`}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {!content && (
          <div className="flex min-h-28 items-center justify-center rounded-xl border bg-muted/25 text-sm text-muted-foreground">
            <FileText className="mr-2 h-4 w-4" />
            等待生成内容...
          </div>
        )}

        {content && (
          <div className="space-y-3">
            <div
              className={[
                "rounded-xl border bg-background p-4",
                isPendingText ? "max-h-96 overflow-y-auto" : "",
              ].join(" ")}
            >
              <div className="whitespace-pre-wrap text-[15px] leading-8 text-foreground/95 [text-indent:2em]">
                {preview}
              </div>
            </div>

            {shouldCollapse && !isPendingText && (
              <div className="flex justify-center">
                <Button size="sm" variant="outline" onClick={() => setExpanded((prev) => !prev)}>
                  {expanded ? (
                    <>
                      <ChevronUp className="mr-1 h-4 w-4" />
                      收起内容
                    </>
                  ) : (
                    <>
                      <ChevronDown className="mr-1 h-4 w-4" />
                      展开全文
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
