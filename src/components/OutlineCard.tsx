import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, FileText } from "lucide-react";

interface Chapter {
  id: number;
  title: string;
  outline: string;
  content: string;
}

interface Outline {
  id: number;
  title: string;
  summary: string;
  chapters: Chapter[];
  rawContent: string;
}

interface OutlineCardProps {
  outline: Outline;
  isGenerating: boolean;
  onSelect: (outline: Outline) => void;
  isSelected?: boolean;
}

export function OutlineCard({
  outline,
  isGenerating,
  onSelect,
  isSelected = false,
}: OutlineCardProps) {
  const chapterCount = outline.chapters?.length || 0;
  const hasContent = Boolean(outline.rawContent);
  const summary = outline.summary && outline.summary !== "正在生成中，请稍候..."
    ? outline.summary
    : "正在整理剧情脉络，请稍候...";

  const actionLabel = !hasContent
    ? "生成中..."
    : chapterCount > 0
      ? "选择此大纲并生成章节"
      : "基于该结果继续生成章节";

  const streamingPreview = outline.rawContent
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?\s*/gi, "")
    .replace(/\s*```$/g, "")
    .trim();

  return (
    <Card
      className={[
        "h-full border transition-all duration-200",
        isSelected ? "border-primary shadow-lg ring-2 ring-primary/20" : "hover:shadow-md",
        !isGenerating && hasContent ? "cursor-pointer" : "",
      ].join(" ")}
      onClick={() => {
        if (!isGenerating && hasContent) {
          onSelect(outline);
        }
      }}
    >
      <CardHeader className="space-y-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="line-clamp-2 text-xl leading-snug">{outline.title}</CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            {chapterCount > 0 && <Badge variant="secondary">{chapterCount} 章</Badge>}
            {isGenerating && hasContent && <Badge variant="outline">实时更新</Badge>}
          </div>
        </div>
        <CardDescription className="line-clamp-3 text-sm leading-relaxed">
          {hasContent ? summary : "正在生成大纲内容..."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!hasContent && (
          <div className="space-y-2 rounded-xl border bg-muted/40 p-4">
            <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        )}

        {hasContent && chapterCount > 0 && (
          <div className="rounded-xl border bg-muted/25 p-2">
            <ScrollArea className="h-72 pr-2">
              <div className="space-y-2 p-2">
                {outline.chapters.map((chapter) => (
                  <div key={chapter.id} className="rounded-lg bg-background px-3 py-2">
                    <p className="line-clamp-1 text-sm font-medium">{chapter.title}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{chapter.outline}</p>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {hasContent && chapterCount === 0 && (
          <div className="space-y-2">
            <Alert className="border-amber-300/70 bg-amber-50/70">
              <FileText className="h-4 w-4" />
              <AlertDescription>
                当前结果正在流式输出，内容会持续刷新。
              </AlertDescription>
            </Alert>
            <div className="rounded-xl border bg-muted/25 p-2">
              <ScrollArea className="h-72 pr-2">
                <pre className="whitespace-pre-wrap break-words p-2 text-xs leading-relaxed text-muted-foreground">
                  {streamingPreview || "正在生成中..."}
                </pre>
              </ScrollArea>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border bg-background/80 px-3 py-2 text-sm">
          <span className="text-muted-foreground">操作</span>
          <span className="inline-flex items-center gap-1 font-medium">
            <Sparkles className="h-4 w-4" />
            {actionLabel}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
